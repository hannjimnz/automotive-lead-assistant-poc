import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { PostgresRepository } from './postgres-repository.js';

function fixture() {
  const clients: { commands: string[]; released: boolean }[] = [];
  let poolQueries = 0;
  const pool = {
    async connect() {
      const state = { commands: [] as string[], released: false };
      clients.push(state);
      return {
        async query(sql: string) { state.commands.push(sql); return { rows: [], rowCount: 0 }; },
        release() { state.released = true; },
      };
    },
    async query() { poolQueries++; return { rows: [], rowCount: 0 }; },
    async end() {},
  } as unknown as Pool;
  return { repo: new PostgresRepository(pool), clients, poolQueries: () => poolQueries };
}

test('PostgreSQL: la transacción espera las escrituras asíncronas y reutiliza el cliente al anidar', async () => {
  const f = fixture();
  await f.repo.transaction(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await f.repo.put('conversations', { id: 'conversation', opportunityId: 'opportunity', createdAt: '2026-10-19' });
    await f.repo.transaction(async () => { await f.repo.get('conversations', 'conversation'); });
  });
  assert.equal(f.clients.length, 1);
  assert.equal(f.poolQueries(), 0);
  assert.match(f.clients[0].commands[2], /INSERT INTO chatbot.documents/);
  assert.equal(f.clients[0].commands.at(-1), 'COMMIT');
  assert.equal(f.clients[0].released, true);
});

test('PostgreSQL: un fallo asíncrono revierte y libera la conexión', async () => {
  const f = fixture();
  await assert.rejects(f.repo.transaction(async () => {
    await f.repo.get('customers', 'customer');
    throw new Error('fixture failure');
  }), /fixture failure/);
  assert.equal(f.clients[0].commands.at(-1), 'ROLLBACK');
  assert.equal(f.clients[0].commands.includes('COMMIT'), false);
  assert.equal(f.clients[0].released, true);
});

test('PostgreSQL: las transacciones concurrentes conservan sus propios clientes', async () => {
  const f = fixture();
  await Promise.all(['first', 'second'].map(id => f.repo.transaction(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await f.repo.get('customers', id);
  })));
  assert.equal(f.clients.length, 2);
  assert.equal(f.poolQueries(), 0);
  for (const client of f.clients) {
    assert.equal(client.commands.filter(sql => sql.startsWith('SELECT body')).length, 1);
    assert.equal(client.commands.at(-1), 'COMMIT');
    assert.equal(client.released, true);
  }
});

test('PostgreSQL: importar un ID con contenido distinto aborta la transacción', async () => {
  const f = fixture();
  await assert.rejects(f.repo.transaction(() => f.repo.importDocument('customers', 'customer', '{"id":"customer"}')), /IMPORT_DOCUMENT_CONFLICT/);
  assert.equal(f.clients[0].commands.at(-1), 'ROLLBACK');
});
