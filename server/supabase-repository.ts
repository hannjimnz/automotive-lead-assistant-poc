import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Entities, Table, Repository, LeadSyncOutboxEntry } from './repository.js';

export interface DocumentRow { entity: Table; id: string; body: Entities[Table] }
export interface OutboxRow {
  opportunity_id: string; version: number; snapshot: string; snapshot_hash: string;
  attempts: number; status: LeadSyncOutboxEntry['status']; next_attempt_at: string;
  last_error_code: string | null; updated_at: string;
}
export interface RepositorySnapshot { documents: DocumentRow[]; outbox: OutboxRow[] }
interface TransactionState {
  snapshot: RepositorySnapshot;
  documents: DocumentRow[];
  outbox: OutboxRow[];
  writes: Map<string, DocumentRow>;
  outboxWrites: Map<string, OutboxRow>;
}

/** Server-only SDK repository. RPC commits atomically validate the read snapshot. */
export class SupabaseRepository implements Repository {
  private readonly context = new AsyncLocalStorage<TransactionState>();
  private tail: Promise<void> = Promise.resolve();

  private readonly client: SupabaseClient;
  constructor(client: SupabaseClient) { this.client = client; }

  private async snapshot(): Promise<RepositorySnapshot> {
    const { data, error } = await this.client.rpc('chatbot_repository_snapshot');
    if (error) throw error;
    if (!data || !Array.isArray(data.documents) || !Array.isArray(data.outbox)) {
      throw new Error('INVALID_REPOSITORY_SNAPSHOT');
    }
    return data as RepositorySnapshot;
  }

  async verify(): Promise<void> { await this.snapshot(); }

  async get<K extends Table>(table: K, id: string): Promise<Entities[K] | undefined> {
    const state = this.context.getStore() ?? await this.snapshot();
    const row = state.documents.find(row => row.entity === table && row.id === id);
    return row ? structuredClone(row.body) as Entities[K] : undefined;
  }

  async all<K extends Table>(table: K): Promise<Entities[K][]> {
    const state = this.context.getStore() ?? await this.snapshot();
    return state.documents.filter(row => row.entity === table).map(row => structuredClone(row.body) as Entities[K]);
  }

  async put<K extends Table>(table: K, item: Entities[K]): Promise<void> {
    const state = this.context.getStore();
    if (!state) return this.transaction(() => this.put(table, item));
    // Match SQLite/JSONB serialization, including omission of undefined properties.
    const row: DocumentRow = { entity: table, id: item.id, body: JSON.parse(JSON.stringify(item)) as Entities[K] };
    const index = state.documents.findIndex(old => old.entity === table && old.id === item.id);
    if (index < 0) state.documents.push(row);
    else state.documents[index] = row;
    state.writes.set(JSON.stringify([table, item.id]), row);
  }

  // Callbacks must only perform repository operations: a serialization conflict can replay them.
  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return operation();
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const snapshot = await this.snapshot();
        const state: TransactionState = { snapshot, ...structuredClone(snapshot), writes: new Map(), outboxWrites: new Map() };
        const result = await this.context.run(state, operation);
        if (!state.writes.size && !state.outboxWrites.size) return result;
        const { error } = await this.client.rpc('chatbot_repository_commit', {
          expected: state.snapshot,
          documents: [...state.writes.values()],
          outbox: [...state.outboxWrites.values()],
        });
        if (!error) return result;
        // Only a confirmed serialization failure is retried; network errors have ambiguous outcomes.
        if (error.code !== '40001' || attempt === 4) throw error;
      }
      throw new Error('REPOSITORY_TRANSACTION_FAILED');
    } finally { release(); }
  }

  private saveOutbox(row: OutboxRow): void {
    const state = this.context.getStore();
    if (!state) throw new Error('OUTBOX_TRANSACTION_REQUIRED');
    const index = state.outbox.findIndex(old => old.opportunity_id === row.opportunity_id);
    if (index < 0) state.outbox.push(row);
    else state.outbox[index] = row;
    state.outboxWrites.set(row.opportunity_id, row);
  }

  async queueLeadSync(id: string, snapshot: string, hash: string, now: string): Promise<number> {
    return this.transaction(() => {
      const old = this.context.getStore()!.outbox.find(row => row.opportunity_id === id);
      if (old?.snapshot_hash === hash) return old.version;
      const version = (old?.version ?? 0) + 1;
      this.saveOutbox({ opportunity_id: id, version, snapshot, snapshot_hash: hash, attempts: 0,
        status: 'pending', next_attempt_at: now, last_error_code: null, updated_at: now });
      return version;
    });
  }

  async claimLeadSync(now: string): Promise<LeadSyncOutboxEntry | undefined> {
    return this.transaction(() => {
      const row = this.context.getStore()!.outbox.filter(row =>
        (row.status === 'pending' && row.next_attempt_at <= now) ||
        (row.status === 'sending' && Date.parse(row.updated_at) < Date.parse(now) - 60_000)
      ).sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at) || a.updated_at.localeCompare(b.updated_at))[0];
      if (!row) return undefined;
      const claimed = { ...row, status: 'sending' as const, updated_at: now };
      this.saveOutbox(claimed);
      return mapOutbox(claimed);
    });
  }

  async markLeadSyncSucceeded(id: string, version: number, now: string): Promise<void> {
    await this.transaction(() => {
      const row = this.context.getStore()!.outbox.find(row => row.opportunity_id === id && row.version === version && row.status === 'sending');
      if (row) this.saveOutbox({ ...row, status: 'synced', attempts: 0, last_error_code: null, updated_at: now });
    });
  }

  async markLeadSyncFailed(id: string, version: number, now: string, next: string, code: string, terminal: boolean): Promise<number | undefined> {
    return this.transaction(() => {
      const row = this.context.getStore()!.outbox.find(row => row.opportunity_id === id && row.version === version && row.status === 'sending');
      if (!row) return undefined;
      const attempts = row.attempts + 1;
      this.saveOutbox({ ...row, attempts, status: terminal ? 'dead' : 'pending', next_attempt_at: next,
        last_error_code: code, updated_at: now });
      return attempts;
    });
  }

  async recoverLeadSyncOutbox(now: string): Promise<void> {
    await this.transaction(() => {
      for (const row of this.context.getStore()!.outbox) {
        if (row.status === 'sending' && Date.parse(row.updated_at) < Date.parse(now) - 60_000) {
          this.saveOutbox({ ...row, status: 'pending', next_attempt_at: now, updated_at: now });
        }
      }
    });
  }

  async leadSyncOutbox(): Promise<LeadSyncOutboxEntry[]> {
    const state = this.context.getStore() ?? await this.snapshot();
    return [...state.outbox].sort((a, b) => a.opportunity_id.localeCompare(b.opportunity_id)).map(mapOutbox);
  }

  async leadSyncCounts(): Promise<{ pending: number; dead: number }> {
    const rows = await this.leadSyncOutbox();
    return { pending: rows.filter(row => row.status === 'pending' || row.status === 'sending').length,
      dead: rows.filter(row => row.status === 'dead').length };
  }

  async importDocument(entity: string, id: string, body: string): Promise<void> {
    await this.transaction(async () => {
      const old = await this.get(entity as Table, id);
      const parsed = JSON.parse(body) as Entities[Table];
      if (parsed.id !== id) throw new Error('IMPORT_DOCUMENT_INVALID_ID');
      if (old && !jsonEqual(old, parsed)) throw new Error('IMPORT_DOCUMENT_CONFLICT');
      if (!old) await this.put(entity as Table, parsed);
    });
  }

  async importOutbox(value: Record<string, unknown>): Promise<void> {
    await this.transaction(() => {
      const row = { ...value, status: value.status === 'sending' ? 'pending' : value.status } as unknown as OutboxRow;
      const old = this.context.getStore()!.outbox.find(old => old.opportunity_id === row.opportunity_id);
      if (old && !jsonEqual(old, row)) throw new Error('IMPORT_OUTBOX_CONFLICT');
      if (!old) this.saveOutbox(row);
    });
  }

  async close(): Promise<void> { await this.tail; }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function mapOutbox(row: OutboxRow): LeadSyncOutboxEntry {
  return { opportunityId: row.opportunity_id, version: row.version, snapshot: row.snapshot,
    snapshotHash: row.snapshot_hash, attempts: row.attempts, status: row.status,
    nextAttemptAt: row.next_attempt_at, ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}) };
}

export function createSupabaseRepository(environment: NodeJS.ProcessEnv = process.env): SupabaseRepository {
  const url = environment.SUPABASE_URL?.trim();
  const key = environment.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) throw new Error('Configura SUPABASE_URL y SUPABASE_SECRET_KEY en el servidor.');
  return new SupabaseRepository(createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }));
}
