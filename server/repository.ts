import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import type { CampaignAccess } from "../shared/campaign.js";

import type {
  Customer,
  Opportunity,
  Conversation,
  Message,
  Evaluation,
  Event,
  Task,
  Rules,
} from "../shared/domain.js";

export interface Entities {
  campaignAccesses: CampaignAccess;
  customers: Customer;
  opportunities: Opportunity;
  conversations: Conversation;
  messages: Message;
  evaluations: Evaluation;
  events: Event;
  tasks: Task;
  rules: Rules;
}

export type Table = keyof Entities;

type Awaitable<T> = T | Promise<T>;
export interface Repository {
  get<K extends Table>(table: K, id: string): Awaitable<Entities[K] | undefined>;
  all<K extends Table>(table: K): Awaitable<Entities[K][]>;
  put<K extends Table>(table: K, item: Entities[K]): Awaitable<void>;
  transaction<T>(operation: () => Awaitable<T>): Awaitable<T>;
  queueLeadSync(opportunityId: string, snapshot: string, hash: string, now: string): Awaitable<number>;
  claimLeadSync(now: string): Awaitable<LeadSyncOutboxEntry | undefined>;
  markLeadSyncSucceeded(id: string, version: number, now: string): Awaitable<void>;
  markLeadSyncFailed(id: string, version: number, now: string, next: string, code: string, terminal: boolean): Awaitable<number | undefined>;
  recoverLeadSyncOutbox(now: string): Awaitable<void>;
  leadSyncOutbox(): Awaitable<LeadSyncOutboxEntry[]>;
  leadSyncCounts(): Awaitable<{ pending: number; dead: number }>;
  close(): Awaitable<void>;
}

export interface LeadSyncOutboxEntry {
  opportunityId: string;
  version: number;
  snapshot: string;
  snapshotHash: string;
  attempts: number;
  status: "pending" | "sending" | "synced" | "dead";
  nextAttemptAt: string;
  lastErrorCode?: string;
}

const tables: Table[] = [
  "campaignAccesses",
  "customers",
  "opportunities",
  "conversations",
  "messages",
  "evaluations",
  "events",
  "tasks",
  "rules",
];

export class SqliteRepository {
  private db: DatabaseSync;
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private transactionTail: Promise<unknown> = Promise.resolve();

  constructor(path = "data/pasa.sqlite") {
    const file = path === ":memory:" ? path : resolve(path);

    if (file !== ":memory:") {
      mkdirSync(dirname(file), { recursive: true });
    }

    this.db = new DatabaseSync(file);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        entity TEXT NOT NULL,
        id TEXT NOT NULL,
        body TEXT NOT NULL CHECK (json_valid(body)),
        PRIMARY KEY (entity, id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS customer_phone
      ON documents(json_extract(body, '$.phone'))
      WHERE entity = 'customers';

      CREATE UNIQUE INDEX IF NOT EXISTS customer_email
      ON documents(json_extract(body, '$.email'))
      WHERE entity = 'customers';

      CREATE UNIQUE INDEX IF NOT EXISTS opportunity_conversation
      ON documents(json_extract(body, '$.opportunityId'))
      WHERE entity = 'conversations';

      CREATE TABLE IF NOT EXISTS lead_sync_outbox (
        opportunity_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version > 0),
        snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
        snapshot_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'synced', 'dead')),
        next_attempt_at TEXT NOT NULL,
        last_error_code TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS lead_sync_outbox_due
      ON lead_sync_outbox(status, next_attempt_at);
    `);
  }

  get<K extends Table>(
    table: K,
    id: string,
  ): Entities[K] | undefined {
    this.checkTable(table);

    const row = this.db
      .prepare("SELECT body FROM documents WHERE entity = ? AND id = ?")
      .get(table, id);

    if (!row) return undefined;

    return JSON.parse(String(row.body)) as Entities[K];
  }

  all<K extends Table>(table: K): Entities[K][] {
    this.checkTable(table);

    const rows = this.db
      .prepare("SELECT body FROM documents WHERE entity = ? ORDER BY rowid")
      .all(table);

    return rows.map(
      (row) => JSON.parse(String(row.body)) as Entities[K],
    );
  }

  put<K extends Table>(table: K, item: Entities[K]): void {
    this.checkTable(table);

    this.db
      .prepare(`
        INSERT INTO documents (entity, id, body)
        VALUES (?, ?, ?)
        ON CONFLICT (entity, id)
        DO UPDATE SET body = excluded.body
      `)
      .run(table, item.id, JSON.stringify(item));
  }

  queueLeadSync(opportunityId: string, snapshot: string, snapshotHash: string, now: string): number {
    const current = this.db
      .prepare("SELECT version, snapshot_hash FROM lead_sync_outbox WHERE opportunity_id = ?")
      .get(opportunityId) as { version: number; snapshot_hash: string } | undefined;

    if (current?.snapshot_hash === snapshotHash) return current.version;

    const version = (current?.version ?? 0) + 1;
    this.db.prepare(`
      INSERT INTO lead_sync_outbox (
        opportunity_id, version, snapshot, snapshot_hash, attempts, status,
        next_attempt_at, last_error_code, updated_at
      ) VALUES (?, ?, ?, ?, 0, 'pending', ?, NULL, ?)
      ON CONFLICT (opportunity_id) DO UPDATE SET
        version = excluded.version,
        snapshot = excluded.snapshot,
        snapshot_hash = excluded.snapshot_hash,
        attempts = 0,
        status = 'pending',
        next_attempt_at = excluded.next_attempt_at,
        last_error_code = NULL,
        updated_at = excluded.updated_at
    `).run(opportunityId, version, snapshot, snapshotHash, now, now);

    return version;
  }

  claimLeadSync(now: string): Promise<LeadSyncOutboxEntry | undefined> {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT opportunity_id, version, snapshot, snapshot_hash, attempts, status,
               next_attempt_at, last_error_code
        FROM lead_sync_outbox
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at, updated_at
        LIMIT 1
      `).get(now) as LeadSyncOutboxRow | undefined;

      if (!row) return undefined;

      const result = this.db.prepare(`
        UPDATE lead_sync_outbox SET status = 'sending', updated_at = ?
        WHERE opportunity_id = ? AND version = ? AND status = 'pending'
      `).run(now, row.opportunity_id, row.version);

      if (Number(result.changes) !== 1) return undefined;
      return mapLeadSyncOutboxRow({ ...row, status: "sending" });
    });
  }

  markLeadSyncSucceeded(opportunityId: string, version: number, now: string): void {
    this.db.prepare(`
      UPDATE lead_sync_outbox
      SET status = 'synced', attempts = 0, last_error_code = NULL, updated_at = ?
      WHERE opportunity_id = ? AND version = ? AND status = 'sending'
    `).run(now, opportunityId, version);
  }

  markLeadSyncFailed(
    opportunityId: string,
    version: number,
    now: string,
    nextAttemptAt: string,
    errorCode: string,
    terminal: boolean,
  ): Promise<number | undefined> {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT attempts FROM lead_sync_outbox
        WHERE opportunity_id = ? AND version = ? AND status = 'sending'
      `).get(opportunityId, version) as { attempts: number } | undefined;

      if (!row) return undefined;
      const attempts = row.attempts + 1;
      this.db.prepare(`
        UPDATE lead_sync_outbox
        SET attempts = ?, status = ?, next_attempt_at = ?, last_error_code = ?, updated_at = ?
        WHERE opportunity_id = ? AND version = ? AND status = 'sending'
      `).run(attempts, terminal ? "dead" : "pending", nextAttemptAt, errorCode, now, opportunityId, version);
      return attempts;
    });
  }

  recoverLeadSyncOutbox(now: string): void {
    this.db.prepare(`
      UPDATE lead_sync_outbox
      SET status = 'pending', next_attempt_at = ?, updated_at = ?
      WHERE status = 'sending'
    `).run(now, now);
  }

  leadSyncOutbox(): LeadSyncOutboxEntry[] {
    const rows = this.db.prepare(`
      SELECT opportunity_id, version, snapshot, snapshot_hash, attempts, status,
             next_attempt_at, last_error_code
      FROM lead_sync_outbox ORDER BY opportunity_id
    `).all() as unknown as LeadSyncOutboxRow[];
    return rows.map(mapLeadSyncOutboxRow);
  }

  leadSyncCounts(): { pending: number; dead: number } {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM lead_sync_outbox
      WHERE status IN ('pending', 'sending', 'dead') GROUP BY status
    `).all() as { status: string; count: number }[];
    const counts = new Map(rows.map(row => [row.status, row.count]));
    return {
      pending: (counts.get("pending") ?? 0) + (counts.get("sending") ?? 0),
      dead: counts.get("dead") ?? 0,
    };
  }

  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) return operation();
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      this.db.exec("BEGIN IMMEDIATE");

      try {
        const result = await this.transactionContext.run(true, operation);
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } finally { release(); }
  }

  close(): void {
    this.db.close();
  }

  private checkTable(table: Table): void {
    if (!tables.includes(table)) {
      throw new Error("Entidad no permitida.");
    }
  }
}

interface LeadSyncOutboxRow {
  opportunity_id: string;
  version: number;
  snapshot: string;
  snapshot_hash: string;
  attempts: number;
  status: LeadSyncOutboxEntry["status"];
  next_attempt_at: string;
  last_error_code: string | null;
}

function mapLeadSyncOutboxRow(row: LeadSyncOutboxRow): LeadSyncOutboxEntry {
  return {
    opportunityId: row.opportunity_id,
    version: row.version,
    snapshot: row.snapshot,
    snapshotHash: row.snapshot_hash,
    attempts: row.attempts,
    status: row.status,
    nextAttemptAt: row.next_attempt_at,
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
  };
}
