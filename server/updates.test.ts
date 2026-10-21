import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CRMService, ApiError } from './service.js';
import { SqliteRepository } from './repository.js';
import type { AgentOutput, ChatAgent } from './agent.js';
import { fieldLabels } from './updates.js';

type Update = AgentOutput['updates'][number];
const u = (field: Update['field'], value: string | null, quote: string, status: Update['status'] = 'answered', mode: Update['mode'] = 'apply'): Update => ({ field, value, quote, status, mode });
async function setup() {
  const repo = new SqliteRepository(':memory:');
  let output: AgentOutput = { message: 'Gracias', updates: [] };
  let calls = 0;
  const agent: ChatAgent = { configured: true, respond: async () => { calls++; return output; } };
  let service = new CRMService(repo, agent);
  const id = (await service.createConversation()).opportunity.id;
  let sequence = 0;
  return {
    repo, id, get service() { return service; }, get calls() { return calls; },
    restart() { service = new CRMService(repo, agent); },
    send(text: string, updates: Update[] = [], extra: Partial<AgentOutput> = {}, requestId = String(++sequence)) {
      output = { message: 'Gracias', updates, ...extra };
      return service.sendMessage(id, { text, requestId });
    },
  };
}
const cases: [Update['field'], string, string, string][] = [
  ['name', 'Ana Pérez', 'Ana López', 'x'],
  ['phone', '3521455896', '5512345678', '+1 212 555 0123'],
  ['email', 'ana@example.com', 'ana2@example.com', 'correo-invalido'],
  ['vehicleId', 'territory', 'lobo', 'inexistente'],
  ['timeframe', '0-30', '31-90', 'mañana'],
  ['intention', 'compare', 'advance', 'nada'],
  ['capacity', 'review', 'ready', 'mucha'],
  ['budget', '0', '500000', '-1'],
  ['downPayment', '0', '10000', '100000001'],
  ['payment', 'credit', 'cash', 'tarjeta'],
  ['tradeIn', 'true', 'false', 'quizás'],
  ['tradeInBrand', 'Ford', 'Toyota', ''],
  ['tradeInModel', 'Focus', 'Corolla', ''],
  ['tradeInYear', '2020', '2022', '2200'],
  ['branch', 'centro', 'norte', 'inexistente'],
  ['action', 'call', 'later', 'reserva-real'],
  ['questions', 'Tengo una duda', 'Tengo otra duda', 'x'.repeat(2001)],
];

test('brief refusal applies only to the requested contact field and allows a later update', async () => {
  for (const refusal of ['nop, no quiero', 'no gracias', 'no te lo doy']) {
    const f = (await setup());
    try {
      await f.send('I am Ana', [u('name', 'Ana', 'Ana')], { message: 'Can you share your email?', questionFields: ['email'] });
      let d = await f.send(refusal, [], { message: 'Can you share your email?', questionFields: ['email'] });
      assert.equal(d.opportunity.collection.email, 'declined', refusal);
      assert.equal(d.opportunity.collection.phone, 'pending', refusal);
      assert.equal(d.customer.email, undefined, refusal);
      assert.doesNotMatch(d.messages.at(-1)!.text, /email/i, refusal);
      assert.deepEqual(d.opportunity.pendingQuestion?.fields, ['phone'], refusal);
      d = await f.send('now, ana@example.com', [u('email', 'ana@example.com', 'ana@example.com')]);
      assert.equal(d.customer.email, 'ana@example.com', refusal);
      assert.equal(d.opportunity.collection.email, 'answered', refusal);
      assert.equal(d.opportunity.collection.phone, 'pending', refusal);
    } finally { (await f.repo.close()); }
  }
});

test('trade-in brand recognizes Volkswagen and the clear observed typo', async () => {
  for (const [text, quote] of [['es 2005 y es Volkswagen', 'Volkswagen'], ['es 2005 y es volsvaguen', 'volsvaguen']]) {
    const f = (await setup());
    try {
      await f.send('Tengo un bochito para dar a cuenta', [u('tradeIn', 'true', 'para dar a cuenta')]);
      const updates: Update[] = [u('tradeInYear', '2005', '2005')];
      if (quote === 'Volkswagen') updates.push(u('tradeInBrand', 'Volkswagen', quote));
      const d = await f.send(text, updates);
      assert.equal(d.opportunity.answers.tradeInBrand, 'Volkswagen', quote);
      assert.equal(d.opportunity.answers.tradeInYear, 2005, quote);
      assert.equal(d.opportunity.collection.tradeInBrand, 'answered', quote);
    } finally { (await f.repo.close()); }
  }
});

test('ambiguous trade-in brand is proposed for confirmation while the year is saved', async () => {
  const f = (await setup());
  try {
    await f.send('Tengo un bochito para dar a cuenta', [u('tradeIn', 'true', 'para dar a cuenta')]);
    const d = await f.send('tal vez volsvaguen; es 2005', [
      u('tradeInYear', '2005', '2005'),
    ]);
    assert.equal(d.opportunity.answers.tradeInBrand, undefined);
    assert.equal(d.opportunity.answers.tradeInYear, 2005);
    assert.equal(d.opportunity.proposals?.find(proposal => proposal.field === 'tradeInBrand')?.value, 'Volkswagen');
    assert.match(d.messages.at(-1)!.text, /Volkswagen/);
    assert.match(d.messages.at(-1)!.text, /confirmas/i);
  } finally { (await f.repo.close()); }
});

for (const [field, first, corrected, invalid] of cases) test(`matriz ${field}: rechazo, cambio de opinión, desconocido, corrección y validación`, async () => {
  const f = (await setup());
  try {
    await f.send('credit true', [u('payment', 'credit', 'credit'), u('tradeIn', 'true', 'true')]);
    const refused = `prefiero no compartir ${fieldLabels[field]}`;
    let d = await f.send(refused, [u(field, null, refused, 'declined')]);
    assert.equal(d.opportunity.collection[field], 'declined');
    d = await f.send(`Mi dato: ${first}`, [u(field, first, first)]);
    assert.equal(d.opportunity.collection[field], 'answered');
    const unknown = `no sé ${fieldLabels[field]}`;
    d = await f.send(unknown, [u(field, null, unknown, 'unknown')]);
    assert.equal(d.opportunity.collection[field], 'unknown');
    const value = () => field === 'name' || field === 'phone' || field === 'email' ? d.customer[field] : field === 'vehicleId' ? d.opportunity.vehicleId : d.opportunity.answers[field];
    assert.equal(value(), undefined);
    d = await f.send(`Corrección: ${corrected}`, [u(field, corrected, corrected)]);
    assert.equal(d.opportunity.collection[field], 'answered');
    const previous = value();
    d = await f.send(`Inválido: ${invalid || '(vacío)'}`, [u(field, invalid, invalid || '(vacío)')], { message: 'Guardé todo' });
    assert.equal(value(), previous);
    assert.doesNotMatch(d.messages.at(-1)!.text, /Guardé todo/);
    const history = JSON.stringify(d.events);
    assert.match(history, /transitions/);
    assert.match(history, /declined/);
    assert.match(history, /unknown/);
  } finally { (await f.repo.close()); }
});

test('ambigüedad no elimina valores; presupuesto no altera capacidad', async () => {
  const f = (await setup());
  try {
    await f.send('ready presupuesto 500000', [u('capacity', 'ready', 'ready'), u('budget', '500000', '500000')]);
    let d = await f.send('quizá no sé presupuesto', [u('budget', null, 'quizá no sé presupuesto', 'unknown')]);
    assert.equal(d.opportunity.answers.budget, 500000);
    d = await f.send('no tengo presupuesto definido', [u('budget', null, 'no tengo presupuesto definido', 'unknown'), u('capacity', 'unavailable', 'no tengo presupuesto definido')]);
    assert.equal(d.opportunity.answers.budget, undefined);
    assert.equal(d.opportunity.answers.capacity, 'ready');
    assert.equal(d.opportunity.collection.capacity, 'answered');
    await f.send('otra pregunta', [], { message: '¿Presupuesto y capacidad?', questionFields: ['budget', 'capacity'] });
    d = await f.send('no sé', [u('capacity', null, 'no sé', 'unknown')]);
    assert.equal(d.opportunity.answers.capacity, 'ready');
  } finally { (await f.repo.close()); }
});

for (const [field, value] of cases.filter(([field]) => !['payment', 'tradeIn'].includes(field))) test(`confirmación ${field}: evidencia original, recarga e idempotencia`, async () => {
  const f = (await setup());
  try {
    await f.send('credit true', [u('payment', 'credit', 'credit'), u('tradeIn', 'true', 'true')]);
    let d = await f.send(`Quizá ${value}`, [u(field, value, value, 'answered', 'propose')]);
    const proposal = d.opportunity.proposals!.at(-1)!;
    assert.equal(proposal.status, 'pending');
    assert.notEqual(d.opportunity.collection[field], 'answered');
    f.restart();
    d = await f.send('Sí', [u(field, 'sí', 'Sí')], {}, 'confirm-once');
    assert.equal(d.opportunity.collection[field], 'answered');
    assert.equal(d.opportunity.proposals!.at(-1)?.status, 'confirmed');
    assert.equal(d.opportunity.answerSources[field], proposal.sourceMessageId);
    assert.equal(d.opportunity.proposals!.at(-1)?.resolvedByMessageId, d.messages.at(-2)?.id);
    assert.equal(d.opportunity.proposals!.at(-1)?.resolutionQuote, 'Sí');
    const calls = f.calls;
    const repeated = await f.send('Sí', [], {}, 'confirm-once');
    assert.equal(f.calls, calls);
    assert.equal(repeated.messages.length, d.messages.length);
    assert.equal(repeated.evaluations.length, d.evaluations.length);
  } finally { (await f.repo.close()); }
});

test('propuestas múltiples, obsoletas, reemplazadas y rechazo a compartir', async () => {
  const f = (await setup());
  try {
    let d = await f.send('ana@example.com 3521455896', [u('email', 'ana@example.com', 'ana@example.com', 'answered', 'propose'), u('phone', '3521455896', '3521455896', 'answered', 'propose')]);
    assert.equal(d.opportunity.proposals!.filter(p => p.status === 'pending').length, 2);
    d = await f.send('sí');
    assert.equal(d.customer.phone, undefined);
    assert.equal(d.customer.email, undefined);
    assert.match(d.messages.at(-1)!.text, /Qué dato quieres confirmar/);
    await f.send('ana@example.com', [u('email', 'ana@example.com', 'ana@example.com', 'answered', 'propose')]);
    await f.send('otra pregunta');
    d = await f.send('confirmo', [u('email', 'ana@example.com', 'confirmo')]);
    assert.equal(d.customer.email, undefined);
    await f.send('3521455896', [u('phone', '3521455896', '3521455896', 'answered', 'propose')]);
    d = await f.send('corrijo 5512345678', [u('phone', '5512345678', '5512345678')]);
    assert.equal(d.customer.phone, '5512345678');
    assert.equal(d.opportunity.proposals!.at(-1)?.status, 'superseded');
    await f.send('3521455896', [u('phone', '3521455896', '3521455896', 'answered', 'propose')]);
    d = await f.send('prefiero no dar mi teléfono', [u('phone', null, 'prefiero no dar mi teléfono', 'declined')]);
    assert.equal(d.customer.phone, undefined);
    assert.equal(d.opportunity.proposals!.at(-1)?.status, 'cancelled');
    d = await f.send('sí');
    assert.equal(d.customer.phone, undefined);
    await f.send('ana@example.com', [u('email', 'ana@example.com', 'ana@example.com', 'answered', 'propose')]);
    d = await f.send('no');
    assert.equal(d.opportunity.proposals!.at(-1)?.status, 'rejected');
    assert.equal(d.opportunity.collection.email, 'pending');
  } finally { (await f.repo.close()); }
});

test('dependencias retiran valores y propuestas sin restaurarlos al reactivarse', async () => {
  const f = (await setup());
  try {
    await f.send('credit true 10000 Ford Focus 2020', [u('payment', 'credit', 'credit'), u('tradeIn', 'true', 'true'), u('downPayment', '10000', '10000'), u('tradeInBrand', 'Ford', 'Ford'), u('tradeInModel', 'Focus', 'Focus'), u('tradeInYear', '2020', '2020')]);
    await f.send('20000', [u('downPayment', '20000', '20000', 'answered', 'propose')]);
    let d = await f.send('cash false', [u('payment', 'cash', 'cash'), u('tradeIn', 'false', 'false')]);
    for (const field of ['downPayment', 'tradeInBrand', 'tradeInModel', 'tradeInYear'] as const) {
      assert.equal(d.opportunity.answers[field], undefined);
      assert.equal(d.opportunity.collection[field], 'not_applicable');
    }
    assert.equal(d.opportunity.proposals!.filter(p => p.status === 'pending').length, 0);
    d = await f.send('credit true', [u('payment', 'credit', 'credit'), u('tradeIn', 'true', 'true')]);
    for (const field of ['downPayment', 'tradeInBrand', 'tradeInModel', 'tradeInYear'] as const) {
      assert.equal(d.opportunity.answers[field], undefined);
      assert.equal(d.opportunity.collection[field], 'pending');
    }
    assert.match(JSON.stringify(d.events), /10000/);
  } finally { (await f.repo.close()); }
});

test('conflicto sobre confirmación: revalida contactos sin fusionar ni escribir resultados parciales', async () => {
  for (const [field, value] of [['phone', '3521455896'], ['email', 'ana@example.com']] as const) {
    const f = (await setup());
    try {
      await f.send(value, [u(field, value, value, 'answered', 'propose')]);
      const other = (await f.service.createConversation());
      (await f.repo.put('customers', { ...other.customer, [field]: value }));
      const before = (await f.service.detail(f.id));
      await assert.rejects(f.send('confirmo'), error => error instanceof ApiError && error.code === 'CONTACT_CONFLICT');
      const after = (await f.service.detail(f.id));
      assert.deepEqual(after.customer, before.customer);
      assert.deepEqual(after.opportunity.proposals, before.opportunity.proposals);
      assert.equal(after.evaluations.length, before.evaluations.length);
      assert.equal((await f.repo.get('customers', other.customer.id))![field], value);
    } finally { (await f.repo.close()); }
  }
});

test('preguntas múltiples no resuelven no sé ni sí; única pregunta tradeIn admite booleano', async () => {
  const f = (await setup());
  try {
    await f.send('Hola', [], { message: '¿Cuál es tu presupuesto y capacidad?', questionFields: ['budget', 'capacity'] });
    let d = await f.send('no sé', [u('budget', null, 'no sé', 'unknown'), u('capacity', null, 'no sé', 'unknown')]);
    assert.equal(d.opportunity.collection.budget, 'pending');
    assert.equal(d.opportunity.collection.capacity, 'pending');
    await f.send('Hola', [], { message: '¿Tienes vehículo a cuenta?', questionFields: ['tradeIn'] });
    d = await f.send('sí');
    assert.equal(d.opportunity.answers.tradeIn, true);
  } finally { (await f.repo.close()); }
});

test('correcciones y rechazos mantienen la recopilación sin puntuaciones', async () => {
  const f = (await setup());
  try {
    let d = await f.send('no sé fecha, compare, no sé recursos', [u('timeframe', null, 'no sé fecha', 'unknown'), u('intention', 'compare', 'compare'), u('capacity', null, 'no sé recursos', 'unknown')]);
    assert.equal(d.opportunity.score, null);
    assert.deepEqual(d.evaluations, []);
    assert.match(d.opportunity.nextAction, /Recopilar/);
    assert.equal(d.opportunity.collection.phone, 'pending');
    const history = d.evaluations[0];
    d = await f.send('corrijo 0-30 ready', [u('timeframe', '0-30', '0-30'), u('capacity', 'ready', 'ready')]);
    assert.equal(d.opportunity.score, null);
    assert.deepEqual(d.evaluations, []);
    assert.deepEqual(d.evaluations[0], history);
    d = await f.send('prefiero no compartir mi intención', [u('intention', null, 'prefiero no compartir mi intención', 'declined')]);
    assert.equal(d.opportunity.score, null);
    assert.deepEqual(d.evaluations, []);
    assert.equal(d.opportunity.answers.intention, undefined);
  } finally { (await f.repo.close()); }
});

test('la ambigüedad propone sin sustituir; confirmar revalida la evidencia original', async () => {
  const f = (await setup());
  try {
    await f.send('Presupuesto 10000', [u('budget', '10000', '10000')]);
    let d = await f.send('Quizá presupuesto 20000', [u('budget', '20000', '20000')]);
    assert.equal(d.opportunity.answers.budget, 10000);
    assert.equal(d.opportunity.proposals!.at(-1)?.status, 'pending');
    d = await f.send('correcto');
    assert.equal(d.opportunity.answers.budget, 20000);
    // Isolated damaged proposal: source quote no longer backs the candidate.
    d = await f.send('3521455896', [u('phone', '3521455896', '3521455896', 'answered', 'propose')]);
    const candidate = d.opportunity.proposals!.at(-1)!;
    candidate.value = '5512345678';
    (await f.repo.put('opportunities', d.opportunity));
    d = await f.send('confirmo');
    assert.equal(d.customer.phone, undefined);
    assert.equal(d.opportunity.proposals!.at(-1)?.status, 'cancelled');
    assert.match(d.messages.at(-1)!.text, /México/);
  } finally { (await f.repo.close()); }
});

test('rechazos ambiguos o petición de conservar no borran contacto', async () => {
  const f = (await setup());
  try {
    await f.send('3521455896 ana@example.com', [u('phone', '3521455896', '3521455896'), u('email', 'ana@example.com', 'ana@example.com')]);
    let d = await f.send('no sé si dar mi teléfono', [u('phone', null, 'no sé si dar mi teléfono', 'declined')]);
    assert.equal(d.customer.phone, '3521455896');
    d = await f.send('no quiero cambiar mi correo', [u('email', null, 'no quiero cambiar mi correo', 'declined')]);
    assert.equal(d.customer.email, 'ana@example.com');
    await f.send('otro@example.com', [u('email', 'otro@example.com', 'otro@example.com', 'answered', 'propose')]);
    d = await f.send('otra pregunta', [], { message: 'Ya guardé la propuesta' });
    assert.equal(d.customer.email, 'ana@example.com');
    assert.doesNotMatch(d.messages.at(-1)!.text, /Ya guardé/);
  } finally { (await f.repo.close()); }
});

test('regresión: más adelante pide precisión sin fijar plazo ni mostrar error técnico', async () => {
  for (const interpretation of ['90+', 'undefined', null] as const) {
    const f = (await setup());
    try {
      await f.send('hola', [], { message: '¿Comprarías pronto o más adelante?', questionFields: ['timeframe'] });
      const d = await f.send('más adelante', interpretation ? [u('timeframe', interpretation, 'más adelante')] : [], { message: 'Plazo registrado' });
      assert.equal(d.opportunity.answers.timeframe, undefined);
      assert.equal(d.opportunity.collection.timeframe, 'pending');
      assert.equal(d.messages.at(-1)?.text, '¿En más de tres meses o todavía sin fecha?');
      assert.equal(d.messages.at(-2)?.status, 'complete');
      const clarified = await f.send('cuando pasen cuatro meses', [u('timeframe', '90+', 'cuando pasen cuatro meses')]);
      assert.equal(clarified.opportunity.answers.timeframe, '90+');
    } finally { (await f.repo.close()); }
  }
});

for (const text of ['500000', '500,000', '$500,000', '500 mil']) test(`regresión presupuesto: ${text} equivale a 500000 con cita intacta`, async () => {
  const f = (await setup());
  try {
    await f.send('hola', [], { message: '¿Cuál es tu presupuesto total?', questionFields: ['budget'] });
    const d = await f.send(text, [u('budget', '500000', text)]);
    assert.equal(d.opportunity.answers.budget, 500000);
    assert.equal(d.opportunity.answers.downPayment, undefined);
    assert.equal(d.opportunity.answers.capacity, undefined);
    assert.equal(d.opportunity.proposals?.filter(p => p.status === 'pending').length, 0);
    assert.equal(d.messages.at(-2)?.text, text);
    const data = d.events.at(-1)?.data as { accepted: { quote: string }[] };
    assert.equal(data.accepted[0].quote, text);
  } finally { (await f.repo.close()); }
});

test('regresión montos: rangos, mensualidad y enganche no se convierten en presupuesto', async () => {
  for (const text of ['entre 500 y 600 mil', '500 mil a 600 mil', '500,000–600,000', '500 mil o 600 mil', 'mensualidad de 500 mil', 'enganche de 500 mil']) {
    const f = (await setup());
    try {
      await f.send('hola', [], { message: '¿Cuál es tu presupuesto total?', questionFields: ['budget'] });
      const quote = text.includes('500 mil') ? '500 mil' : text;
      const d = await f.send(text, [u('budget', '500000', quote)], { message: 'Guardado' });
      assert.equal(d.opportunity.answers.budget, undefined, text);
      assert.match(d.messages.at(-1)!.text, /presupuesto total/);
      assert.doesNotMatch(d.messages.at(-1)!.text, /error|INVALID|extracción|Guardado/i);
    } finally { (await f.repo.close()); }
  }
});

test('regresión montos: presupuesto y enganche explícitos separados conservan sus conceptos', async () => {
  const f = (await setup());
  try {
    await f.send('crédito', [u('payment', 'credit', 'crédito')]);
    const d = await f.send('presupuesto 500 mil y enganche 100 mil', [u('budget', '500000', 'presupuesto 500 mil'), u('downPayment', '100000', 'enganche 100 mil')]);
    assert.equal(d.opportunity.answers.budget, 500000);
    assert.equal(d.opportunity.answers.downPayment, 100000);
  } finally { (await f.repo.close()); }
});

test('regresión confirmación: pregunta del agente crea la propuesta única usando el mecanismo existente', async () => {
  const f = (await setup());
  try {
    await f.send('hola', [], { message: '¿Cuál es tu presupuesto total?', questionFields: ['budget'] });
    let d = await f.send('500 mil', [u('budget', '500000', '500 mil')], { message: '¿Confirmas un presupuesto de $500,000.00 MXN?', questionFields: ['budget'] });
    assert.equal(d.opportunity.answers.budget, undefined);
    const candidate = d.opportunity.proposals!.at(-1)!;
    assert.equal(candidate.status, 'pending');
    assert.equal(candidate.value, '500000');
    assert.equal(candidate.quote, '500 mil');
    assert.equal(candidate.askedMessageId, d.messages.at(-1)?.id);
    f.restart();
    d = await f.send('sí', [], {}, 'confirm-amount');
    assert.equal(d.opportunity.answers.budget, 500000);
    assert.equal(d.opportunity.proposals!.at(-1)?.status, 'confirmed');
    assert.equal(d.opportunity.answerSources.budget, candidate.sourceMessageId);
    const repeated = await f.send('sí', [], {}, 'confirm-amount');
    assert.equal(repeated.messages.length, d.messages.length);
  } finally { (await f.repo.close()); }
});

test('regresión confirmación monetaria no depende de la palabra confirmar', async () => {
  const f = (await setup());
  try {
    let d = await f.send('500 mil', [u('budget', '500000', '500 mil')], { message: '¿Ese presupuesto de $500,000.00 MXN es el que quieres registrar?', questionFields: ['budget'] });
    assert.equal(d.opportunity.answers.budget, undefined);
    assert.equal(d.opportunity.proposals!.at(-1)?.status, 'pending');
    d = await f.send('sí');
    assert.equal(d.opportunity.answers.budget, 500000);
    assert.equal(d.opportunity.proposals!.at(-1)?.status, 'confirmed');
  } finally { (await f.repo.close()); }
});

test('regresión confirmación: sin candidato sustentado no solicita un sí que no puede procesar', async () => {
  const f = (await setup());
  try {
    let d = await f.send('hola', [], { message: '¿Confirmas tu presupuesto de $500,000.00 MXN?', questionFields: ['budget'] });
    assert.doesNotMatch(d.messages.at(-1)!.text, /confirmas/i);
    assert.match(d.messages.at(-1)!.text, /presupuesto total/);
    assert.equal(d.opportunity.proposals!.length, 0);
    d = await f.send('sí');
    assert.equal(d.opportunity.answers.budget, undefined);
  } finally { (await f.repo.close()); }
});

test('regresión contacto: rechazo seguido de dato válido no genera ciclos; Nop ese no no borra', async () => {
  const f = (await setup());
  try {
    await f.send('prefiero no dar mi teléfono ni correo', [u('phone', null, 'prefiero no dar mi teléfono', 'declined'), u('email', null, 'prefiero no dar mi teléfono ni correo', 'declined')]);
    let d = await f.send('3521455896 ana@example.com', [u('phone', '3521455896', '3521455896'), u('email', 'ana@example.com', 'ana@example.com')]);
    assert.equal(d.customer.phone, '3521455896');
    assert.equal(d.customer.email, 'ana@example.com');
    assert.equal(d.opportunity.collection.phone, 'answered');
    assert.equal(d.opportunity.collection.email, 'answered');
    assert.equal(d.opportunity.proposals!.filter(p => p.status === 'pending').length, 0);
    d = await f.send('Nop ese no', [u('phone', null, 'Nop ese no', 'declined'), u('email', null, 'Nop ese no', 'declined')], { message: 'Borré tus datos' });
    assert.equal(d.customer.phone, '3521455896');
    assert.equal(d.customer.email, 'ana@example.com');
    assert.match(d.messages.at(-1)!.text, /Qué dato quieres corregir/);
  } finally { (await f.repo.close()); }
});

test('regresión evidencia: cita inventada y magnitud distinta siguen rechazadas', async () => {
  const f = (await setup());
  try {
    let d = await f.send('500 mil', [u('budget', '500000', 'presupuesto de un millón')]);
    assert.equal(d.opportunity.answers.budget, undefined);
    d = await f.send('500 mil', [u('budget', '500', '500 mil')]);
    assert.equal(d.opportunity.answers.budget, undefined);
    d = await f.send('una respuesta', [u('timeframe', '90+', 'cita inexistente')]);
    assert.equal(d.opportunity.answers.timeframe, undefined);
  } finally { (await f.repo.close()); }
});

test('conversación: prueba de manejo registra solicitud y pregunta solamente dudas', async () => {
  const f = (await setup());
  try {
    const response = 'Perfecto, una prueba de manejo. ¿Tienes alguna duda que quieras dejar anotada para el asesor?';
    const d = await f.send('prueba de manejo', [u('action', 'test_drive', 'prueba de manejo'), u('questions', 'Sin dudas', 'prueba de manejo')], { message: response, questionFields: ['questions'] });
    assert.equal(d.opportunity.answers.action, 'test_drive');
    assert.equal(d.opportunity.answers.questions, undefined);
    assert.equal(d.opportunity.collection.questions, 'pending');
    assert.equal(d.messages.at(-1)?.text, response);
    assert.deepEqual(d.opportunity.pendingQuestion?.fields, ['questions']);
    assert.equal(d.messages.at(-2)?.status, 'complete');
  } finally { (await f.repo.close()); }
});

for (const text of ['No tengo dudas, gracias', 'ninguna, gracias', 'no hay preguntas', 'por ahora no tengo dudas', 'sin dudas', 'ninguna duda, muchas gracias']) test(`conversación: ausencia explícita de dudas resuelta (${text})`, async () => {
  const f = (await setup());
  try {
    await f.send('prueba de manejo', [u('action', 'test_drive', 'prueba de manejo')]);
    let d = await f.send(text, [u('questions', null, text, 'unknown')], { message: '¿Confirmas que no tienes dudas? Un asesor te contactará.', questionFields: ['questions'] });
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.equal(d.opportunity.proposals!.filter(p => p.status === 'pending').length, 0);
    assert.equal(d.opportunity.pendingQuestion, undefined);
    assert.match(d.messages.at(-1)!.text, /Sin dudas/);
    assert.match(d.messages.at(-1)!.text, /prueba de manejo; pendiente de confirmación/);
    assert.doesNotMatch(d.messages.at(-1)!.text, /\?|contactar|notific|sigue sin validarse|aclarar dudas|Ford|Mustang/i);
    assert.equal(d.messages.at(-2)?.text, text);
    f.restart();
    d = await f.send('Gracias', [], { message: '¿Tienes alguna otra duda?', questionFields: ['questions'] });
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');
    assert.doesNotMatch(d.messages.at(-1)!.text, /\?/);
  } finally { (await f.repo.close()); }
});

test('conversación: ninguna sin contexto y sin dudas como muletilla no resuelven questions', async () => {
  const f = (await setup());
  try {
    let d = await f.send('ninguna, gracias');
    assert.equal(d.opportunity.answers.questions, undefined);
    d = await f.send('Sin dudas quiero saber el precio', [u('questions', 'Sin dudas', 'Sin dudas quiero saber el precio')]);
    assert.equal(d.opportunity.answers.questions, undefined);
    const question = '¿Qué condiciones tiene la promoción?';
    d = await f.send(question, [u('questions', question, question)]);
    assert.equal(d.opportunity.answers.questions, question);
    assert.equal(d.opportunity.proposals!.filter(p => p.status === 'pending').length, 0);
  } finally { (await f.repo.close()); }
});

test('conversación: pregunta de dudas anterior sin metadatos conserva contexto', async () => {
  const f = (await setup());
  try {
    await f.send('hola', [], { message: '¿Tienes alguna duda que quieras dejar anotada para el asesor?' });
    assert.equal((await f.service.detail(f.id)).opportunity.pendingQuestion, undefined);
    const d = await f.send('ninguna, gracias');
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.doesNotMatch(d.messages.at(-1)!.text, /\?/);
  } finally { (await f.repo.close()); }
});

test('conversación: marca inferida rechazada, modelo y año conservados y pregunta contextual', async () => {
  const f = (await setup());
  try {
    await f.send('tengo vehículo a cuenta', [u('tradeIn', 'true', 'tengo vehículo a cuenta')]);
    const d = await f.send('un Mustang 2015', [u('tradeInBrand', 'Ford', 'un Mustang 2015'), u('tradeInModel', 'Mustang', 'un Mustang 2015'), u('tradeInYear', '2015', 'un Mustang 2015')], { message: 'Registré tu Ford Mustang 2015. Un asesor te contactará.' });
    assert.equal(d.opportunity.answers.tradeInBrand, undefined);
    assert.equal(d.opportunity.answers.tradeInModel, 'Mustang');
    assert.equal(d.opportunity.answers.tradeInYear, 2015);
    assert.equal(d.opportunity.collection.tradeInBrand, 'pending');
    assert.match(d.messages.at(-1)!.text, /anoté Mustang 2015/);
    assert.match(d.messages.at(-1)!.text, /¿De qué marca es tu Mustang 2015\?/);
    assert.doesNotMatch(d.messages.at(-1)!.text, /Ford|marca a cuenta|aclarar|contactar|notific|sin validarse/i);
    const clarified = await f.send('Ford', [u('tradeInBrand', 'Ford', 'Ford')]);
    assert.equal(clarified.opportunity.answers.tradeInBrand, 'Ford');
  } finally { (await f.repo.close()); }
});

test('conversación: conserva una respuesta del agente segura y conectada ante rechazo parcial', async () => {
  const f = (await setup());
  try {
    await f.send('true', [u('tradeIn', 'true', 'true')]);
    const safe = 'Entendido, un Mustang 2015. ¿De qué marca es tu Mustang 2015?';
    const d = await f.send('un Mustang 2015', [u('tradeInBrand', 'Ford', 'un Mustang 2015'), u('tradeInModel', 'Mustang', 'un Mustang 2015'), u('tradeInYear', '2015', 'un Mustang 2015')], { message: safe, questionFields: ['tradeInBrand'] });
    assert.equal(d.messages.at(-1)?.text, safe);
    assert.equal(d.opportunity.answers.tradeInBrand, undefined);
    assert.equal(d.opportunity.answers.tradeInYear, 2015);
  } finally { (await f.repo.close()); }
});

test('conversación: cierre usa valores guardados y no propuestas pendientes ni inferencias', async () => {
  const f = (await setup());
  try {
    await f.send('500 mil', [u('budget', '500000', '500 mil')]);
    await f.send('prueba de manejo', [u('action', 'test_drive', 'prueba de manejo')]);
    let d = await f.send('No tengo dudas, gracias', [u('questions', 'Ninguna pregunta', 'No tengo dudas, gracias')], { message: 'Resumen: Ford Lobo, presupuesto $900,000 y cita confirmada. Un asesor te llamará.' });
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');
    assert.match(d.messages.at(-1)!.text, /\$500,000\.00 MXN/);
    assert.doesNotMatch(d.messages.at(-1)!.text, /Lobo|900|cita confirmada|asesor te/);
    d = await f.send('prueba de manejo', [u('action', 'test_drive', 'prueba de manejo')], { message: '¿Tienes alguna duda para el asesor?' });
    assert.doesNotMatch(d.messages.at(-1)!.text, /\?/);
    assert.equal(d.opportunity.collection.questions, 'answered');
  } finally { (await f.repo.close()); }
});

test('tono: una duda o vacilación independiente no convierte datos explícitos en propuestas', async () => {
  const f = (await setup());
  try {
    const text = 'Mi presupuesto es 550mil; quizá después decida. ¿Qué colores tienen?';
    const response = 'Anoté tu presupuesto de $550,000.00 MXN. No tengo inventario de colores; tu consulta queda anotada. ¿Cómo prefieres pagar?';
    const d = await f.send(text, [u('budget', '550000', '550mil'), u('questions', '¿Qué colores tienen?', '¿Qué colores tienen?')], { message: response, questionFields: ['payment'] });
    assert.equal(d.opportunity.answers.budget, 550000);
    assert.equal(d.opportunity.answers.questions, '¿Qué colores tienen?');
    assert.equal(d.opportunity.proposals!.length, 0);
    assert.equal(d.messages.at(-1)!.text, response);
  } finally { (await f.repo.close()); }
});

test('tono: “no tengo más dudas” retira la consulta actual tras recarga y conserva el historial', async () => {
  const f = (await setup());
  try {
    const query = '¿Qué colores tienen?';
    let d = await f.send(query, [u('questions', query, query)], { message: 'No tengo inventario de colores. Dejé anotada tu consulta. ¿Qué colores te gustaría consultar?', questionFields: ['questions'] });
    assert.equal(d.messages.at(-1)!.text, 'No tengo inventario de colores. Dejé anotada tu consulta.');
    const source = d.opportunity.answerSources.questions;
    f.restart();
    d = await f.send('no tengo más dudas, gracias', [], { message: 'Con gusto. Tu consulta queda anotada.' });
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');
    assert.notEqual(d.opportunity.answerSources.questions, source);
    assert.match(d.messages.at(-1)!.text, /Sin dudas/);
    assert.doesNotMatch(d.messages.at(-1)!.text, /consulta queda anotada|al asesor/i);
    assert.equal(d.opportunity.pendingQuestion, undefined);
    assert.equal(d.messages.filter(message => message.role === 'user' && message.text === query).length, 1);
    const event = d.events.at(-1)!;
    assert.match(JSON.stringify(event), /Sin dudas/);
  } finally { (await f.repo.close()); }
});

test('tono: respuesta útil y reconocimiento válido sobreviven a correo inválido independiente', async () => {
  const f = (await setup());
  try {
    const response = 'No tengo inventario de colores. Anoté tu presupuesto de $500,000.00 MXN. ¿Me compartes tu correo completo?';
    const d = await f.send('500 mil y mi correo es alexa@', [u('budget', '500000', '500 mil'), u('email', 'alexa@', 'alexa@')], { message: response, questionFields: ['email'] });
    assert.equal(d.customer.email, undefined);
    assert.equal(d.opportunity.answers.budget, 500000);
    assert.equal(d.messages.at(-1)!.text, response);
  } finally { (await f.repo.close()); }
});

test('tono: prueba de manejo no impone dudas si hay otra continuación contextual', async () => {
  const f = (await setup());
  try {
    const response = 'Anoté tu interés en una prueba de manejo, pendiente de confirmación. ¿Qué sucursal prefieres?';
    const d = await f.send('prueba de manejo', [u('action', 'test_drive', 'prueba de manejo')], { message: response, questionFields: ['branch'] });
    assert.equal(d.opportunity.answers.action, 'test_drive');
    assert.equal(d.messages.at(-1)!.text, response);
    assert.deepEqual(d.opportunity.pendingQuestion?.fields, ['branch']);
  } finally { (await f.repo.close()); }
});

test('tono: visita, vehículo propio y horario no se convierten en fecha de compra ni cita', async () => {
  const f = (await setup());
  try {
    let response = 'Podemos registrar tu interés en una visita, pendiente de confirmación. ¿Qué sucursal prefieres?';
    let d = await f.send('Quiero ir a verlo mañana', [u('action', 'appointment', 'Quiero ir a verlo mañana')], { message: response, questionFields: ['branch'] });
    assert.equal(d.opportunity.answers.timeframe, undefined);
    assert.equal(d.messages.at(-1)!.text, response);
    response = 'Entendido, tienes una Explorer 2021. ¿Quieres entregarla a cuenta?';
    d = await f.send('Tengo una Explorer 2021', [], { message: response, questionFields: ['tradeIn'] });
    assert.equal(d.opportunity.answers.tradeIn, undefined);
    assert.equal(d.messages.at(-1)!.text, response);
    response = 'Anoté la sucursal Sur. La hora no queda agendada en esta conversación. ¿Para qué día te gustaría solicitar la visita?';
    d = await f.send('Sur a las 5', [u('branch', 'sur', 'Sur')], { message: response });
    assert.equal(d.opportunity.answers.branch, 'sur');
    assert.equal(d.opportunity.answers.timeframe, undefined);
    assert.equal(d.messages.at(-1)!.text, response);
  } finally { (await f.repo.close()); }
});

for (const accumulated of [false, true]) test(`segunda duda: colores → precio → reformulación → cierre (extracción acumulada=${accumulated})`, async () => {
  const f = (await setup());
  try {
    await f.send('hola', [], { message: '¿Tienes alguna duda que quieras dejar anotada para el asesor?', questionFields: ['questions'] });
    const colors = '¿Sabes de qué colores hay?';
    const firstResponse = 'No dispongo de inventario de colores. Dejo anotada tu consulta para el asesor.';
    let d = await f.send(colors, [u('questions', colors, colors)], { message: firstResponse });
    assert.equal(d.opportunity.answers.questions, colors);
    assert.equal(d.messages.at(-1)!.text, firstResponse);
    const colorsMessageId = d.messages.at(-2)!.id;
    f.restart();

    const price = 'Otra duda, ¿sabes el precio?';
    const response = 'El catálogo de demostración tampoco incluye precios; el asesor debe confirmarlos. Dejo esa consulta junto con la de colores para que pueda revisarlas.';
    d = await f.send(price, [u('questions', accumulated ? `${colors}\n${price}` : price, price)], { message: response });
    const saved = `${colors}\n${price}`;
    assert.equal(d.opportunity.answers.questions, saved);
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.equal(d.messages.at(-1)!.text, response);
    assert.equal(d.opportunity.pendingQuestion, undefined);
    const priceMessageId = d.messages.at(-2)!.id;
    const audit = JSON.stringify(d.events);
    assert.ok(audit.includes(colorsMessageId));
    assert.ok(audit.includes(priceMessageId));
    assert.ok(audit.includes(price));
    assert.match(audit, /"quote":"Otra duda, ¿sabes el precio\?"/);

    for (const reformulation of ['¿Qué precio tiene?', 'El precio del vehículo']) {
      d = await f.send(reformulation, [u('questions', reformulation, reformulation)], {
        message: 'El asesor debe confirmar el precio; la consulta ya está anotada. ¿Tienes alguna duda que quieras dejar anotada para el asesor?',
        questionFields: ['questions'],
      });
      assert.equal(d.opportunity.answers.questions, saved);
      assert.equal(d.messages.at(-1)!.text, 'El asesor debe confirmar el precio; la consulta ya está anotada.');
      assert.equal(d.opportunity.pendingQuestion, undefined);
    }
    f.restart();
    const closing = 'Con gusto, conservo ambas consultas anotadas.';
    d = await f.send('No tengo más dudas', [], { message: closing });
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.equal(d.messages.at(-1)!.text, closing);
    assert.equal(d.messages.filter(message => message.role === 'user' && (message.text === colors || message.text === price)).length, 2);
    assert.equal((await f.service.detail(f.id)).opportunity.answers.questions, 'Sin dudas');
  } finally { (await f.repo.close()); }
});

test('segunda duda: acumulación no admite consultas inventadas ni descarta detalles distintos', async () => {
  const f = (await setup());
  try {
    const first = '¿Qué colores tienen?';
    await f.send(first, [u('questions', first, first)]);
    let d = await f.send('¿Qué precio tiene?', [u('questions', `${first}\n¿Aceptan descuentos?`, '¿Qué precio tiene?')], { message: 'Guardé tus dudas' });
    assert.equal(d.opportunity.answers.questions, first);
    assert.doesNotMatch(d.messages.at(-1)!.text, /Guardé/);
    d = await f.send('¿Qué precio tiene?', [u('questions', '¿Qué precio tiene?', 'cita inventada')]);
    assert.equal(d.opportunity.answers.questions, first);
    const price = '¿Qué precio tiene?';
    await f.send(price, [u('questions', price, price)]);
    const insurance = '¿Qué precio tiene el seguro?';
    d = await f.send(insurance, [u('questions', insurance, insurance)]);
    assert.equal(d.opportunity.answers.questions, `${first}\n${price}\n${insurance}`);
  } finally { (await f.repo.close()); }
});

test('tono: no insiste en un contacto rechazado y conserva agradecimiento contextual', async () => {
  const f = (await setup());
  try {
    await f.send('prefiero no compartir teléfono', [u('phone', null, 'prefiero no compartir teléfono', 'declined')]);
    let d = await f.send('gracias', [], { message: 'Con gusto. ¿Cuál es tu teléfono?', questionFields: ['phone'] });
    assert.equal(d.messages.at(-1)!.text, 'Con gusto.');
    assert.equal(d.opportunity.pendingQuestion, undefined);
    const response = 'Con gusto. Si deseas continuar después, aún falta conocer tu presupuesto.';
    d = await f.send('Todo chido, gracias', [], { message: response });
    assert.equal(d.messages.at(-1)!.text, response);
  } finally { (await f.repo.close()); }
});

test('duda de compra sin signos, con errores y varios temas se responde y queda para el asesor', async () => {
  const f = (await setup());
  try {
    const vehicle = 'Ford Bronco Sport';
    const query = 'sabes de que color hay disponobles y el precio aproximado';
    await f.send('Me interesa la Bronco Sport', [u('vehicleId', 'bronco', 'Bronco Sport')]);
    await f.send('Quiero solicitar una cita', [u('action', 'test_drive', 'solicitar una cita')], {
      message: 'Queda registrada tu solicitud de cita, pendiente de confirmación. ¿Tienes alguna duda que quieras dejar anotada para el asesor?',
      questionFields: ['questions'],
    });
    const response = `No puedo confirmar los colores disponibles ni el precio real de ${vehicle} con este catálogo; un asesor debe confirmarlos.`;
    const d = await f.send(query, [u('questions', query, query)], { message: response });
    assert.equal(d.opportunity.answers.questions, query);
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.equal(d.messages.at(-1)!.text, response);
    assert.match(d.messages.at(-1)!.text, /colores disponibles.*precio real.*asesor debe confirmarlos/);
    assert.doesNotMatch(d.messages.at(-1)!.text, /\$\s?\d|\b\d{2,}\b|disponible en (rojo|azul|blanco)/i);
    assert.doesNotMatch(d.messages.at(-1)!.text, /¿Tienes alguna duda/);
    assert.equal(d.opportunity.answers.action, 'test_drive');
    assert.match(d.opportunity.nextAction, /Recopilar:/);
  } finally { (await f.repo.close()); }
});

test('una duda sencilla sobre precio se responde y queda anotada', async () => {
  const f = (await setup());
  try {
    await f.send('Me interesa la Bronco Sport', [u('vehicleId', 'bronco', 'Bronco Sport')]);
    await f.send('hola', [], { message: '¿Tienes alguna duda que quieras dejar anotada para el asesor?', questionFields: ['questions'] });
    const question = '¿Cuál es el precio?';
    const response = 'El catálogo de demostración no incluye precios; un asesor debe confirmar el precio real de la Ford Bronco Sport.';
    const d = await f.send(question, [u('questions', question, question)], { message: response });
    assert.equal(d.opportunity.answers.questions, question);
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.equal(d.messages.at(-1)!.text, response);
    assert.doesNotMatch(d.messages.at(-1)!.text, /¿Tienes alguna duda/);
  } finally { (await f.repo.close()); }
});

test('una respuesta no interrogativa no se guarda como duda', async () => {
  const f = (await setup());
  try {
    await f.send('hola', [], { message: '¿Tienes alguna duda que quieras dejar anotada para el asesor?', questionFields: ['questions'] });
    const d = await f.send('Sí, gracias', [], { message: 'Con gusto.' });
    assert.equal(d.opportunity.answers.questions, undefined);
    assert.equal(d.opportunity.collection.questions, 'pending');
    assert.equal(d.messages.at(-1)!.text, 'Con gusto.');
  } finally { (await f.repo.close()); }
});

test('el resumen retira dudas resueltas y conserva la cita pendiente', async () => {
  const f = (await setup());
  try {
    const colors = 'sabes de que color hay disponibles';
    await f.send('Me interesa la Bronco Sport', [u('vehicleId', 'bronco', 'Bronco Sport')]);
    await f.send('Solicito una cita', [u('action', 'test_drive', 'Solicito una cita')]);
    let d = await f.send(colors, [u('questions', colors, colors)], { message: 'No puedo confirmar colores; dejo tu consulta para el asesor.' });
    const price = 'sabes el precio?';
    d = await f.send(price, [u('questions', price, price)], {
      message: 'El catálogo no incluye precios; el asesor debe confirmarlo. ¿Tienes alguna duda que quieras dejar anotada para el asesor?',
      questionFields: ['questions'],
    });
    const saved = `${colors}\n${price}`;
    assert.equal(d.opportunity.answers.questions, saved);
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.equal(d.messages.at(-1)!.text.includes('¿Tienes alguna duda'), false);

    d = await f.send('No tengo más dudas', [], { message: 'Tu cita está reservada.' });
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');
    assert.doesNotMatch(d.messages.at(-1)!.text, /Dudas para el asesor:/);
    assert.equal(d.messages.filter(message => message.role === 'user' && [colors, price].includes(message.text)).length, 2);
    assert.match(d.messages.at(-1)!.text, /pendiente de confirmación/);
    assert.doesNotMatch(d.messages.at(-1)!.text, /Tu cita está reservada/);
    const detail = await f.service.detail(f.id);
    assert.equal(detail.opportunity.answers.questions, 'Sin dudas');
    assert.equal(detail.opportunity.collection.questions, 'answered');
    assert.equal(detail.opportunity.answers.action, 'test_drive');
    assert.match(d.messages.at(-1)!.text, /Solicitud registrada:.*pendiente de confirmación/);
  } finally { (await f.repo.close()); }
});

test('resolver varias dudas y decir que no hay otras actualiza la ficha y evita repetir la pregunta', async () => {
  const f = (await setup());
  try {
    const saved = '¿Qué colores hay disponibles? ¿Cuál es el precio?';
    await f.send(saved, [u('questions', saved, saved)]);
    const resolution = 'Ya me confirmaron eso, se resolvieron las dudas de colores y precio; no tengo más dudas.';
    const d = await f.send(resolution, [], {
      message: 'Gracias por confirmarlo. ¿Tienes alguna duda que quieras dejar anotada para el asesor?',
      questionFields: ['questions'],
    });
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.equal(d.opportunity.pendingQuestion, undefined);
    assert.doesNotMatch(d.messages.at(-1)!.text, /¿Tienes alguna duda/);
    assert.equal(d.messages.filter(message => message.role === 'user' && message.text === saved).length, 1);
    assert.ok(d.events.some(event => JSON.stringify(event).includes(saved)));
  } finally { (await f.repo.close()); }
});

test('resolver una duda y plantear otra conserva únicamente la nueva consulta vigente', async () => {
  const f = (await setup());
  try {
    const oldQuestion = '¿Qué colores hay?';
    await f.send(oldQuestion, [u('questions', oldQuestion, oldQuestion)]);
    const newQuestion = '¿Qué condiciones hay para crédito?';
    const text = `Ya se resolvió la duda de colores; ${newQuestion}`;
    const d = await f.send(text, [u('questions', newQuestion, newQuestion)], { message: 'El asesor puede confirmar las condiciones. Dejo anotada esa consulta.' });
    assert.equal(d.opportunity.answers.questions, newQuestion);
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.equal(d.messages.filter(message => message.role === 'user' && message.text === oldQuestion).length, 1);
    assert.doesNotMatch(d.opportunity.answers.questions, /colores/);
  } finally { (await f.repo.close()); }
});

test('negativa breve después de la pregunta de dudas cierra el tema sin insistir', async () => {
  const f = (await setup());
  try {
    const previous = '¿Cuánto cuesta?';
    await f.send(previous, [u('questions', previous, previous)]);
    await f.send('hola', [], { message: '¿Tienes alguna duda que quieras dejar anotada para el asesor?', questionFields: ['questions'] });
    const text = 'No, ya se resolvieron y no tengo ninguna otra.';
    const d = await f.send(text, [], { message: '¿Tienes alguna duda que quieras dejar anotada para el asesor?', questionFields: ['questions'] });
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.equal(d.opportunity.pendingQuestion, undefined);
    assert.doesNotMatch(d.messages.at(-1)!.text, /¿Tienes alguna duda/);
  } finally { (await f.repo.close()); }
});

test('vehículo a cuenta conserva detalles durante la aclaración y los guarda al confirmar', async () => {
  const f = (await setup());
  try {
    await f.send('No tengo vehículo a cuenta', [u('tradeIn', 'false', 'No tengo vehículo a cuenta')]);
    const details = [
      u('tradeInBrand', 'Volkswagen', 'volsvaguen'),
      u('tradeInModel', 'Bochito', 'bochito'),
      u('tradeInYear', '2005', '2005'),
    ];
    let d = await f.send('Espera, sí tengo un bochito, es 2005 y volsvaguen.', details, {
      message: '¿Quieres entregarlo a cuenta o solo es tu auto actual?', questionFields: ['tradeIn'],
    });
    assert.equal(d.opportunity.answers.tradeIn, undefined);
    assert.equal(d.opportunity.collection.tradeIn, 'pending');
    assert.equal(d.opportunity.answers.tradeInBrand, undefined);
    assert.equal(d.opportunity.answers.tradeInModel, undefined);
    assert.equal(d.opportunity.answers.tradeInYear, undefined);
    assert.equal(d.opportunity.pendingQuestion?.stagedTradeInDetails?.length, 3);

    d = await f.send('Sí, lo quiero dejar a cuenta.', [u('tradeIn', 'true', 'lo quiero dejar a cuenta')]);
    assert.equal(d.opportunity.answers.tradeIn, true);
    assert.equal(d.opportunity.answers.tradeInBrand, 'Volkswagen');
    assert.equal(d.opportunity.answers.tradeInModel, 'Bochito');
    assert.equal(d.opportunity.answers.tradeInYear, 2005);
    assert.equal(d.opportunity.collection.tradeInBrand, 'answered');
    assert.equal(d.opportunity.collection.tradeInModel, 'answered');
    assert.equal(d.opportunity.collection.tradeInYear, 'answered');
    assert.match(d.messages.at(-1)!.text, /Volkswagen Bochito 2005/);
  } finally { (await f.repo.close()); }
});

test('confirmar vehículo a cuenta conserva datos conocidos y pregunta solo la marca que falta', async () => {
  const f = (await setup());
  try {
    await f.send('No tengo vehículo a cuenta', [u('tradeIn', 'false', 'No tengo vehículo a cuenta')]);
    await f.send('Espera, tengo un bochito de 2005.', [
      u('tradeInModel', 'Bochito', 'bochito'), u('tradeInYear', '2005', '2005'),
    ], { message: '¿Lo quieres dejar a cuenta o solo es tu auto actual?', questionFields: ['tradeIn'] });
    const d = await f.send('Sí, lo quiero dejar a cuenta.', [u('tradeIn', 'true', 'lo quiero dejar a cuenta')]);
    assert.equal(d.opportunity.answers.tradeIn, true);
    assert.equal(d.opportunity.answers.tradeInModel, 'Bochito');
    assert.equal(d.opportunity.answers.tradeInYear, 2005);
    assert.equal(d.opportunity.answers.tradeInBrand, undefined);
    assert.equal(d.opportunity.collection.tradeInBrand, 'pending');
    assert.deepEqual(d.opportunity.pendingQuestion?.fields, ['tradeInBrand']);
    assert.match(d.messages.at(-1)!.text, /¿De qué marca es tu Bochito 2005\?/);
    assert.doesNotMatch(d.messages.at(-1)!.text, /modelo del vehículo|¿De qué año/);
  } finally { (await f.repo.close()); }
});

test('rechazar la entrega a cuenta descarta los detalles que solo estaban en espera', async () => {
  const f = (await setup());
  try {
    await f.send('No tengo vehículo a cuenta', [u('tradeIn', 'false', 'No tengo vehículo a cuenta')]);
    await f.send('Tengo un bochito de 2005 y es Volkswagen.', [
      u('tradeInBrand', 'Volkswagen', 'Volkswagen'), u('tradeInModel', 'Bochito', 'bochito'), u('tradeInYear', '2005', '2005'),
    ], { message: '¿Lo quieres dejar a cuenta o solo es tu auto actual?', questionFields: ['tradeIn'] });
    const d = await f.send('No, solo es mi auto actual.', [u('tradeIn', 'false', 'solo es mi auto actual')]);
    assert.equal(d.opportunity.answers.tradeIn, false);
    assert.equal(d.opportunity.answers.tradeInBrand, undefined);
    assert.equal(d.opportunity.answers.tradeInModel, undefined);
    assert.equal(d.opportunity.answers.tradeInYear, undefined);
    assert.equal(d.opportunity.collection.tradeInBrand, 'not_applicable');
    assert.equal(d.opportunity.collection.tradeInModel, 'not_applicable');
    assert.equal(d.opportunity.collection.tradeInYear, 'not_applicable');
    assert.equal(d.opportunity.pendingQuestion, undefined);
  } finally { (await f.repo.close()); }
});

for (const text of ['la próxima semana', 'en una semana', 'la semana que viene', 'en dos semanas']) test(`temporalidad: ${text} se registra dentro de 30 días`, async () => {
  const f = (await setup());
  try {
    await f.send('hola', [], { message: '¿Cuándo piensas comprar?', questionFields: ['timeframe'] });
    const d = await f.send(text, [u('timeframe', '31-90', text)], { message: 'Anoté que comprarás el próximo mes.' });
    assert.equal(d.opportunity.answers.timeframe, '0-30');
    assert.equal(d.opportunity.collection.timeframe, 'answered');
    assert.match(d.messages.at(-1)!.text, /próximos 30 días/);
    assert.doesNotMatch(d.messages.at(-1)!.text, /próximo mes/);
    const event = d.events.at(-1)!.data as { accepted: { quote: string; value: string }[] };
    assert.equal(event.accepted.find(update => update.quote === text)?.value, '0-30');
  } finally { (await f.repo.close()); }
});

test('temporalidad: conserva uno a tres meses y todavía sin fecha', async () => {
  const f = (await setup());
  try {
    await f.send('hola', [], { message: '¿Cuándo piensas comprar?', questionFields: ['timeframe'] });
    let d = await f.send('De uno a tres meses', [u('timeframe', '31-90', 'uno a tres meses')]);
    assert.equal(d.opportunity.answers.timeframe, '31-90');
    d = await f.send('Todavía sin fecha', [u('timeframe', 'undefined', 'Todavía sin fecha')]);
    assert.equal(d.opportunity.answers.timeframe, 'undefined');
    assert.equal(d.opportunity.collection.timeframe, 'answered');
  } finally { (await f.repo.close()); }
});

for (const text of ['nop', 'noo', 'ninguno', 'no tengo', 'nada']) test(`vehículo a cuenta: negativa breve ${text} avanza sin pedir correcciones`, async () => {
  const f = (await setup());
  try {
    await f.send('hola', [], { message: '¿Tienes algún vehículo que quieras entregar a cuenta?', questionFields: ['tradeIn'] });
    const d = await f.send(text, [], { message: '¿Qué dato quieres corregir?', questionFields: ['tradeIn'] });
    assert.equal(d.opportunity.answers.tradeIn, false);
    assert.equal(d.opportunity.collection.tradeIn, 'answered');
    assert.doesNotMatch(d.messages.at(-1)!.text, /qué dato quieres corregir|entregar a cuenta\?/i);
    assert.notDeepEqual(d.opportunity.pendingQuestion?.fields, ['tradeIn']);
    assert.equal(d.customer.phone, undefined);
    assert.equal(d.customer.email, undefined);
  } finally { (await f.repo.close()); }
});

test('vehículo a cuenta: negativa no altera el contacto y después permite responder la pregunta de contacto', async () => {
  const f = (await setup());
  try {
    await f.send('hola', [], { message: '¿Tienes algún vehículo que quieras entregar a cuenta?', questionFields: ['tradeIn'] });
    let d = await f.send('nop', []);
    assert.equal(d.opportunity.answers.tradeIn, false);
    assert.equal(d.opportunity.collection.phone, 'pending');
    assert.equal(d.opportunity.collection.email, 'pending');
    d = await f.send('3521455896', [u('phone', '3521455896', '3521455896')]);
    assert.equal(d.customer.phone, '3521455896');
    assert.equal(d.opportunity.answers.tradeIn, false);
  } finally { (await f.repo.close()); }
});

test('duda de colores y modelos no confunde versiones con vehículos del catálogo', async () => {
  const f = (await setup());
  try {
    await f.send('Me interesa la Ford Bronco Sport', [u('vehicleId', 'bronco', 'Ford Bronco Sport')]);
    const question = '¿Sabes de qué color y modelos hay?';
    const d = await f.send(question, [u('questions', question, question)], {
      message: 'Hay Ford Territory, Ford Lobo, Ford Bronco Sport y Ford Mustang.',
    });
    assert.match(d.messages.at(-1)!.text, /no permite confirmar los colores, el inventario ni las versiones reales de Ford Bronco Sport/);
    assert.match(d.messages.at(-1)!.text, /Ford Territory, Ford Lobo y Ford Mustang.*vehículos distintos, no versiones/);
    assert.doesNotMatch(d.messages.at(-1)!.text, /hay (?:disponibles )?(?:en|en color)|versiones disponibles/i);
    assert.equal(d.opportunity.answers.questions, question);
  } finally { (await f.repo.close()); }
});

test('pregunta explícita por colores y versiones del vehículo elegido no pide aclaración redundante', async () => {
  const f = (await setup());
  try {
    await f.send('Me interesa la Ford Territory', [u('vehicleId', 'territory', 'Ford Territory')]);
    const question = '¿Qué colores y versiones tiene la Ford Territory?';
    const d = await f.send(question, [u('questions', question, question)], {
      message: 'No puedo confirmar colores ni versiones. ¿Te refieres a las versiones de Ford Territory o a otros vehículos del catálogo?',
    });
    assert.match(d.messages.at(-1)!.text, /Ford Territory/);
    assert.match(d.messages.at(-1)!.text, /no permite confirmar los colores.*versiones reales/);
    assert.doesNotMatch(d.messages.at(-1)!.text, /¿Te refieres|¿A qué vehículos del catálogo/i);
    assert.equal(d.opportunity.answers.questions, question);
  } finally { (await f.repo.close()); }
});

test('pregunta de colores y versiones sin identificar vehículo conserva la aclaración de alcance', async () => {
  const f = (await setup());
  try {
    await f.send('Me interesa la Ford Territory', [u('vehicleId', 'territory', 'Ford Territory')]);
    const question = '¿Qué colores y versiones hay?';
    const d = await f.send(question, [u('questions', question, question)], {
      message: 'No puedo confirmar colores ni versiones. ¿Te refieres a las versiones de Ford Territory o a otros vehículos del catálogo?',
    });
    assert.match(d.messages.at(-1)!.text, /¿Te refieres a las versiones de Ford Territory o a los vehículos que aparecen en el catálogo\?/);
  } finally { (await f.repo.close()); }
});

test('el cierre de dudas reemplaza un resumen que aún promete enviar la duda al asesor', async () => {
  const f = (await setup());
  try {
    const previous = '¿Qué precio tiene?';
    await f.send(previous, [u('questions', previous, previous)]);
    const d = await f.send('No tengo más dudas', [], {
      message: 'Gracias, dejaré tu consulta anterior anotada para el asesor.',
    });
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.match(d.messages.at(-1)!.text, /Sin dudas/);
    assert.doesNotMatch(d.messages.at(-1)!.text, /consulta anterior|anotada para el asesor/i);
    assert.equal(d.messages.filter(message => message.role === 'user' && message.text === previous).length, 1);
  } finally { (await f.repo.close()); }
});

test('preguntar qué vehículos aparecen en el catálogo conserva la lista como vehículos distintos', async () => {
  const f = (await setup());
  try {
    await f.send('Me interesa la Ford Bronco Sport', [u('vehicleId', 'bronco', 'Ford Bronco Sport')]);
    const question = '¿Qué vehículos aparecen en el catálogo de demostración?';
    const response = 'En el catálogo aparecen Ford Territory, Ford Lobo, Ford Bronco Sport y Ford Mustang como vehículos distintos.';
    const d = await f.send(question, [u('questions', question, question)], { message: response });
    assert.equal(d.messages.at(-1)!.text, response);
    assert.equal(d.opportunity.answers.questions, question);
  } finally { (await f.repo.close()); }
});

test('duda respondida con “ya me contestaron” se retira de la ficha y conserva historial', async () => {
  const f = (await setup());
  try {
    const question = '¿Qué precio tiene?';
    await f.send(question, [u('questions', question, question)]);
    const d = await f.send('Ya me contestaron la duda del precio; no tengo más dudas.', [], {
      message: '¿Tienes alguna duda que quieras dejar anotada para el asesor?', questionFields: ['questions'],
    });
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.doesNotMatch(d.messages.at(-1)!.text, /¿Tienes alguna duda/);
    assert.equal(d.messages.filter(message => message.role === 'user' && message.text === question).length, 1);
  } finally { (await f.repo.close()); }
});

for (const text of ['Ya se resolvió', 'No tengo más dudas', 'Ya entendí, no tengo ninguna otra']) test(`cierra la duda anterior con “${text}” aunque el agente repita la pregunta`, async () => {
  const f = (await setup());
  try {
    const previous = '¿Qué precio tiene?';
    await f.send(previous, [u('questions', previous, previous)]);
    const d = await f.send(text, [], {
      message: 'Gracias. ¿Tienes alguna duda que quieras dejar anotada para el asesor?',
      questionFields: ['questions'],
    });
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.equal(d.opportunity.pendingQuestion, undefined);
    assert.doesNotMatch(d.messages.at(-1)!.text, /¿Tienes alguna duda/);
    assert.equal(d.messages.filter(message => message.role === 'user' && message.text === previous).length, 1);
    assert.equal(d.messages.at(-2)?.text, text);
  } finally { (await f.repo.close()); }
});

test('extracción obsoleta no restaura una duda que el usuario ya resolvió', async () => {
  const f = (await setup());
  try {
    const previous = '¿Qué precio tiene?';
    await f.send(previous, [u('questions', previous, previous)]);
    const text = 'Ya se resolvió y no tengo más dudas.';
    const d = await f.send(text, [u('questions', previous, previous)], {
      message: 'Gracias. ¿Tienes alguna duda que quieras dejar anotada para el asesor?',
      questionFields: ['questions'],
    });
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.equal(d.opportunity.answerSources.questions, d.messages.at(-2)?.id);
    assert.equal(d.opportunity.pendingQuestion, undefined);
    assert.doesNotMatch(d.messages.at(-1)!.text, /¿Tienes alguna duda/);
  } finally { (await f.repo.close()); }
});

test('resolver una duda y formular otra retira la anterior y conserva solo la nueva', async () => {
  const f = (await setup());
  try {
    const previous = '¿Qué colores hay?';
    await f.send(previous, [u('questions', previous, previous)]);
    const text = 'Ya se resolvió la duda anterior; ¿Qué condiciones hay para crédito?';
    const current = '¿Qué condiciones hay para crédito?';
    const d = await f.send(text, [u('questions', current, current)], {
      message: 'Dejo anotada la consulta. ¿Tienes alguna duda que quieras dejar anotada para el asesor?',
      questionFields: ['questions'],
    });
    assert.equal(d.opportunity.answers.questions, current);
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.equal(d.messages.filter(message => message.role === 'user' && message.text === previous).length, 1);
    assert.doesNotMatch(d.opportunity.answers.questions, /colores/);
    assert.doesNotMatch(d.messages.at(-1)!.text, /¿Tienes alguna duda/);
  } finally { (await f.repo.close()); }
});

test('el cierre evita repetir la pregunta aunque otra actualización se rechace', async () => {
  const f = (await setup());
  try {
    const previous = '¿Qué precio tiene?';
    await f.send(previous, [u('questions', previous, previous)]);
    const text = 'Ya se resolvió y no tengo más dudas; mi teléfono es 123.';
    const d = await f.send(text, [u('phone', '123', 'mi teléfono es 123')], {
      message: 'Gracias. ¿Tienes alguna duda que quieras dejar anotada para el asesor?',
      questionFields: ['questions', 'phone'],
    });
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');
    assert.equal(d.opportunity.collection.questions, 'answered');
    assert.equal(d.opportunity.collection.phone, 'pending');
    assert.match(d.messages.at(-1)!.text, /teléfono/);
    assert.doesNotMatch(d.messages.at(-1)!.text, /¿Tienes alguna duda/);
  } finally { (await f.repo.close()); }
});

test('dudas nuevas se conservan y un teléfono inválido recibe aclaración específica', async () => {
  const f = (await setup());
  try {
    const previous = '¿Qué precio tiene?';
    await f.send(previous, [u('questions', previous, previous)]);
    let d = await f.send('Ya se resolvió y no tengo más dudas.');
    assert.equal(d.opportunity.answers.questions, 'Sin dudas');

    const current = '¿Qué condiciones hay para crédito?';
    d = await f.send(current, [u('questions', current, current)]);
    assert.equal(d.opportunity.answers.questions, current);
    assert.equal(d.opportunity.collection.questions, 'answered');

    d = await f.send('Mi teléfono es 123.', [u('phone', '123', 'Mi teléfono es 123.')], {
      message: '¿Tienes alguna duda que quieras dejar anotada para el asesor?', questionFields: ['questions'],
    });
    assert.equal(d.customer.phone, undefined);
    assert.equal(d.opportunity.collection.phone, 'pending');
    assert.match(d.messages.at(-1)!.text, /teléfono/);
    assert.doesNotMatch(d.messages.at(-1)!.text, /¿Tienes alguna duda/);
  } finally { (await f.repo.close()); }
});
