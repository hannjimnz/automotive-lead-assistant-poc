import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient } from 'pg';
import type { Entities, Table, Repository, LeadSyncOutboxEntry } from './repository.js';

// A client belongs to one asynchronous transaction, never to the whole repository.
export class PostgresRepository implements Repository {
  private readonly context = new AsyncLocalStorage<PoolClient>();
  readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  private query(sql: string, values: unknown[] = []) {
    return (this.context.getStore() ?? this.pool).query(sql, values);
  }

  async verify() {
    await this.query('SELECT entity, id, body FROM chatbot.documents LIMIT 0');
    await this.query('SELECT opportunity_id FROM chatbot.lead_sync_outbox LIMIT 0');
  }

  async importDocument(entity: string, id: string, body: string) {
    const result = await this.query(`INSERT INTO chatbot.documents AS old (entity,id,body)
      VALUES ($1,$2,$3::jsonb) ON CONFLICT (entity,id) DO UPDATE SET body=old.body
      WHERE old.body=EXCLUDED.body RETURNING id`, [entity,id,body]);
    if (result.rowCount !== 1) throw new Error('IMPORT_DOCUMENT_CONFLICT');
  }

  async importOutbox(row: Record<string, unknown>) {
    const result = await this.query(`INSERT INTO chatbot.lead_sync_outbox AS old
      (opportunity_id,version,snapshot,snapshot_hash,attempts,status,next_attempt_at,last_error_code,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (opportunity_id) DO UPDATE SET opportunity_id=old.opportunity_id
      WHERE (to_jsonb(old) - 'opportunity_id') = (to_jsonb(EXCLUDED) - 'opportunity_id')
      RETURNING opportunity_id`, [row.opportunity_id,row.version,row.snapshot,row.snapshot_hash,row.attempts,
      row.status === 'sending' ? 'pending' : row.status,row.next_attempt_at,row.last_error_code,row.updated_at]);
    if (result.rowCount !== 1) throw new Error('IMPORT_OUTBOX_CONFLICT');
  }

  async get<K extends Table>(table: K, id: string): Promise<Entities[K] | undefined> {
    const result = await this.query('SELECT body FROM chatbot.documents WHERE entity=$1 AND id=$2', [table, id]);
    return result.rows[0]?.body;
  }

  async all<K extends Table>(table: K): Promise<Entities[K][]> {
    const result = await this.query('SELECT body FROM chatbot.documents WHERE entity=$1 ORDER BY position', [table]);
    return result.rows.map(row => row.body);
  }

  async put<K extends Table>(table: K, item: Entities[K]): Promise<void> {
    await this.query(`INSERT INTO chatbot.documents (entity,id,body) VALUES ($1,$2,$3::jsonb)
      ON CONFLICT (entity,id) DO UPDATE SET body=EXCLUDED.body`, [table, item.id, JSON.stringify(item)]);
  }

  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return operation();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Existing business operations read multiple documents before updating them.
      // Serialize short writes across instances to retain SQLite's single-writer semantics.
      await client.query("SELECT pg_advisory_xact_lock(724193810)");
      const result = await this.context.run(client, operation);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async queueLeadSync(id: string, snapshot: string, hash: string, now: string): Promise<number> {
    const result = await this.query(`INSERT INTO chatbot.lead_sync_outbox AS old
      (opportunity_id,version,snapshot,snapshot_hash,attempts,status,next_attempt_at,updated_at)
      VALUES ($1,1,$2,$3,0,'pending',$4,$4)
      ON CONFLICT (opportunity_id) DO UPDATE SET
        version=old.version+1, snapshot=EXCLUDED.snapshot, snapshot_hash=EXCLUDED.snapshot_hash,
        attempts=0,status='pending',next_attempt_at=EXCLUDED.next_attempt_at,
        last_error_code=NULL,updated_at=EXCLUDED.updated_at
      WHERE old.snapshot_hash <> EXCLUDED.snapshot_hash
      RETURNING version`, [id,snapshot,hash,now]);
    if (result.rows[0]) return Number(result.rows[0].version);
    const current = await this.query('SELECT version FROM chatbot.lead_sync_outbox WHERE opportunity_id=$1', [id]);
    return Number(current.rows[0].version);
  }

  async claimLeadSync(now: string): Promise<LeadSyncOutboxEntry | undefined> {
    const result = await this.query(`UPDATE chatbot.lead_sync_outbox SET status='sending',updated_at=$1
      WHERE opportunity_id=(SELECT opportunity_id FROM chatbot.lead_sync_outbox
        WHERE (status='pending' AND next_attempt_at <= $1)
          OR (status='sending' AND updated_at::timestamptz < $1::timestamptz - interval '1 minute')
        ORDER BY next_attempt_at,updated_at
        LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, [now]);
    return result.rows[0] ? mapOutbox(result.rows[0]) : undefined;
  }

  async markLeadSyncSucceeded(id: string, version: number, now: string) {
    await this.query(`UPDATE chatbot.lead_sync_outbox SET status='synced',attempts=0,last_error_code=NULL,updated_at=$3
      WHERE opportunity_id=$1 AND version=$2 AND status='sending'`, [id,version,now]);
  }

  async markLeadSyncFailed(id: string, version: number, now: string, next: string, code: string, terminal: boolean) {
    const result = await this.query(`UPDATE chatbot.lead_sync_outbox
      SET attempts=attempts+1,status=$3,next_attempt_at=$4,last_error_code=$5,updated_at=$6
      WHERE opportunity_id=$1 AND version=$2 AND status='sending' RETURNING attempts`,
    [id,version,terminal?'dead':'pending',next,code,now]);
    return result.rows[0]?.attempts as number | undefined;
  }

  async recoverLeadSyncOutbox(now: string) {
    // Do not steal a live worker's claim when another API process starts.
    await this.query(`UPDATE chatbot.lead_sync_outbox SET status='pending',next_attempt_at=$1,updated_at=$1
      WHERE status='sending' AND updated_at::timestamptz < $1::timestamptz - interval '1 minute'`, [now]);
  }

  async leadSyncOutbox() {
    const result = await this.query('SELECT * FROM chatbot.lead_sync_outbox ORDER BY opportunity_id');
    return result.rows.map(mapOutbox);
  }

  async leadSyncCounts() {
    const result = await this.query(`SELECT
      count(*) FILTER (WHERE status IN ('pending','sending'))::integer AS pending,
      count(*) FILTER (WHERE status='dead')::integer AS dead FROM chatbot.lead_sync_outbox`);
    return result.rows[0] as { pending: number; dead: number };
  }

  async close() { await this.pool.end(); }
}

function mapOutbox(row: Record<string, unknown>): LeadSyncOutboxEntry {
  return {
    opportunityId: String(row.opportunity_id), version: Number(row.version), snapshot: String(row.snapshot),
    snapshotHash: String(row.snapshot_hash), attempts: Number(row.attempts),
    status: row.status as LeadSyncOutboxEntry['status'], nextAttemptAt: String(row.next_attempt_at),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
  };
}

export function createPostgresRepository(connectionString = process.env.DATABASE_URL): PostgresRepository {
  if (!connectionString?.trim()) throw new Error('Configura DATABASE_URL con la conexión PostgreSQL de Supabase.');
  const url = new URL(connectionString);
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  // URL SSL options must not override certificate verification in pg.
  for (const key of ['sslmode','sslcert','sslkey','sslrootcert']) url.searchParams.delete(key);
  const pool = new Pool({ connectionString: url.toString(), max: 5,
    connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 15000,
    ssl: local ? false : { rejectUnauthorized: true },
  });
  pool.on('error', () => console.error('Conexión PostgreSQL interrumpida', { category: 'DATABASE_CONNECTION_ERROR' }));
  return new PostgresRepository(pool);
}
