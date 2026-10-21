import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { agentOutputJsonSchema, agentOutputSchema, AnthropicAgent } from './agent.js';
import { CRMService, ApiError } from './service.js';
import { SqliteRepository } from './repository.js';

// An offline guard for the documented provider subset, not a live provider emulator.
function assertSupportedSchema(schema: unknown): void {
  if (!schema || typeof schema !== 'object') return;
  const object = schema as Record<string, unknown>;
  for (const key of ['maxItems', 'maxLength', 'minLength', 'minimum', 'maximum', 'multipleOf']) {
    assert.ok(!(key in object), `Unsupported schema keyword: ${key}`);
  }
  if (object.type === 'object') assert.equal(object.additionalProperties, false);
  if (object.minItems !== undefined) assert.ok(object.minItems === 0 || object.minItems === 1);
  if (object.properties && typeof object.properties === 'object') Object.values(object.properties).forEach(assertSupportedSchema);
  if (object.$defs && typeof object.$defs === 'object') Object.values(object.$defs).forEach(assertSupportedSchema);
  for (const key of ['items', 'anyOf', 'allOf']) {
    const value = object[key];
    if (Array.isArray(value)) value.forEach(assertSupportedSchema);
    else if (value) assertSupportedSchema(value);
  }
}

const payload = {
  message: 'Hola Alexa. ¿Qué vehículo te interesa?',
  updates: [{ field: 'name', status: 'answered', value: 'Alexa', quote: 'alexa', mode: 'apply' }],
  questionFields: ['vehicleId'],
};
function reply(output: unknown) {
  return new Response(JSON.stringify({
    id: 'msg_offline', type: 'message', role: 'assistant', model: 'offline-model',
    content: [{ type: 'text', text: JSON.stringify(output) }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('contrato: reproduce maxItems incompatible y conserva todas las validaciones locales', () => {
  // Exact incompatible fragment found in the pre-fix schema; no provider call.
  assert.throws(() => assertSupportedSchema({ type: 'array', items: { type: 'string' }, maxItems: 4 }), /Unsupported schema keyword: maxItems/);
  assert.doesNotThrow(() => assertSupportedSchema(agentOutputJsonSchema));
  assert.equal(agentOutputSchema.safeParse(payload).success, true);
  assert.equal(agentOutputSchema.safeParse({ ...payload, questionFields: ['name', 'phone', 'email', 'vehicleId', 'budget'] }).success, false);
  assert.equal(agentOutputSchema.safeParse({ ...payload, questionFields: ['invalid'] }).success, false);
  assert.equal(agentOutputSchema.safeParse({ ...payload, message: '' }).success, false);
  assert.equal(agentOutputSchema.safeParse({ ...payload, updates: [{ ...payload.updates[0], quote: '' }] }).success, false);
  assert.equal(agentOutputSchema.safeParse({ ...payload, updates: [{ ...payload.updates[0], mode: 'invalid' }] }).success, false);
  assert.equal(agentOutputSchema.safeParse({ ...payload, unexpected: true }).success, false);
});

test('hola soy alexa atraviesa SDK, JSON, Zod, actualizaciones y SQLite sin red', async () => {
  let calls = 0;
  const client = new Anthropic({
    apiKey: 'offline-test-placeholder', maxRetries: 0,
    fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assertSupportedSchema(body.output_config.format.schema);
      const instructions = JSON.stringify(body.system);
      assert.match(instructions, /no figura en ese catálogo/);
      assert.match(instructions, /No sustituyas su elección/);
      assert.match(instructions, /registra cada uno por separado/);
      assert.match(instructions, /contacto inválido y otros datos válidos/);
      assert.match(instructions, /Si además plantea/);
      assert.match(instructions, /sin signos de interrogación, con errores de escritura/);
      assert.match(instructions, /registra la consulta completa en un solo/);
      assert.match(instructions, /no inventes disponibilidad ni precio/);
      assert.match(instructions, /Una respuesta sin una pregunta real no se registra como duda/);
      assert.match(instructions, /No afirmes que quedaron registrados hasta/);
      assert.match(instructions, /una a cuatro semanas corresponde a timeframe/);
      assert.match(instructions, /No son versiones unos de otros/);
      assert.equal(body.model, 'offline-model');
      assert.deepEqual(body.messages.at(-1), { role: 'user', content: 'hola soy alexa' });
      return reply(payload);
    },
  });
  const repo = new SqliteRepository(':memory:');
  try {
    const service = new CRMService(repo, new AnthropicAgent({ client, model: 'offline-model' }));
    const id = (await service.createConversation()).opportunity.id;
    const result = await service.sendMessage(id, { text: 'hola soy alexa', requestId: 'alexa-offline' });
    assert.equal(result.customer.name, 'Alexa');
    assert.equal(result.opportunity.collection.name, 'answered');
    assert.equal(result.messages[1].status, 'complete');
    assert.equal(result.messages[1].text, 'hola soy alexa');
    assert.equal(result.messages[1].requestId, 'alexa-offline');
    assert.equal(result.messages[2].text, payload.message);
    assert.equal(result.evaluations.length, 0);
    await service.sendMessage(id, { text: 'hola soy alexa', requestId: 'alexa-offline' });
    assert.equal(calls, 1);
  } finally { (await repo.close()); }
});

test('HTTP 400 simulado conserva mensaje/requestId y permite reintento sin duplicados', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  let fail = true;
  const client = new Anthropic({
    apiKey: 'offline-test-placeholder', maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assertSupportedSchema(body.output_config.format.schema);
      if (fail) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Offline fixture: unsupported maxItems in output_config.format.schema' } }), { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_offline_schema' } });
      return reply(payload);
    },
  });
  const repo = new SqliteRepository(':memory:');
  try {
    const service = new CRMService(repo, new AnthropicAgent({ client, model: 'offline-model' }));
    const id = (await service.createConversation()).opportunity.id;
    const input = { text: 'hola soy alexa', requestId: 'retry-original' };
    await assert.rejects(service.sendMessage(id, input), error => error instanceof ApiError && error.code === 'AI_PROCESSING_FAILED');
    assert.deepEqual(log.mock.calls[0].arguments[1], { category: 'AI_PROCESSING_FAILED', stage: 'agent', httpStatus: 400, providerRequestId: 'req_offline_schema' });
    assert.doesNotMatch(JSON.stringify(log.mock.calls[0].arguments), /offline-test-placeholder|hola soy alexa|unsupported maxItems/);
    const failed = (await service.detail(id));
    assert.equal(failed.messages[1].status, 'error');
    assert.equal(failed.customer.name, undefined);
    assert.equal(failed.evaluations.length, 0);
    const original = failed.messages[1];
    fail = false;
    const retried = await service.sendMessage(id, input);
    assert.equal(retried.messages.filter(item => item.role === 'user').length, 1);
    assert.equal(retried.messages[1].id, original.id);
    assert.equal(retried.messages[1].requestId, original.requestId);
    assert.equal(retried.messages[1].createdAt, original.createdAt);
    assert.equal(retried.messages[1].text, original.text);
    assert.equal(retried.customer.name, 'Alexa');
  } finally { (await repo.close()); }
});
