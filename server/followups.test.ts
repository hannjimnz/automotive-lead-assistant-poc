import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { CRMService, ApiError } from './service.js';
import { SqliteRepository } from './repository.js';
import { agentFieldSchema, type AgentOutput, type ChatAgent } from './agent.js';
import { followupState } from '../shared/followup.js';
import { followupRoutes } from './followup-routes.js';

const hour = 3600000;
async function setup(path = ':memory:') {
  const repo = new SqliteRepository(path);
  let time = Date.parse('2026-10-16T12:00:00Z');
  let calls = 0;
  let output: AgentOutput = { message: 'Gracias', updates: [] };
  let respond: () => Promise<AgentOutput> = async () => output;
  const agent: ChatAgent = { configured: true, respond: async () => { calls++; return respond(); } };
  const clock = () => new Date(time);
  const service = new CRMService(repo, agent, clock);
  const id = (await service.createConversation()).opportunity.id;
  let sequence = 0;
  return { repo, service, agent, clock, id, get calls() { return calls; },
    advance(hours: number) { time += hours * hour; },
    setOutput(value: AgentOutput) { output = value; },
    setResponder(value: typeof respond) { respond = value; },
    send(text = 'hola', requestId = `send-${++sequence}`) { return service.sendMessage(id, { text, requestId }); },
    async detail() { return (await service.detail(id)); },
    async task(attempt: 1 | 2) { return (await service.detail(id)).tasks.filter(task => task.kind === 'followup' && task.attempt === attempt).at(-1)!; },
  };
}
async function attended(f: Awaited<ReturnType<typeof setup>>) {
  const o = (await f.detail()).opportunity;
  for (const field of agentFieldSchema.options) o.collection[field] = 'unknown';
  o.answers = {};
  // Conditional values are not required when their parent does not apply.
  o.collection.downPayment = 'pending';
  o.collection.tradeInBrand = 'pending';
  o.collection.tradeInModel = 'pending';
  o.collection.tradeInYear = 'pending';
  (await f.repo.put('opportunities', o));
  return o;
}

test('seguimiento: necesita usuario, todos los estados atendidos cuentan y respeta dependencias/propuestas', async () => {
  const f = (await setup());
  try {
    (await f.service.followups.tick());
    assert.equal((await f.detail()).tasks.length, 0);
    await f.send();
    assert.equal((await f.detail()).tasks.length, 2);
    const o = (await attended(f));
    assert.equal(followupState((await f.detail())).incomplete, false);
    for (const status of ['answered', 'unknown', 'declined', 'not_applicable'] as const) {
      o.collection.timeframe = status;
      (await f.repo.put('opportunities', o));
      assert.equal(followupState((await f.detail())).incomplete, false);
    }
    o.collection.questions = 'pending'; (await f.repo.put('opportunities', o));
    assert.equal(followupState((await f.detail())).incomplete, true);
    o.collection.questions = 'answered';
    o.answers.payment = 'credit'; (await f.repo.put('opportunities', o));
    assert.equal(followupState((await f.detail())).incomplete, true);
    o.answers.payment = 'cash'; o.answers.tradeIn = true; (await f.repo.put('opportunities', o));
    assert.equal(followupState((await f.detail())).incomplete, true);
    o.answers.tradeIn = false; (await f.repo.put('opportunities', o));
    assert.equal(followupState((await f.detail())).incomplete, false);
    o.proposals = [{ id: 'proposal', field: 'budget', value: '500000', quote: '500 mil', sourceMessageId: 'source', status: 'pending' }];
    (await f.repo.put('opportunities', o));
    assert.equal(followupState((await f.detail())).incomplete, true);
  } finally { (await f.repo.close()); }
});

test('seguimiento: 24 y 48 horas, último del ciclo, sin IA, sin recalificar ni reiniciar plazos', async () => {
  const f = (await setup());
  try {
    await f.send();
    const before = (await f.detail());
    const dates = before.tasks.map(task => task.dueAt);
    assert.equal(Date.parse((await f.task(1)).dueAt) - f.clock().getTime(), 24 * hour);
    assert.equal(Date.parse((await f.task(2)).dueAt) - f.clock().getTime(), 48 * hour);
    f.advance(23); (await f.service.followups.tick());
    assert.equal((await f.detail()).messages.length, before.messages.length);
    f.advance(1); (await f.service.followups.tick());
    assert.equal((await f.task(1)).status, 'completed');
    assert.equal((await f.task(1)).mode, 'automatic');
    assert.equal((await f.task(2)).status, 'pending');
    f.advance(24); (await f.service.followups.tick());
    assert.equal((await f.task(2)).status, 'completed');
    assert.match((await f.detail()).messages.at(-1)!.text, /último recordatorio/);
    f.advance(120); (await f.service.followups.tick());
    assert.equal((await f.detail()).messages.length, before.messages.length + 2);
    assert.deepEqual((await f.detail()).tasks.map(task => task.dueAt), dates);
    assert.equal((await f.detail()).opportunity.score, before.opportunity.score);
    assert.equal((await f.detail()).opportunity.status, before.opportunity.status);
    assert.deepEqual((await f.detail()).evaluations, before.evaluations);
    assert.equal(f.calls, 1);
  } finally { (await f.repo.close()); }
});

test('seguimiento: simulaciones ordenadas e idempotentes, sin alterar el reloj ni otros registros', async () => {
  const f = (await setup());
  try {
    await f.send();
    const other = (await f.service.createConversation());
    const before = (await f.detail());
    const clock = f.clock().toISOString();
    assert.equal((await f.service.followups.execute((await f.task(2)).id, 'simulated')).sent, false);
    const results = await Promise.all([1, 2, 3].map(async () => (await f.service.followups.execute((await f.task(1)).id, 'simulated'))));
    assert.equal(results.filter(result => result.sent).length, 1);
    assert.equal((await f.service.followups.execute((await f.task(2)).id, 'simulated')).sent, true);
    assert.equal((await f.service.followups.execute((await f.task(2)).id, 'automatic')).sent, false);
    assert.equal((await f.detail()).messages.length, before.messages.length + 2);
    assert.ok((await f.detail()).events.some(event => event.type === 'followup_sent' && event.description.includes('simulación')));
    assert.deepEqual((await f.detail()).tasks.map(task => task.dueAt), before.tasks.map(task => task.dueAt));
    assert.equal(f.clock().toISOString(), clock);
    assert.deepEqual((await f.service.detail(other.opportunity.id)), other);
    assert.equal(f.calls, 1);
  } finally { (await f.repo.close()); }
});

test('seguimiento: respuesta cancela inmediatamente, procesamiento bloquea, nuevo ciclo y reintento sin duplicación', async () => {
  const f = (await setup());
  try {
    await f.send();
    const old = (await f.detail()).tasks;
    let finish!: (output: AgentOutput) => void;
    f.setResponder(() => new Promise(resolve => { finish = resolve; }));
    f.advance(25);
    const sending = f.send('seguimos', 'cycle-reply');
    while (!finish) await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok((await f.detail()).tasks.every(task => task.status === 'cancelled'));
    (await f.service.followups.tick());
    assert.equal((await f.detail()).messages.filter(message => message.role === 'assistant').length, 2);
    finish({ message: 'Claro', updates: [] });
    await sending;
    assert.equal((await f.detail()).tasks.filter(task => task.status === 'pending').length, 2);
    assert.notEqual((await f.task(1)).cycleId, old[0].cycleId);
    assert.equal(Date.parse((await f.task(1)).dueAt) - f.clock().getTime(), 24 * hour);
    const state = (await f.detail());
    await f.send('seguimos', 'cycle-reply');
    assert.deepEqual((await f.detail()), state);
  } finally { (await f.repo.close()); }
});

test('seguimiento: completa cancela pendientes; revalida al ejecutar en vez de confiar en score', async () => {
  const f = (await setup());
  try {
    await f.send();
    const task = (await f.task(1));
    (await attended(f));
    assert.equal((await f.service.followups.execute(task.id, 'simulated')).sent, false);
    assert.equal((await f.task(1)).status, 'cancelled');
    (await f.service.followups.tick());
    assert.ok((await f.detail()).tasks.every(item => item.status === 'cancelled'));
    assert.equal(f.calls, 1);
  } finally { (await f.repo.close()); }
});

test('seguimiento: completar en una respuesta cancela todo y no crea otro ciclo', async () => {
  const f = (await setup());
  try {
    await f.send();
    (await attended(f));
    await f.send('gracias');
    assert.equal(followupState((await f.detail())).eligible, false);
    assert.equal((await f.detail()).tasks.length, 2);
    assert.ok((await f.detail()).tasks.every(task => task.status === 'cancelled'));
  } finally { (await f.repo.close()); }
});

test('seguimiento: revalidación bloquea una tarea vigente durante procesamiento sin consumirla', async () => {
  const f = (await setup());
  try {
    await f.send();
    const task = (await f.task(1));
    const message = (await f.detail()).messages.find(item => item.role === 'user')!;
    (await f.repo.put('messages', { ...message, status: 'pending' }));
    const count = (await f.detail()).messages.length;
    assert.equal((await f.service.followups.execute(task.id, 'simulated')).sent, false);
    assert.equal((await f.task(1)).status, 'pending');
    assert.equal((await f.detail()).messages.length, count);
    (await f.repo.put('messages', message));
    assert.equal((await f.service.followups.execute(task.id, 'simulated')).sent, true);
  } finally { (await f.repo.close()); }
});

test('seguimiento: un recordatorio conserva la pregunta y la confirmación válida entre turnos', async () => {
  const f = (await setup());
  try {
    f.setOutput({ message: '¿Tienes vehículo a cuenta?', updates: [], questionFields: ['tradeIn'] });
    await f.send();
    (await f.service.followups.execute((await f.task(1)).id, 'simulated'));
    f.setOutput({ message: 'Gracias', updates: [] });
    await f.send('sí');
    assert.equal((await f.detail()).opportunity.answers.tradeIn, true);
    f.setOutput({ message: '¿Confirmas ese presupuesto?', updates: [{ field: 'budget', value: '500000', quote: '500 mil', status: 'answered', mode: 'propose' }], questionFields: ['budget'] });
    await f.send('500 mil');
    (await f.service.followups.execute((await f.task(1)).id, 'simulated'));
    f.setOutput({ message: 'Gracias', updates: [] });
    await f.send('confirmo');
    assert.equal((await f.detail()).opportunity.answers.budget, 500000);
  } finally { (await f.repo.close()); }
});

test('seguimiento: respuesta fallida cancela el ciclo anterior y solo el reintento aceptado programa otro', async () => {
  const f = (await setup());
  try {
    await f.send();
    f.setResponder(async () => { throw new Error('Fallo falso'); });
    await assert.rejects(f.send('respuesta', 'retry-cycle'));
    f.advance(50); (await f.service.followups.tick());
    assert.ok((await f.detail()).tasks.every(task => task.status === 'cancelled'));
    assert.equal((await f.detail()).messages.filter(message => message.followupTaskId).length, 0);
    f.setResponder(async () => ({ message: 'Gracias', updates: [] }));
    await f.send('respuesta', 'retry-cycle');
    assert.equal((await f.detail()).tasks.filter(task => task.status === 'pending').length, 2);
    assert.equal(Date.parse((await f.task(1)).dueAt) - f.clock().getTime(), 24 * hour);
    (await f.service.followups.tick());
    assert.equal((await f.detail()).messages.filter(message => message.followupTaskId).length, 0);
  } finally { (await f.repo.close()); }
});

test('seguimiento: la transacción revierte mensaje si falla marcar tarea; reintento escribe una sola vez', async (t) => {
  const f = (await setup());
  try {
    await f.send();
    const before = (await f.detail());
    const put = f.repo.put.bind(f.repo);
    const fault = t.mock.method(f.repo, 'put', ((table: string, item: { status?: string }) => {
      if (table === 'tasks' && item.status === 'completed') throw new Error('Fallo aislado');
      return put(table as never, item as never);
    }) as typeof f.repo.put);
    await assert.rejects(async () => (await f.service.followups.execute((await f.task(1)).id, 'simulated')), /Fallo aislado/);
    assert.deepEqual((await f.detail()), before);
    fault.mock.restore();
    (await f.service.followups.execute((await f.task(1)).id, 'simulated'));
    (await f.service.followups.execute((await f.task(1)).id, 'simulated'));
    assert.equal((await f.detail()).messages.length, before.messages.length + 1);
  } finally { (await f.repo.close()); }
});

test('seguimiento: reinicio SQLite real aislado, ambas vencidas entrega solo 48 h y omite 24 h', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pasa-followups-'));
  const file = join(dir, 'test.sqlite');
  const f = (await setup(file));
  let reopened: SqliteRepository | undefined;
  try {
    await f.send();
    const old = (await f.detail());
    f.advance(49);
    (await f.repo.close());
    reopened = new SqliteRepository(file);
    const service = new CRMService(reopened, { configured: true, respond: async () => { throw new Error('No IA'); } }, f.clock);
    (await service.followups.tick());
    (await service.followups.tick());
    const detail = (await service.detail(f.id));
    assert.equal(detail.messages.length, old.messages.length + 1);
    assert.equal(detail.tasks.find(task => task.attempt === 1)!.status, 'skipped');
    assert.equal(detail.tasks.find(task => task.attempt === 2)!.status, 'completed');
    assert.ok(detail.events.some(event => event.type === 'followup_skipped'));
    assert.equal(detail.tasks.at(-1)!.mode, 'automatic');
    assert.equal(f.calls, 1);
  } finally { (await reopened?.close()); if (!reopened) (await f.repo.close()); unlinkSync(file); rmdirSync(dir); }
});

test('seguimiento HTTP: doble clic y reintentos, segundo bloqueado, ciclo obsoleto rechazado', async () => {
  const f = (await setup());
  const app = express().use(express.json()).use(followupRoutes(f.service));
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    void next;
    res.status(error instanceof ApiError ? error.status : 500).json({ message: error instanceof Error ? error.message : 'Error' });
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    await f.send();
    const cycleId = (await f.task(1)).cycleId;
    const post = (attempt: number, cycle = cycleId) => fetch(`http://127.0.0.1:${address.port}/api/opportunities/${f.id}/followups/simulate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attempt, cycleId: cycle }) });
    assert.equal((await post(2)).status, 409);
    const before = (await f.detail()).messages.length;
    const replies = await Promise.all([post(1), post(1), post(1)]);
    assert.ok(replies.every(reply => reply.status === 200));
    assert.equal((await f.detail()).messages.length, before + 1);
    assert.equal((await post(2)).status, 200);
    assert.equal((await post(2)).status, 200);
    await f.send('retomo');
    assert.equal((await post(1)).status, 409);
    assert.equal(f.calls, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); (await f.repo.close()); }
});
