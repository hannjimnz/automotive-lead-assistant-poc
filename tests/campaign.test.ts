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
import { frontendRoutes } from '../server/frontend.ts'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

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
  const backend = express().use(campaignRoutes(repo)).use(frontendRoutes()).listen(0, '127.0.0.1')
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
    for (const [index, origin] of [base, target].entries()) {
      const response = await fetch(`${origin}/r/campana-bronco?destination=/otro`, { redirect: 'manual' })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('location'), null)
      assert.match(response.headers.get('cache-control')!, /no-store/)
      const html = await response.text()
      assert.match(html, /Te estamos redirigiendo al sitio de PASA…/)
      const destination = html.match(/id="continue-link" href="([^"]+)"/)![1]
      assert.equal(destination, '/demo/landing')
      assert.doesNotMatch(html, /\/src\/main|chat-messages/)
      assert.equal(repo.all('campaignAccesses').length, index + 1)
      for (const asset of ['/campaign-redirect.js', '/campaign-redirect.css']) {
        const resource = await fetch(`${origin}${asset}`)
        assert.equal(resource.status, 200)
        assert.doesNotMatch(resource.headers.get('content-type')!, /text\/html/)
      }
      const landing = await fetch(new URL(destination, origin))
      assert.equal(landing.status, 200)
      const page = await landing.text()
      if (origin === target) {
        assert.match(page, /\/assets\//) // Real output of npm run build served by Express.
        assert.doesNotMatch(page, /\/src\/main/)
        const script = page.match(/src="(\/assets\/[^"]+\.js)"/)![1]
        const bundle = await fetch(`${origin}${script}`)
        assert.equal(bundle.status, 200)
        assert.match(await bundle.text(), /Bienvenido a la landing/)
      }
      assert.equal(repo.all('campaignAccesses').length, index + 1)
    }
    const list = await fetch(`${base}/api/campaign-events`)
    assert.equal((await list.json()).total, 2)
    assert.equal(repo.all('campaignAccesses').length, 2)
    for (const table of ['customers', 'opportunities', 'conversations', 'messages'] as const) assert.deepEqual(repo.all(table), [])
  } finally {
    await vite?.close()
    backend.closeAllConnections()
    await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()))
    repo.close()
  }
})

test('pantalla intermedia: tema inicial, temporizador único de 3 segundos y enlace manual sin peticiones', () => {
  const script = readFileSync(new URL('../public/campaign-redirect.js', import.meta.url), 'utf8')
  for (const blockedStorage of [false, true]) {
    let ready: () => void = () => { throw new Error('Missing DOMContentLoaded handler') }
    let click: () => void = () => { throw new Error('Missing click handler') }
    let scheduled: () => void = () => { throw new Error('Missing timer') }
    let navigated = ''
    let timers = 0
    let cancelled = false
    const document = { documentElement: { dataset: {} as Record<string, string> },
      addEventListener: (name: string, handler: () => void) => { assert.equal(name, 'DOMContentLoaded'); ready = handler },
      getElementById: (id: string) => {
        assert.equal(id, 'continue-link')
        return { href: 'http://local.invalid/demo/landing', addEventListener: (name: string, handler: () => void) => { assert.equal(name, 'click'); click = handler } }
      },
    }
    runInNewContext(script, {
      document, localStorage: { getItem: () => { if (blockedStorage) throw new Error('Blocked'); return 'dark' } },
      matchMedia: () => ({ matches: false }),
      setTimeout: (handler: () => void, delay: number) => { assert.equal(delay, 3000); scheduled = handler; timers++; return 42 },
      clearTimeout: (timer: number) => { assert.equal(timer, 42); cancelled = true },
      window: { location: { assign: (url: string) => { navigated = url } } },
    })
    assert.equal(document.documentElement.dataset.theme, blockedStorage ? 'light' : 'dark')
    assert.equal(timers, 0)
    ready()
    assert.equal(timers, 1)
    assert.equal(navigated, '')
    scheduled()
    assert.equal(navigated, 'http://local.invalid/demo/landing')
    click()
    assert.equal(cancelled, true)
  }
})
