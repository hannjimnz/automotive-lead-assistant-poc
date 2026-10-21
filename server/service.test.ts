import { test } from "node:test";
import assert from "node:assert/strict";
import { CRMService, ApiError } from "./service.js";
import { SqliteRepository } from "./repository.js";
import type { AgentOutput, ChatAgent, ChatContext } from "./agent.js";

class FakeAgent implements ChatAgent {
  configured = true;
  calls = 0;
  run: (context: ChatContext, text: string) => Promise<AgentOutput> = async () => ({ message: "Gracias", updates: [] });
  async respond(context: ChatContext, text: string) {
    this.calls++;
    return this.run(context, text);
  }
}
const update = (field: AgentOutput["updates"][number]["field"], value: string | null, quote: string, status: "answered" | "unknown" | "declined" = "answered") => ({ field, value, quote, status });
async function setup() {
  const repo = new SqliteRepository(":memory:");
  const agent = new FakeAgent();
  const service = new CRMService(repo, agent);
  const id = (await service.createConversation()).opportunity.id;
  return { repo, agent, service, id };
}
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test("extracción válida, evidencia, tipos, evaluación y duplicados", async () => {
  const { repo, agent, service, id } = (await setup());
  try {
    agent.run = async (_context, text) => {
      assert.equal((await service.detail(id)).messages.at(-1)?.status, "pending");
      // A transaction can start here: none is held across the agent call.
      (await repo.transaction(async () => assert.ok((await repo.get("opportunities", id)))));
      return { message: "Gracias Ana", updates: [update("name", "Ana Pérez", "Ana Pérez"), update("vehicleId", "territory", "Territory"), update("timeframe", "0-30", "30 días"), update("intention", "advance", "avanzar"), update("capacity", "ready", "recursos"), update("budget", "500000", "500000"), update("branch", "inexistente", text), update("phone", "123", text), update("email", "ana@example.com", "cita inventada"), update("tradeIn", "sí", text)] };
    };
    const text = "Ana Pérez quiere Territory en 30 días, avanzar; tengo recursos y 500000";
    const result = await service.sendMessage(id, { text, requestId: "one" });
    assert.equal(result.customer.name, "Ana Pérez");
    assert.equal(result.opportunity.vehicleId, "territory");
    assert.equal(result.opportunity.answers.budget, 500000);
    assert.equal(result.opportunity.score, null);
    assert.equal(result.opportunity.answers.branch, undefined);
    assert.equal(result.customer.phone, undefined);
    assert.equal(result.customer.email, undefined);
    assert.equal(result.opportunity.answers.tradeIn, undefined);
    assert.equal(result.evaluations.length, 0);
    assert.equal(result.opportunity.answerSources.name, result.messages[1].id);
    assert.equal((await service.sendMessage(id, { text, requestId: "one" })).messages.length, 3);
    assert.equal(agent.calls, 1);
    await assert.rejects(service.sendMessage(id, { text: "otro", requestId: "one" }), code("REQUEST_ID_CONFLICT"));
  } finally { (await repo.close()); }
});

test("unknown y declined vacían valores; controles reactivan pendientes", async () => {
  const { repo, agent, service, id } = (await setup());
  try {
    let updates = [update("payment", "credit", "crédito"), update("downPayment", "10000", "10000"), update("tradeIn", "true", "sí"), update("tradeInBrand", "Ford", "Ford")];
    agent.run = async () => ({ message: "Gracias", updates });
    await service.sendMessage(id, { text: "crédito 10000 sí Ford", requestId: "1" });
    updates = [update("downPayment", null, "no sé el enganche", "unknown"), update("budget", null, "no digo el presupuesto", "declined"), update("capacity", "ready", "no sé", "unknown")];
    let result = await service.sendMessage(id, { text: "no sé el enganche, no digo el presupuesto", requestId: "2" });
    assert.equal(result.opportunity.answers.downPayment, undefined);
    assert.equal(result.opportunity.collection.downPayment, "unknown");
    assert.equal(result.opportunity.collection.budget, "declined");
    assert.equal(result.opportunity.collection.capacity, "pending");
    updates = [update("payment", "cash", "contado"), update("tradeIn", "false", "sin auto"), update("downPayment", "9", "9")];
    result = await service.sendMessage(id, { text: "contado sin auto 9", requestId: "3" });
    assert.equal(result.opportunity.collection.downPayment, "not_applicable");
    assert.equal(result.opportunity.answers.tradeInBrand, undefined);
    assert.equal(result.opportunity.collection.tradeInBrand, "not_applicable");
    updates = [update("payment", "credit", "crédito"), update("tradeIn", "true", "sí")];
    result = await service.sendMessage(id, { text: "crédito sí", requestId: "4" });
    assert.equal(result.opportunity.collection.downPayment, "pending");
    assert.equal(result.opportunity.collection.tradeInBrand, "pending");
    assert.equal(result.opportunity.answers.downPayment, undefined);
    await assert.rejects(service.sendMessage(id, { text: "crédito 10000 sí Ford", requestId: "1" }), code("STALE_REQUEST"));
  } finally { (await repo.close()); }
});

test("fallo, reintento y envíos simultáneos", async () => {
  const { repo, agent, service, id } = (await setup());
  try {
    agent.run = async () => { throw new Error("secret provider body"); };
    await assert.rejects(service.sendMessage(id, { text: "Hola", requestId: "1" }), code("AI_PROCESSING_FAILED"));
    assert.equal((await service.detail(id)).messages.at(-1)?.status, "error");
    let release!: (value: AgentOutput) => void;
    agent.run = () => new Promise(resolve => { release = resolve; });
    const pending = service.sendMessage(id, { text: "Hola", requestId: "1" });
    await assert.rejects(service.sendMessage(id, { text: "Hola", requestId: "1" }), code("MESSAGE_IN_PROGRESS"));
    await assert.rejects(service.sendMessage(id, { text: "otro", requestId: "2" }), code("MESSAGE_IN_PROGRESS"));
    while (!release) await new Promise<void>(resolve => setImmediate(resolve));
    release({ message: "Hola", updates: [] });
    const result = await pending;
    assert.equal(result.messages.filter(m => m.role === "user").length, 1);
    assert.equal(result.messages.at(-1)?.role, "assistant");
    assert.equal(result.evaluations.length, 0);
  } finally { (await repo.close()); }
});

test("conflictos de teléfono y correo revierten todas las actualizaciones", async () => {
  const { repo, agent, service, id } = (await setup());
  try {
    agent.run = async () => ({ message: "ok", updates: [update("phone", "5512345678", "5512345678"), update("email", "ana@example.com", "ana@example.com")] });
    const first = await service.sendMessage(id, { text: "5512345678 ana@example.com", requestId: "1" });
    const other = (await service.createConversation()).opportunity.id;
    for (const field of ["phone", "email"] as const) {
      const value = first.customer[field]!;
      agent.run = async () => ({ message: "ok", updates: [update("name", "Otro Cliente", "Otro"), update(field, value, value)] });
      await assert.rejects(service.sendMessage(other, { text: `Otro ${value}`, requestId: field }), code("CONTACT_CONFLICT"));
      assert.equal((await service.detail(other)).customer.name, undefined);
      assert.equal((await service.detail(other)).evaluations.length, 0);
      assert.deepEqual((await service.detail(id)).customer, first.customer);
    }
  } finally { (await repo.close()); }
});

test("fallos antiguos no se reintentan; salida inválida no escribe datos", async () => {
  const { repo, agent, service, id } = (await setup());
  try {
    agent.run = async () => ({ message: "", updates: [] });
    await assert.rejects(service.sendMessage(id, { text: "primero", requestId: "old" }), code("AI_PROCESSING_FAILED"));
    assert.equal((await service.detail(id)).evaluations.length, 0);
    agent.run = async () => ({ message: "Gracias", updates: [] });
    await service.sendMessage(id, { text: "segundo", requestId: "new" });
    await assert.rejects(service.sendMessage(id, { text: "primero", requestId: "old" }), code("STALE_REQUEST"));
    await assert.rejects(service.sendMessage(id, { text: " ", requestId: "empty" }), code("INVALID_MESSAGE"));
    agent.configured = false;
    await assert.rejects(service.sendMessage(id, { text: "tercero", requestId: "disabled" }), code("AI_NOT_CONFIGURED"));
    assert.equal((await service.detail(id)).messages.at(-1)?.status, "error");
  } finally { (await repo.close()); }
});

test("recopila y corrige respuestas sin calcular ni guardar calificaciones", async () => {
  const { repo, agent, service, id } = (await setup());
  try {
    let updates = [update('timeframe', null, 'no sé fecha', 'unknown'), update('intention', 'compare', 'comparo'), update('capacity', null, 'no sé recursos', 'unknown')];
    agent.run = async () => ({ message: 'Gracias', updates });
    const first = await service.sendMessage(id, { text: 'no sé fecha; comparo; no sé recursos', requestId: 'provisional' });
    assert.equal(first.opportunity.score, null);
    assert.equal(first.opportunity.grade, null);
    assert.equal(first.opportunity.status, 'conversing');
    assert.equal(first.opportunity.answers.timeframe, undefined);
    assert.equal(first.opportunity.answers.capacity, undefined);
    assert.equal(first.opportunity.collection.timeframe, 'unknown');
    assert.deepEqual(first.evaluations, []);
    updates = [update('timeframe', '0-30', '30 días'), update('capacity', 'ready', 'tengo recursos')];
    const corrected = await service.sendMessage(id, { text: '30 días; tengo recursos', requestId: 'correction' });
    assert.equal(corrected.opportunity.score, null);
    assert.equal(corrected.opportunity.grade, null);
    assert.deepEqual(corrected.evaluations, []);
    assert.equal(corrected.opportunity.collection.timeframe, 'answered');
    assert.equal(corrected.opportunity.collection.capacity, 'answered');
    assert.equal(corrected.evaluations.length, 0);
  } finally { (await repo.close()); }
});

test("servicio procesa registros anteriores sin collection y conserva evaluación antigua", async () => {
  const { repo, agent, service, id } = (await setup());
  try {
    const old = (await service.detail(id)).opportunity;
    Object.assign(old.answers, { timeframe: '0-30', intention: 'compare', capacity: 'ready' });
    Reflect.deleteProperty(old, 'collection');
    (await repo.put('opportunities', old));
    const historical = { id: 'old', opportunityId: id, score: null, grade: null, ruleVersion: 1, breakdown: { Temporalidad: 0, Intención: 15, Capacidad: 0 }, createdAt: old.createdAt };
    (await repo.put('evaluations', historical));
    agent.run = async () => ({ message: 'Gracias', updates: [] });
    const result = await service.sendMessage(id, { text: 'Gracias', requestId: 'legacy' });
    assert.equal(result.opportunity.score, null);
    assert.deepEqual(result.evaluations, []);
    assert.deepEqual(await repo.get('evaluations', 'old'), historical);
  } finally { (await repo.close()); }
});

test('listado ordenado por actividad, una fila por oportunidad y ninguna escritura', async () => {
  const { repo, service, id } = (await setup());
  try {
    const first = (await service.detail(id));
    const second = (await service.createConversation());
    const third = (await service.createConversation());
    (await repo.put('customers', { ...first.customer, name: 'Ana Pérez' }));
    (await repo.put('opportunities', { ...first.opportunity, lastInteraction: '2026-10-01T00:00:00.000Z', score: null, grade: null }));
    (await repo.put('opportunities', { ...second.opportunity, customerId: first.customer.id, vehicleId: 'lobo', score: 0, grade: 'red', lastInteraction: '2026-10-03T00:00:00.000Z', collection: { timeframe: 'unknown', capacity: 'declined', intention: 'pending' } }));
    (await repo.put('opportunities', { ...third.opportunity, lastInteraction: '2026-10-02T00:00:00.000Z' }));
    (await repo.put('evaluations', { id: 'evaluation', opportunityId: second.opportunity.id, score: 0, grade: 'red', ruleVersion: 1, breakdown: {}, provisional: true, createdAt: '2026-10-03T00:00:00.000Z' }));
    const snapshot = () => JSON.stringify(['customers', 'opportunities', 'conversations', 'messages', 'evaluations', 'events', 'tasks', 'rules'].map(table => repo.all(table as Parameters<typeof repo.all>[0])));
    const before = snapshot();
    const rows = (await service.listOpportunities());
    assert.deepEqual(rows.map(row => row.id), [second.opportunity.id, third.opportunity.id, id]);
    assert.equal(rows.length, 3);
    assert.equal(rows.filter(row => row.customer.id === first.customer.id).length, 2);
    assert.equal(rows[0].customer.name, 'Ana Pérez');
    assert.equal(rows[0].score, null);
    assert.equal(rows[0].provisional, null);
    assert.equal(rows[2].score, null);
    assert.equal(rows[2].provisional, null);
    assert.equal(rows[1].customer.name, undefined);
    assert.equal(rows[0].collection.timeframe, 'unknown');
    assert.equal(rows[0].collection.capacity, 'declined');
    assert.equal(rows[0].collection.intention, 'pending');
    assert.ok(rows.every(row => !('messages' in row) && !('answers' in row) && !('conversation' in row)));
    const opened = (await service.detail(second.opportunity.id));
    assert.equal(opened.conversation.id, second.conversation.id);
    assert.deepEqual(opened.messages, second.messages);
    assert.equal(snapshot(), before);
  } finally { (await repo.close()); }
});

test('formato monetario no reescribe el texto del cliente ni mensajes anteriores', async () => {
  const { repo, agent, service, id } = (await setup());
  try {
    const previous = (await service.detail(id)).messages;
    const text = 'Presupuesto 500000, teléfono 5512345678, auto 2020, plazo 30 días.';
    agent.run = async () => ({ message: 'Registré tu presupuesto de $500,000.00 MXN.', updates: [update('budget', '500000', '500000')] });
    const result = await service.sendMessage(id, { text, requestId: 'money-format' });
    assert.equal(result.opportunity.answers.budget, 500000);
    assert.equal(result.messages.at(-2)?.text, text);
    assert.equal(result.messages.at(-1)?.text, 'Registré tu presupuesto de $500,000.00 MXN.');
    assert.deepEqual(result.messages.slice(0, previous.length), previous);
  } finally { (await repo.close()); }
});

test('teléfonos equivalentes se guardan sin separadores y producen conflicto entre clientes', async () => {
  const { repo, agent, service, id } = (await setup());
  try {
    let raw = '+52 (352) 145-5896';
    agent.run = async () => ({ message: 'Teléfono registrado: 352 145 5896.', updates: [update('phone', raw, raw)] });
    const first = await service.sendMessage(id, { text: raw, requestId: 'phone' });
    assert.equal(first.customer.phone, '3521455896');
    assert.equal((await repo.get('customers', first.customer.id))?.phone, '3521455896');
    assert.equal(first.messages.at(-2)?.text, raw);
    const other = (await service.createConversation());
    raw = '352 145 5896';
    await assert.rejects(service.sendMessage(other.opportunity.id, { text: raw, requestId: 'conflict' }), code('CONTACT_CONFLICT'));
    assert.equal((await service.detail(other.opportunity.id)).customer.phone, undefined);
    assert.deepEqual((await service.detail(id)).customer, first.customer);
    // A historical formatted contact must still block duplicates without rewriting it.
    (await repo.put('customers', { ...first.customer, phone: '+52 (352) 145-5896' }));
    await assert.rejects(service.sendMessage(other.opportunity.id, { text: raw, requestId: 'historical-conflict' }), code('CONTACT_CONFLICT'));
    assert.equal((await repo.get('customers', first.customer.id))?.phone, '+52 (352) 145-5896');
  } finally { (await repo.close()); }
});

test('teléfono inválido pide aclaración, conserva contacto previo y rechaza prefijos truncados', async () => {
  const { repo, agent, service, id } = (await setup());
  try {
    let value = '3521455896';
    let quote = value;
    agent.run = async () => ({ message: 'Guardado', updates: [update('phone', value, quote)] });
    await service.sendMessage(id, { text: quote, requestId: 'valid' });
    let request = 0;
    for (const invalid of ['+33 12345678', '+1 212 555 0123', '352145589', '35214558960']) {
      value = invalid;
      quote = invalid;
      const result = await service.sendMessage(id, { text: quote, requestId: `invalid-${request++}` });
      assert.equal(result.customer.phone, '3521455896');
      assert.equal(result.opportunity.collection.phone, 'answered');
      assert.match(result.messages.at(-1)!.text, /México.*10 dígitos/);
      assert.match(JSON.stringify(result.events.at(-1)?.data), /INVALID_PHONE/);
    }
    value = '2125550123'; // A faulty extractor removed the foreign country code.
    quote = '+1 212 555 0123';
    const other = (await service.createConversation());
    const rejected = await service.sendMessage(other.opportunity.id, { text: quote, requestId: 'foreign-prefix' });
    assert.equal(rejected.customer.phone, undefined);
    assert.equal(rejected.opportunity.collection.phone, 'pending');
    assert.match(rejected.messages.at(-1)!.text, /confirmar el número/);
    agent.run = async () => ({ message: 'De acuerdo', updates: [update('phone', null, 'prefiero no darlo', 'declined')] });
    const declined = await service.sendMessage(other.opportunity.id, { text: 'prefiero no darlo', requestId: 'declined' });
    assert.equal(declined.customer.phone, undefined);
    assert.equal(declined.opportunity.collection.phone, 'declined');
  } finally { (await repo.close()); }
});


test('startup retires local scores without changing contact, answers or historical evaluations', async () => {
  const { repo, agent, service, id } = await setup();
  try {
    const detail = await service.detail(id);
    const original = { ...detail.opportunity, score: 70, grade: 'yellow' as const, ruleVersion: 1, status: 'qualified' as const, answers: { budget: 900000 } };
    await repo.put('opportunities', original);
    const evaluation = { id: 'archived-score', opportunityId: id, score: 70, grade: 'yellow' as const, ruleVersion: 1, breakdown: {}, createdAt: original.createdAt };
    await repo.put('evaluations', evaluation);
    const reopened = new CRMService(repo, agent);
    await reopened.ready;
    const stored = await repo.get('opportunities', id);
    assert.equal(stored?.score, null);
    assert.equal(stored?.grade, null);
    assert.equal(stored?.ruleVersion, null);
    assert.equal(stored?.status, 'conversing');
    assert.deepEqual(stored?.answers, original.answers);
    assert.equal(stored?.lastInteraction, original.lastInteraction);
    assert.deepEqual(await repo.get('customers', detail.customer.id), detail.customer);
    assert.deepEqual(await repo.get('evaluations', evaluation.id), evaluation);
    assert.deepEqual((await reopened.detail(id)).evaluations, []);
    assert.equal((await reopened.listOpportunities())[0].score, null);
    assert.deepEqual(await repo.all('rules'), []);
  } finally { await repo.close(); }
});
