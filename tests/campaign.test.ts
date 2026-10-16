import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import express from 'express'
import { createServer } from 'vite'
import viteConfig from '../vite.config.ts'
import { campaignRoutes } from '../server/campaigns.ts'
import { SqliteRepository } from '../server/repository.ts'
import { Demo } from '../src/Demo.tsx'

test('páginas demo independientes: tarjeta/enlace y landing sin chat ni captura', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: { theme: 'dark' } } } })
  try {
    const campaign = renderToStaticMarkup(createElement(Demo, { path: '/demo/campana' }))
    assert.match(campaign, /Bronco Sport/)
    assert.match(campaign, /Simulación/)
    assert.match(campaign, /href="\/r\/campana-bronco"/)
    assert.match(campaign, /Me interesa/)
    const landing = renderToStaticMarkup(createElement(Demo, { path: '/demo/landing' }))
    assert.match(landing, /Bienvenido a la landing/)
    for (const page of [campaign, landing]) {
      assert.match(page, /Modo claro/)
      assert.doesNotMatch(page, /textarea|chat-messages|Iniciar conversación/)
    }
    assert.doesNotMatch(landing, /href="\/r\//)
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

test('Vite: /r usa el proxy y /demo se resuelve como frontend sin registrar accesos', async () => {
  assert.ok(viteConfig.server?.proxy?.['/r'])
  assert.ok(viteConfig.server?.proxy?.['/api'])
  const repo = new SqliteRepository(':memory:')
  const backend = express().use(campaignRoutes(repo)).listen(0, '127.0.0.1')
  let vite: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    await new Promise<void>(resolve => backend.once('listening', resolve))
    const address = backend.address()
    assert.ok(address && typeof address !== 'string')
    const target = `http://127.0.0.1:${address.port}`
    vite = await createServer({ ...viteConfig, configFile: false, logLevel: 'silent', server: {
      ...viteConfig.server, port: 0, strictPort: false,
      proxy: Object.fromEntries(Object.keys(viteConfig.server!.proxy!).map(path => [path, { target }])),
    } })
    await vite.listen()
    const webAddress = vite.httpServer!.address()
    assert.ok(webAddress && typeof webAddress !== 'string')
    const base = `http://127.0.0.1:${webAddress.port}`
    for (const path of ['/demo/campana', '/demo/landing']) {
      const response = await fetch(`${base}${path}`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /text\/html/)
      assert.match(await response.text(), /\/src\/main.tsx/)
    }
    assert.equal(repo.all('campaignAccesses').length, 0)
    const response = await fetch(`${base}/r/campana-bronco?destination=/otro`, { redirect: 'manual' })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), '/demo/landing')
    assert.equal(repo.all('campaignAccesses').length, 1)
    const landing = await fetch(new URL(response.headers.get('location')!, base))
    assert.equal(landing.status, 200)
    const list = await fetch(`${base}/api/campaign-events`)
    assert.equal((await list.json()).total, 1)
    assert.equal(repo.all('campaignAccesses').length, 1)
    for (const table of ['customers', 'opportunities', 'conversations', 'messages'] as const) assert.deepEqual(repo.all(table), [])
  } finally {
    await vite?.close()
    backend.closeAllConnections()
    await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()))
    repo.close()
  }
})
