import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";

import type { AgentOutput, ChatAgent } from "./agent.js";
import {
  buildLeadSyncSnapshot,
  enqueueLeadSyncSnapshot,
  hashLeadSyncSnapshot,
} from "./lead-sync-model.js";
import {
  LeadSyncConflictError,
  LeadSyncWorker,
  PostgresLeadSyncWriter,
  createLeadSyncWorker,
  retryDelayMs,
  type LeadSyncWriter,
} from "./lead-sync.js";
import { SqliteRepository, type LeadSyncOutboxEntry } from "./repository.js";
import { CRMService } from "./service.js";

class EmptyAgent implements ChatAgent {
  configured = true;

  async respond(): Promise<AgentOutput> {
    return { message: "ok", updates: [] };
  }
}

const baseTime = new Date("2026-01-01T00:00:00.000Z");

async function setup() {
  const repo = new SqliteRepository(":memory:");
  const service = new CRMService(repo, new EmptyAgent());
  const detail = (await service.createConversation());
  return { repo, service, detail };
}

test("snapshot conserva false, cero y estados distintos, omite scoring e interfaz", async () => {
  const { repo, service, detail } = (await setup());
  try {
    (await repo.transaction(async () => {
      const opportunity = (await repo.get("opportunities", detail.opportunity.id))!;
      opportunity.answers = {
        timeframe: "31-90",
        capacity: "unavailable",
        budget: 0,
        tradeIn: false,
      };
      opportunity.collection = {
        timeframe: "answered",
        intention: "unknown",
        capacity: "declined",
        budget: "answered",
        tradeIn: "answered",
        payment: "not_applicable",
      };
      opportunity.nextAction = "Etiqueta visible que no debe salir";
      (await repo.put("opportunities", opportunity));
    }));
    const snapshot = buildLeadSyncSnapshot((await service.detail(detail.opportunity.id)));
    assert.equal(snapshot.profile.timeframe, "31-90");
    assert.equal(snapshot.profile.budget, 0);
    assert.equal(snapshot.profile.tradeIn, false);
    assert.equal(snapshot.collectionStates.intention, "unknown");
    assert.equal(snapshot.collectionStates.capacity, "declined");
    assert.equal(snapshot.collectionStates.payment, "not_applicable");
    assert.equal(snapshot.profile.nextStep, "collect_name");
    assert.equal("score" in snapshot, false);
    assert.equal("grade" in snapshot, false);
    assert.equal("tradeInDetails" in snapshot.profile, false);
    assert.equal("nextAction" in snapshot.profile, false);
    assert.equal(hashLeadSyncSnapshot(snapshot), hashLeadSyncSnapshot(snapshot));
  } finally {
    (await repo.close());
  }
});

test("outbox es atómico, idempotente por hash, versionado y recuperable", async () => {
  const { repo, service, detail } = (await setup());
  try {
    const initial = (await repo.leadSyncOutbox())[0]!;
    assert.equal(initial.version, 1);
    assert.equal(initial.status, "pending");
    const sameVersion = (await enqueueLeadSyncSnapshot(repo, (await service.detail(detail.opportunity.id)), baseTime.toISOString()));
    assert.equal(sameVersion, 1);

    const changedDetail = (await service.detail(detail.opportunity.id));
    changedDetail.customer.name = "Nombre de prueba";
    (await repo.transaction(async () => {
      (await repo.put("customers", changedDetail.customer));
      const { opportunity } = changedDetail;
      opportunity.collection = { ...opportunity.collection, name: "answered" };
      (await repo.put("opportunities", opportunity));
      (await enqueueLeadSyncSnapshot(repo, (await service.detail(detail.opportunity.id)), baseTime.toISOString()));
    }));
    assert.equal((await repo.leadSyncOutbox())[0]?.version, 2);

    const claimed = (await repo.claimLeadSync(baseTime.toISOString()))!;
    assert.equal(claimed.status, "sending");
    (await repo.recoverLeadSyncOutbox(baseTime.toISOString()));
    assert.equal((await repo.leadSyncOutbox())[0]?.status, "pending");
    assert.equal((await repo.claimLeadSync(baseTime.toISOString()))?.version, 2);
  } finally {
    (await repo.close());
  }
});

test("rollback local revierte oportunidad y outbox; reintentos son acotados", async () => {
  const { repo, service, detail } = (await setup());
  try {
    await assert.rejects(async () => (await repo.transaction(async () => {
      const opportunity = (await repo.get("opportunities", detail.opportunity.id))!;
      opportunity.answers.budget = 0;
      (await repo.put("opportunities", opportunity));
      (await enqueueLeadSyncSnapshot(repo, (await service.detail(detail.opportunity.id)), baseTime.toISOString()));
      throw new Error("rollback fixture");
    })));
    assert.equal((await repo.get("opportunities", detail.opportunity.id))?.answers.budget, undefined);
    assert.equal((await repo.leadSyncOutbox())[0]?.version, 1);
    assert.deepEqual([1, 2, 3, 20].map(retryDelayMs), [1_000, 2_000, 4_000, 300_000]);
  } finally {
    (await repo.close());
  }
});

test("sin configuración no abre worker remoto ni descarta el outbox", async () => {
  const { repo } = (await setup());
  try {
    assert.equal((await createLeadSyncWorker(repo, {})), undefined);
    assert.equal((await repo.leadSyncOutbox())[0]?.status, "pending");
  } finally {
    (await repo.close());
  }
});

test("worker retiene snapshot ante fallo remoto y marca éxito al reintentar", async () => {
  const { repo } = (await setup());
  const entry = (await repo.leadSyncOutbox())[0]!;
  let fail = true;
  let closed = false;
  let currentTime = new Date(entry.nextAttemptAt);
  const writer: LeadSyncWriter = {
    async synchronize() {
      if (fail) throw Object.assign(new Error("no imprimir PII"), { code: "ECONNRESET" });
    },
    async close() { closed = true; },
  };
  const worker = new LeadSyncWorker(repo, writer, () => currentTime);
  try {
    await worker.tick();
    const failed = (await repo.leadSyncOutbox())[0]!;
    assert.equal(failed.version, entry.version);
    assert.equal(failed.status, "pending");
    assert.equal(failed.attempts, 1);
    assert.equal(failed.lastErrorCode, "ECONNRESET");

    fail = false;
    currentTime = new Date(currentTime.getTime() + 1_000);
    await worker.tick();
    assert.equal((await repo.leadSyncOutbox())[0]?.status, "synced");
  } finally {
    await worker.stop();
    (await repo.close());
  }
  assert.equal(closed, true);
});

test("worker detiene después de ocho intentos y conserva diagnóstico", async () => {
  const { repo } = (await setup());
  const entry = (await repo.leadSyncOutbox())[0]!;
  let currentTime = new Date(entry.nextAttemptAt);
  const worker = new LeadSyncWorker(repo, {
    async synchronize() { throw Object.assign(new Error("remote failure"), { code: "ECONNRESET" }); },
    async close() {},
  }, () => currentTime);
  try {
    for (let attempt = 1; attempt <= 8; attempt++) {
      await worker.tick();
      const row = (await repo.leadSyncOutbox())[0]!;
      assert.equal(row.attempts, attempt);
      assert.equal(row.status, attempt === 8 ? "dead" : "pending");
      assert.equal(row.lastErrorCode, "ECONNRESET");
      currentTime = new Date(row.nextAttemptAt);
    }
  } finally {
    await worker.stop();
    (await repo.close());
  }
});

const pgTestUrl = process.env.LEAD_SYNC_TEST_DATABASE_URL;
test("PostgreSQL local: concurrencia, duplicado idempotente y rollback", { skip: !pgTestUrl }, async () => {
  const connection = new URL(pgTestUrl!);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(connection.hostname), "solo se permite PostgreSQL local");
  assert.equal(connection.pathname.slice(1), "pasa_lead_sync_test", "usa una base aislada llamada pasa_lead_sync_test");
  const pool = new Pool({ connectionString: pgTestUrl, max: 3, ssl: false });
  const writer = new PostgresLeadSyncWriter(pool);
  let createdLeads = false;
  try {
    const existing = await pool.query(`
      SELECT to_regclass('public.leads') AS leads,
             to_regclass('public.lead_perfil_chatbot') AS profile
    `);
    assert.equal(existing.rows[0].leads, null, "la base local dedicada debe iniciar vacía");
    assert.equal(existing.rows[0].profile, null, "la base local dedicada debe iniciar vacía");

    await pool.query(`
      CREATE TABLE public.leads (
        id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
        sistema_origen text NOT NULL,
        id_externo text NOT NULL,
        nombre text,
        telefono text,
        email text,
        vehiculo_interes text,
        UNIQUE (sistema_origen, id_externo)
      )
    `);
    createdLeads = true;
    const migration = await readFile(new URL("../supabase/migrations/20261018231546_lead_perfil_chatbot_sync.sql", import.meta.url), "utf8");
    await pool.query(migration);

    const { repo, detail } = (await setup());
    try {
      const opportunityId = detail.opportunity.id;
      const currentEntry = (await repo.leadSyncOutbox())[0]!;
      const currentSnapshot = JSON.parse(currentEntry.snapshot);
      currentSnapshot.contact.name = "PG local test v2";
      currentSnapshot.collectionStates.name = "answered";
      const versionTwo: LeadSyncOutboxEntry = {
        ...currentEntry,
        version: 2,
        snapshot: JSON.stringify(currentSnapshot),
        snapshotHash: "a".repeat(64),
      };
      const versionOne: LeadSyncOutboxEntry = currentEntry;
      await Promise.all([
        writer.synchronize(versionTwo),
        writer.synchronize(versionOne).then(
          () => undefined,
          error => assert.ok(error instanceof LeadSyncConflictError),
        ),
      ]);
      await writer.synchronize(versionTwo);
      await assert.rejects(
        writer.synchronize(versionOne),
        error => error instanceof LeadSyncConflictError && error.code === "REMOTE_VERSION_AHEAD",
      );

      const badSnapshot = JSON.parse(versionTwo.snapshot);
      badSnapshot.contact.name = "must rollback";
      badSnapshot.profile.timeframe = "invented-days";
      await assert.rejects(writer.synchronize({
        ...versionTwo,
        version: 3,
        snapshot: JSON.stringify(badSnapshot),
        snapshotHash: "b".repeat(64),
      }));
      const persisted = await pool.query(`
        SELECT l.id, l.nombre, l.sistema_origen, l.id_externo, p.version_actualizacion,
               (SELECT count(*) FROM public.leads WHERE sistema_origen = $1 AND id_externo = $2) AS lead_count
        FROM public.leads l JOIN public.lead_perfil_chatbot p ON p.lead_id = l.id
        WHERE l.sistema_origen = $1 AND l.id_externo = $2
      `, ["pasa-chatbot-poc", opportunityId]);
      assert.equal(persisted.rows[0].nombre, "PG local test v2");
      assert.equal(persisted.rows[0].sistema_origen, "pasa-chatbot-poc");
      assert.equal(persisted.rows[0].id_externo, opportunityId);
      assert.equal(Number(persisted.rows[0].lead_count), 1);
      assert.equal(Number(persisted.rows[0].version_actualizacion), 2);
    } finally {
      (await repo.close());
    }
  } finally {
    if (createdLeads) await pool.query("DROP TABLE IF EXISTS public.lead_perfil_chatbot; DROP TABLE IF EXISTS public.leads CASCADE");
    await writer.close();
  }
});
