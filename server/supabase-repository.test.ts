import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { SupabaseRepository, createSupabaseRepository, type RepositorySnapshot, type DocumentRow, type OutboxRow } from './supabase-repository.js';
import { CRMService } from './service.js';
import type { ChatAgent } from './agent.js';

// Exercise the real SDK transport; PostgreSQL RPC semantics are checked separately in SQL.
function fixture() {
  let state: RepositorySnapshot = { documents: [], outbox: [] };
  let conflict = false;
  let networkFailure = false;
  let commits = 0;
  const client = createClient('https://example.supabase.co', 'sb_secret_test', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (String(input).endsWith('/chatbot_repository_snapshot')) return reply(structuredClone(state));
      assert.ok(String(input).endsWith('/chatbot_repository_commit'));
      commits++;
      if (networkFailure) return reply({ code: 'NETWORK_ERROR', message: 'unavailable' }, 503);
      const args = JSON.parse(String(init?.body)) as { expected: RepositorySnapshot; documents: DocumentRow[]; outbox: OutboxRow[] };
      if (conflict || JSON.stringify(args.expected) !== JSON.stringify(state)) {
        conflict = false;
        return reply({ code: '40001', message: 'REPOSITORY_SNAPSHOT_CHANGED' }, 409);
      }
      const next = structuredClone(state);
      for (const row of args.documents) {
        const index = next.documents.findIndex(old => old.entity === row.entity && old.id === row.id);
        if (index < 0) next.documents.push(row); else next.documents[index] = row;
      }
      for (const row of args.outbox) {
        const index = next.outbox.findIndex(old => old.opportunity_id === row.opportunity_id);
        if (index < 0) next.outbox.push(row); else next.outbox[index] = row;
      }
      next.outbox.sort((a, b) => a.opportunity_id.localeCompare(b.opportunity_id));
      state = next;
      return reply(null);
    } },
  });
  return { repo: new SupabaseRepository(client), reopen: () => new SupabaseRepository(client),
    conflict() { conflict = true; }, failNetwork() { networkFailure = true; },
    get state() { return structuredClone(state); }, get commits() { return commits; } };
}

const conversation = (id: string) => ({ id, opportunityId: `opportunity-${id}`, createdAt: '2026-10-20T00:00:00Z' });
const now = '2026-10-20T00:00:00Z';
const hash = 'a'.repeat(64);

test('SDK: orden de inserción, upsert, aislamiento de objetos y transacciones anidadas', async () => {
  const f = fixture();
  await f.repo.transaction(async () => {
    await f.repo.put('conversations', conversation('a'));
    await f.repo.transaction(() => f.repo.put('conversations', conversation('b')));
    assert.equal((await f.repo.all('conversations')).length, 2);
    assert.equal(f.state.documents.length, 0);
  });
  await f.repo.put('conversations', { ...conversation('a'), createdAt: 'changed' });
  assert.deepEqual((await f.repo.all('conversations')).map(row => row.id), ['a', 'b']);
  const row = (await f.repo.get('conversations', 'a'))!;
  row.createdAt = 'unsaved';
  assert.equal((await f.repo.get('conversations', 'a'))?.createdAt, 'changed');
  assert.equal(await f.repo.get('conversations', 'missing'), undefined);
});

test('SDK: rollback descarta documentos y outbox; errores de red no repiten el commit', async () => {
  const f = fixture();
  await assert.rejects(f.repo.transaction(async () => {
    await f.repo.put('conversations', conversation('a'));
    await f.repo.queueLeadSync('a', '{}', hash, now);
    throw new Error('rollback');
  }), /rollback/);
  assert.deepEqual(f.state, { documents: [], outbox: [] });
  assert.equal(f.commits, 0);
  f.failNetwork();
  await assert.rejects(f.repo.put('conversations', conversation('a')));
  assert.equal(f.commits, 1);
});

test('SDK: conflictos reintentan y escritores concurrentes conservan ambos cambios', async () => {
  const f = fixture();
  f.conflict();
  await f.repo.put('conversations', conversation('a'));
  assert.equal(f.commits, 2);
  const second = f.reopen();
  await Promise.all([f.repo.put('conversations', conversation('b')), second.put('conversations', conversation('c'))]);
  assert.equal((await f.repo.all('conversations')).length, 3);
});

test('SDK: outbox mantiene versiones, reintentos, recuperación y confirmaciones obsoletas', async () => {
  const f = fixture();
  assert.equal(await f.repo.queueLeadSync('a', '{}', hash, now), 1);
  assert.equal(await f.repo.queueLeadSync('a', '{}', hash, now), 1);
  assert.equal((await f.repo.claimLeadSync(now))?.status, 'sending');
  assert.equal(await f.reopen().claimLeadSync(now), undefined);
  assert.equal(await f.repo.markLeadSyncFailed('a', 1, now, '2026-10-20T00:01:00Z', 'TIMEOUT', false), 1);
  assert.equal(await f.repo.claimLeadSync(now), undefined);
  await f.repo.claimLeadSync('2026-10-20T00:01:00Z');
  await f.repo.recoverLeadSyncOutbox('2026-10-20T00:03:00Z');
  assert.equal((await f.repo.leadSyncOutbox())[0].status, 'pending');
  assert.equal(await f.repo.queueLeadSync('a', '{"new":true}', 'b'.repeat(64), now), 2);
  await f.repo.markLeadSyncSucceeded('a', 1, now);
  assert.equal((await f.repo.leadSyncOutbox())[0].status, 'pending');
  await f.repo.claimLeadSync(now);
  await f.repo.markLeadSyncFailed('a', 2, now, now, 'CONFLICT', true);
  assert.deepEqual(await f.repo.leadSyncCounts(), { pending: 0, dead: 1 });
});

test('SDK: importación idempotente y conflicto revierte el lote completo', async () => {
  const f = fixture();
  await f.repo.importDocument('conversations', 'a', JSON.stringify(conversation('a')));
  await f.repo.importDocument('conversations', 'a', JSON.stringify({ createdAt: conversation('a').createdAt, opportunityId: 'opportunity-a', id: 'a' }));
  await assert.rejects(f.repo.transaction(async () => {
    await f.repo.importDocument('conversations', 'b', JSON.stringify(conversation('b')));
    await f.repo.importDocument('conversations', 'a', JSON.stringify({ ...conversation('a'), createdAt: 'different' }));
  }), /IMPORT_DOCUMENT_CONFLICT/);
  assert.equal(await f.repo.get('conversations', 'b'), undefined);
});

test('SDK: CRM persiste conversación, mensaje, evaluación, tareas y outbox tras reabrir', async () => {
  const f = fixture();
  let calls = 0;
  let time = Date.parse(now);
  const agent: ChatAgent = { configured: true, respond: async () => {
    calls++;
    return { message: 'Gracias Ana', updates: [{ field: 'name', value: 'Ana', quote: 'Ana', status: 'answered' }] };
  } };
  const service = new CRMService(f.repo, agent, () => new Date(time));
  const id = (await service.createConversation()).opportunity.id;
  const response = await service.sendMessage(id, { text: 'Soy Ana', requestId: 'one' });
  assert.equal(response.customer.name, 'Ana');
  assert.equal(response.evaluations.length, 0);
  assert.equal(response.tasks.length, 2);
  assert.equal((await f.repo.leadSyncOutbox())[0].version, 2);
  const reopened = new CRMService(f.reopen(), agent, () => new Date(time));
  assert.deepEqual(await reopened.detail(id), response);
  await reopened.sendMessage(id, { text: 'Soy Ana', requestId: 'one' });
  assert.equal(calls, 1);
  time += 25 * 3600_000;
  await reopened.followups.tick();
  assert.equal((await reopened.detail(id)).tasks.filter(task => task.status === 'completed').length, 1);
});

test('SDK: configuración de servidor requerida', () => {
  assert.throws(() => createSupabaseRepository({}), /SUPABASE_URL y SUPABASE_SECRET_KEY/);
});
