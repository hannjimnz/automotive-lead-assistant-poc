import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { campaignRoutes } from './campaigns.js';
import { SqliteRepository } from './repository.js';
import { CRMService } from './service.js';
import type { CampaignAccessList } from '../shared/campaign.js';

test('campaña HTTP: página intermedia, evidencia mínima, 404, destino fijo y lecturas sin efectos', async (t) => {
  const repo = new SqliteRepository(':memory:');
  const crm = new CRMService(repo, { configured: true, respond: async () => { throw new Error('El agente no debe invocarse'); } });
  await crm.createConversation(); // Existing isolated records must remain byte-for-byte intact.
  const tables = ['customers', 'opportunities', 'conversations', 'messages', 'evaluations', 'events', 'tasks', 'rules'] as const;
  const snapshot = tables.map(table => repo.all(table));
  const app = express();
  app.use(campaignRoutes(repo));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const list = async () => {
      const response = await fetch(`${base}/api/campaign-events`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return await response.json() as CampaignAccessList;
    };
    assert.deepEqual(await list(), { events: [], total: 0 });
    for (const id of ['inexistente', 'constructor', '__proto__']) {
      const response = await fetch(`${base}/r/${id}`, { redirect: 'manual' });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('location'), null);
      assert.match(response.headers.get('cache-control')!, /no-store/);
    }
    assert.equal((await list()).total, 0);
    const start = Date.now();
    const paths = ['/r/campana-bronco', '/r/campana-bronco?url=https://example.invalid&destination=//example.invalid&redirect=/otro&vehicleId=lobo&name=no-guardar', '/r/campana-bronco'];
    for (const path of paths) {
      const response = await fetch(`${base}${path}`, { redirect: 'manual', headers: { 'X-Forwarded-For': '192.0.2.1' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('location'), null);
      assert.equal(response.headers.get('etag'), null);
      assert.match(response.headers.get('content-type')!, /text\/html/);
      const html = await response.text();
      assert.match(html, /Te estamos redirigiendo al sitio de PASA…/);
      assert.match(html, /En unos segundos abrirás la página de la campaña/);
      assert.match(html, /href="\/demo\/landing">Continuar ahora<\/a>/);
      assert.doesNotMatch(html, /example\.invalid|no-guardar|textarea|\/src\/main/);
      assert.match(response.headers.get('cache-control')!, /no-store/);
      assert.equal(response.headers.get('pragma'), 'no-cache');
    }
    const result = await list();
    assert.equal(result.total, 3); // Reloads are separate accesses, not unique people.
    assert.equal(new Set(result.events.map(event => event.id)).size, 3);
    for (const event of result.events) {
      assert.deepEqual(Object.keys(event).sort(), ['campaignId', 'createdAt', 'id', 'vehicleId']);
      assert.equal(event.campaignId, 'campana-bronco');
      assert.equal(event.vehicleId, 'bronco');
      assert.match(event.createdAt, /Z$/);
      assert.ok(Date.parse(event.createdAt) >= start && Date.parse(event.createdAt) <= Date.now());
    }
    assert.deepEqual(await list(), result);
    assert.deepEqual(tables.map(table => repo.all(table)), snapshot);
    const diagnostic = t.mock.method(console, 'error', () => {});
    const write = t.mock.method(repo, 'put', () => { throw new Error('private error body'); });
    const failedWrite = await fetch(`${base}/r/campana-bronco`);
    assert.equal(failedWrite.status, 200);
    assert.match(await failedWrite.text(), /href="\/demo\/landing">Continuar ahora/);
    assert.deepEqual(diagnostic.mock.calls[0].arguments[1], { category: 'CAMPAIGN_ACCESS_WRITE_FAILED', type: 'Error' });
    assert.doesNotMatch(JSON.stringify(diagnostic.mock.calls), /private error body/);
    write.mock.restore();
    assert.deepEqual(await list(), result);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    (await repo.close());
  }
});
