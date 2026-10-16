import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate, defaultRules, type Answers, type Rules, type CollectionProgress } from '../shared/domain.js';

const rules: Rules = { ...defaultRules, id: 'demo', createdAt: '2026-01-01T00:00:00.000Z' };
const valid: Answers = { timeframe: '0-30', intention: 'advance', capacity: 'ready' };

test('pending y not_applicable no permiten completar, incluso con valores', () => {
  for (const status of ['pending', 'not_applicable'] as const) {
    const result = calculate(valid, rules, { timeframe: status });
    assert.equal(result.score, null);
    assert.equal(result.grade, null);
    assert.equal(result.breakdown.Temporalidad, null);
    assert.equal(result.criteria.timeframe.status, status);
  }
});

test('unknown y declined sin valor aportan cero y conservan los campos vacíos', () => {
  const answers: Answers = { intention: 'compare' };
  const collection: CollectionProgress = { timeframe: 'unknown', intention: 'answered', capacity: 'declined' };
  const result = calculate(answers, rules, collection);
  assert.equal(result.score, 15);
  assert.equal(result.grade, 'red');
  assert.equal(result.provisional, true);
  assert.deepEqual(result.unknownCriteria, ['timeframe']);
  assert.deepEqual(result.declinedCriteria, ['capacity']);
  assert.deepEqual(result.breakdown, { Temporalidad: 0, Intención: 15, Capacidad: 0 });
  assert.deepEqual(answers, { intention: 'compare' });
  assert.deepEqual(collection, { timeframe: 'unknown', intention: 'answered', capacity: 'declined' });
  const expected = calculate(answers, rules, { ...collection, capacity: 'unknown' });
  assert.equal(expected.score, 15);
  assert.deepEqual(expected.unknownCriteria, ['timeframe', 'capacity']);
});

test('todos unknown: cero, rojo provisional', () => {
  const result = calculate({}, rules, { timeframe: 'unknown', intention: 'unknown', capacity: 'unknown' });
  assert.equal(result.score, 0);
  assert.equal(result.grade, 'red');
  assert.equal(result.provisional, true);
});

test('respuestas válidas conservan puntos y umbrales configurados', () => {
  assert.equal(calculate(valid, rules).score, 100);
  assert.equal(calculate(valid, rules).grade, 'green');
  assert.equal(calculate(valid, rules).provisional, false);
  const yellow = calculate({ timeframe: '31-90', intention: 'compare', capacity: 'review' }, rules);
  assert.equal(yellow.score, 50);
  assert.equal(yellow.grade, 'yellow');
  const zero = calculate({ timeframe: 'undefined', intention: 'explore', capacity: 'unavailable' }, rules);
  assert.equal(zero.score, 0);
  assert.equal(zero.provisional, false);
});

test('registros anteriores: solo valores válidos implican answered', () => {
  assert.equal(calculate(valid, rules, undefined).score, 100);
  const missing = calculate({ intention: 'compare' }, rules);
  assert.equal(missing.score, null);
  assert.equal(missing.criteria.timeframe.status, 'pending');
  const invalid = calculate({ ...valid, timeframe: 'invalid' } as unknown as Answers, rules);
  assert.equal(invalid.score, null);
  assert.equal(invalid.criteria.timeframe.status, 'pending');
  assert.equal(calculate({}, rules, { timeframe: 'answered', intention: 'unknown', capacity: 'unknown' }).score, null);
  // Inconsistent state/value pairs must not count as an addressed criterion.
  assert.equal(calculate(valid, rules, { timeframe: 'unknown' }).score, null);
});
