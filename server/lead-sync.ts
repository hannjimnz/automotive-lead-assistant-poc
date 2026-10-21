import { Pool } from "pg";

import type { Repository, LeadSyncOutboxEntry } from "./repository.js";
import type { LeadSyncSnapshot } from "./lead-sync-model.js";

export const leadSyncMaxAttempts = 8;
const retryBaseMs = 1_000;
const retryMaxMs = 5 * 60_000;
const pollIntervalMs = 1_000;

export class LeadSyncConflictError extends Error {
  readonly code: string;

  constructor(code: "REMOTE_VERSION_AHEAD" | "VERSION_HASH_CONFLICT") {
    super(code);
    this.code = code;
  }
}

export interface LeadSyncWriter {
  synchronize(entry: LeadSyncOutboxEntry): Promise<void>;
  close(): Promise<void>;
}

export class PostgresLeadSyncWriter implements LeadSyncWriter {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async synchronize(entry: LeadSyncOutboxEntry): Promise<void> {
    const snapshot = JSON.parse(entry.snapshot) as LeadSyncSnapshot;
    const client = await this.pool.connect();
    let transactionOpen = false;

    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`${snapshot.systemOrigin}:${snapshot.externalId}`],
      );
      await client.query(`
        INSERT INTO public.leads (sistema_origen, id_externo)
        VALUES ($1, $2)
        ON CONFLICT (sistema_origen, id_externo) DO NOTHING
      `, [snapshot.systemOrigin, snapshot.externalId]);

      const leadResult = await client.query<{ id: string }>(`
        SELECT id FROM public.leads
        WHERE sistema_origen = $1 AND id_externo = $2
        FOR UPDATE
      `, [snapshot.systemOrigin, snapshot.externalId]);
      const leadId = leadResult.rows[0]?.id;
      if (!leadId) throw new Error("LEAD_SYNC_ANCHOR_MISSING");

      const profileResult = await client.query<{ version_actualizacion: string; snapshot_hash: string }>(`
        SELECT version_actualizacion, snapshot_hash
        FROM public.lead_perfil_chatbot
        WHERE lead_id = $1
        FOR UPDATE
      `, [leadId]);
      const remoteVersion = profileResult.rows[0]
        ? Number(profileResult.rows[0].version_actualizacion)
        : undefined;
      const remoteHash = profileResult.rows[0]?.snapshot_hash;

      if (remoteVersion !== undefined && remoteVersion > entry.version) {
        throw new LeadSyncConflictError("REMOTE_VERSION_AHEAD");
      }
      if (remoteVersion === entry.version) {
        if (remoteHash !== entry.snapshotHash) throw new LeadSyncConflictError("VERSION_HASH_CONFLICT");
        await client.query("COMMIT");
        transactionOpen = false;
        return;
      }

      const { contact, profile } = snapshot;
      await client.query(`
        UPDATE public.leads
        SET nombre = $2,
            telefono = $3,
            email = $4,
            vehiculo_interes = $5
        WHERE id = $1
      `, [leadId, contact.name, contact.phone, contact.email, contact.vehicleInterest]);

      await client.query(`
        INSERT INTO public.lead_perfil_chatbot (
          lead_id, temporalidad, intencion, capacidad_declarada, presupuesto,
          forma_pago, enganche, vehiculo_a_cuenta, marca_vehiculo_a_cuenta,
          modelo_vehiculo_a_cuenta, anio_vehiculo_a_cuenta, sucursal,
          accion_solicitada, dudas, siguiente_paso_sistema,
          estados_recopilacion, version_actualizacion, snapshot_hash, actualizado_en
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16::jsonb, $17, $18, now()
        )
        ON CONFLICT (lead_id) DO UPDATE SET
          temporalidad = EXCLUDED.temporalidad,
          intencion = EXCLUDED.intencion,
          capacidad_declarada = EXCLUDED.capacidad_declarada,
          presupuesto = EXCLUDED.presupuesto,
          forma_pago = EXCLUDED.forma_pago,
          enganche = EXCLUDED.enganche,
          vehiculo_a_cuenta = EXCLUDED.vehiculo_a_cuenta,
          marca_vehiculo_a_cuenta = EXCLUDED.marca_vehiculo_a_cuenta,
          modelo_vehiculo_a_cuenta = EXCLUDED.modelo_vehiculo_a_cuenta,
          anio_vehiculo_a_cuenta = EXCLUDED.anio_vehiculo_a_cuenta,
          sucursal = EXCLUDED.sucursal,
          accion_solicitada = EXCLUDED.accion_solicitada,
          dudas = EXCLUDED.dudas,
          siguiente_paso_sistema = EXCLUDED.siguiente_paso_sistema,
          estados_recopilacion = EXCLUDED.estados_recopilacion,
          version_actualizacion = EXCLUDED.version_actualizacion,
          snapshot_hash = EXCLUDED.snapshot_hash,
          actualizado_en = now()
        WHERE public.lead_perfil_chatbot.version_actualizacion < EXCLUDED.version_actualizacion
      `, [
        leadId,
        profile.timeframe,
        profile.intention,
        profile.declaredCapacity,
        profile.budget,
        profile.paymentMethod,
        profile.downPayment,
        profile.tradeIn,
        profile.tradeInBrand,
        profile.tradeInModel,
        profile.tradeInYear,
        profile.branch,
        profile.requestedAction,
        profile.questions,
        profile.nextStep,
        JSON.stringify(snapshot.collectionStates),
        entry.version,
        entry.snapshotHash,
      ]);

      await client.query("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Keep the original database error for safe classification.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class LeadSyncWorker {
  private timer: NodeJS.Timeout | undefined;
  private activeTick: Promise<void> | undefined;
  private readonly repo: Repository;
  private readonly writer: LeadSyncWriter;
  private readonly now: () => Date;

  constructor(
    repo: Repository,
    writer: LeadSyncWriter,
    now: () => Date = () => new Date(),
  ) {
    this.repo = repo;
    this.writer = writer;
    this.now = now;
  }

  start(): void {
    if (this.timer) return;
    const run = () => void this.tick().catch(() => {
      console.error('No se pudo consultar la cola de sincronización', { category: 'LEAD_SYNC_DATABASE_ERROR' });
    });
    run();
    this.timer = setInterval(run, pollIntervalMs);
    this.timer.unref();
  }

  tick(): Promise<void> {
    if (this.activeTick) return this.activeTick;
    this.activeTick = this.runOnce().finally(() => {
      this.activeTick = undefined;
    });
    return this.activeTick;
  }

  private async runOnce(): Promise<void> {
    const entry = (await this.repo.claimLeadSync(this.now().toISOString()));
    if (!entry) return;

    try {
      await this.writer.synchronize(entry);
      (await this.repo.markLeadSyncSucceeded(entry.opportunityId, entry.version, this.now().toISOString()));
    } catch (error) {
      const errorCode = classifyLeadSyncError(error);
      const terminal = error instanceof LeadSyncConflictError || isPermanentPostgresError(errorCode);
      const nextAttempt = new Date(this.now().getTime() + retryDelayMs(entry.attempts + 1)).toISOString();
      const attempts = (await this.repo.markLeadSyncFailed(
        entry.opportunityId,
        entry.version,
        this.now().toISOString(),
        nextAttempt,
        errorCode,
        terminal || entry.attempts + 1 >= leadSyncMaxAttempts,
      ));
      if (attempts !== undefined) {
        console.warn("Sincronización de prospecto pendiente", {
          category: terminal ? "LEAD_SYNC_CONFLICT" : "LEAD_SYNC_RETRY",
          code: errorCode,
          attempt: attempts,
          terminal: terminal || attempts >= leadSyncMaxAttempts,
        });
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeTick;
    await this.writer.close();
  }
}

export async function createLeadSyncWorker(
  repo: Repository,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LeadSyncWorker | undefined> {
  (await repo.recoverLeadSyncOutbox(new Date().toISOString()));
  if (environment.LEAD_SYNC_ENABLED !== "true") return undefined;

  const connectionString = environment.LEAD_SYNC_DATABASE_URL?.trim();
  if (!connectionString) {
    console.error("Sincronización de prospectos deshabilitada", { category: "LEAD_SYNC_CONFIG_MISSING" });
    return undefined;
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
    ssl: { rejectUnauthorized: true },
  });
  const worker = new LeadSyncWorker(repo, new PostgresLeadSyncWriter(pool));
  worker.start();
  return worker;
}

export function retryDelayMs(attempt: number): number {
  return Math.min(retryBaseMs * 2 ** Math.max(0, attempt - 1), retryMaxMs);
}

export function classifyLeadSyncError(error: unknown): string {
  if (error instanceof LeadSyncConflictError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,32}$/.test(code)) return code;
  return "REMOTE_UNAVAILABLE";
}

function isPermanentPostgresError(code: string): boolean {
  return code === "42501" || code.startsWith("22") || code.startsWith("23") || code.startsWith("28");
}
