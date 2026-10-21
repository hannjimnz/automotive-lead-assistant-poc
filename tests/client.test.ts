import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { api, ApiError } from '../src/api.ts'
import { readSession, saveSession, reconcilePending, rememberSession, selectOpportunity } from '../src/session.ts'
import { openOpportunity } from '../src/openOpportunity.ts'
import { filterProspects, sortProspects, type ProspectSort } from '../src/prospects.ts'
import { initialPagination, prospectPage, updatePagination, pageButtons } from '../src/pagination.ts'
import { Pagination } from '../src/components/Pagination.tsx'
import { formatMXN } from '../shared/money.ts'
import { formatPhone, normalizePhone, phoneSchema, phoneHasEvidence } from '../shared/phone.ts'
import type { OpportunityListItem } from '../shared/domain.ts'
import { ProspectRow } from '../src/components/Prospects.tsx'
import { CommercialCard } from '../src/components/CommercialCard.tsx'
import { EvaluationBreakdown } from '../src/components/EvaluationBreakdown.tsx'
import { calculate, defaultRules } from '../shared/domain.ts'
import { FollowupControls } from '../src/components/FollowupControls.tsx'
import { SqliteRepository } from '../server/repository.ts'
import { CRMService } from '../server/service.ts'
import type { AgentOutput, ChatAgent } from '../server/agent.ts'

const fake: ChatAgent = { configured: true, respond: async (): Promise<AgentOutput> => ({ message: 'Respuesta simulada', updates: [] }) }

test('seguimiento UI: explica bloqueo inicial, orden 24/48 h, repetición y ejecución en curso', async () => {
  const repo = new SqliteRepository(':memory:')
  try {
    const service = new CRMService(repo, fake)
    const id = (await service.createConversation()).opportunity.id
    const render = async (blocked = false) => renderToStaticMarkup(createElement(FollowupControls, { detail: await service.detail(id), blocked, onSimulate: () => {} }))
    let html = await render()
    assert.match(html, /Simulación de seguimiento/)
    assert.equal((html.match(/disabled=""/g) ?? []).length, 2)
    assert.match(html, /Se necesita un mensaje del usuario/)
    await service.sendMessage(id, { text: 'hola', requestId: 'followup-ui' })
    html = await render()
    assert.match(html, /Simular recordatorio de 24 h/)
    assert.match(html, /Simular recordatorio de 48 h/)
    assert.match(html, /Primero debes ejecutar el recordatorio de 24 h/)
    assert.equal((html.match(/disabled=""/g) ?? []).length, 1)
    const task = (await service.detail(id)).tasks.find(task => task.attempt === 1)!
    await service.followups.execute(task.id, 'simulated')
    html = await render()
    assert.match(html, /24 h ya fue resuelto/)
    assert.equal((html.match(/disabled=""/g) ?? []).length, 1)
    assert.doesNotMatch(html, /Primero debes/)
    html = await render(true)
    assert.equal((html.match(/disabled=""/g) ?? []).length, 2)
    assert.match(html, /Espera a que termine la operación/)
  } finally { repo.close() }
})

test('seguimiento API: simulación envía intento y ciclo exactos; respuesta conserva la ficha', async () => {
  const original = globalThis.fetch
  const repo = new SqliteRepository(':memory:')
  try {
    const detail = await new CRMService(repo, fake).createConversation()
    globalThis.fetch = async (url, options) => {
      assert.equal(url, `/api/opportunities/${detail.opportunity.id}/followups/simulate`)
      assert.equal(options?.method, 'POST')
      assert.deepEqual(JSON.parse(String(options?.body)), { attempt: 2, cycleId: 'user-message-cycle' })
      return new Response(JSON.stringify(detail), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    assert.deepEqual(await api.simulateFollowup(detail.opportunity.id, 2, 'user-message-cycle'), detail)
  } finally { globalThis.fetch = original; repo.close() }
})

test('peticiones reales del cliente: URLs, cuerpo exacto y conflicto claro', async () => {
  const repo = new SqliteRepository(':memory:')
  const detail = await new CRMService(repo, fake).createConversation()
  const requests: { url: string; options?: RequestInit }[] = []
  const original = globalThis.fetch
  let conflict = false
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options })
    return new Response(JSON.stringify(conflict ? { code: 'STALE_REQUEST', message: 'Intento antiguo' } : detail), { status: conflict ? 409 : 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    await api.createConversation()
    assert.equal(requests[0].url, '/api/conversations')
    assert.equal(requests[0].options?.method, 'POST')
    await api.detail(detail.opportunity.id)
    assert.equal(requests[1].url, `/api/opportunities/${detail.opportunity.id}`)
    const pending = { text: '  No sé el presupuesto.\nPrefiero contado.  ', requestId: 'same-request' }
    await api.sendMessage(detail.opportunity.id, pending)
    await api.sendMessage(detail.opportunity.id, pending)
    assert.equal(requests[2].url, `/api/opportunities/${detail.opportunity.id}/messages`)
    assert.equal(requests[2].options?.body, requests[3].options?.body)
    assert.deepEqual(JSON.parse(String(requests[2].options?.body)), pending)
    conflict = true
    await assert.rejects(api.sendMessage(detail.opportunity.id, pending), error => error instanceof ApiError && error.code === 'STALE_REQUEST' && error.status === 409 && error.message === 'Intento antiguo')
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    await assert.rejects(api.detail(detail.opportunity.id), error => error instanceof ApiError && error.code === 'NETWORK_ERROR')
  } finally { globalThis.fetch = original; repo.close() }
})

test('sesión y recuperación: texto exacto, resultado completado, fallos antiguos', async () => {
  const memory = new Map<string, string>()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) } })
  const repo = new SqliteRepository(':memory:')
  const detail = await new CRMService(repo, fake).createConversation()
  const pending = { text: '  Hola\nPASA  ', requestId: 'recover-exact' }
  try {
    saveSession({ opportunityId: detail.opportunity.id, pending })
    assert.equal(readSession().opportunityId, detail.opportunity.id)
    assert.deepEqual(readSession().pending, pending)
    assert.equal(reconcilePending(readSession().pending, detail), 'retry')
    detail.messages.push({ id: 'user', conversationId: detail.conversation.id, role: 'user', text: pending.text, requestId: pending.requestId, createdAt: detail.conversation.createdAt, status: 'error' })
    assert.equal(reconcilePending(pending, detail), 'retry')
    detail.messages.push({ ...detail.messages.at(-1)!, id: 'later', requestId: 'later' })
    assert.equal(reconcilePending(pending, detail), 'stale')
    detail.messages[1].status = 'complete'
    assert.equal(reconcilePending(pending, detail), 'complete')
    detail.messages[1].text = 'different text'
    assert.equal(reconcilePending(pending, detail), 'conflict')
    saveSession({ opportunityId: detail.opportunity.id, pending: null })
    assert.equal(readSession().pending, null)
  } finally {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original)
    else Reflect.deleteProperty(globalThis, 'sessionStorage')
    repo.close()
  }
})

test('ficha renderizada: estados distintos, MXN, cero explícito y ausencia', async () => {
  const repo = new SqliteRepository(':memory:')
  const detail = await new CRMService(repo, fake).createConversation()
  try {
    Object.assign(detail.opportunity.collection, { budget: 'unknown', downPayment: 'not_applicable', phone: 'declined', capacity: 'answered' })
    Object.assign(detail.opportunity.answers, { capacity: 'ready', payment: 'cash', tradeIn: false })
    const html = renderToStaticMarkup(createElement(CommercialCard, { detail }))
    assert.match(html, /No sabe/)
    assert.match(html, /Prefiere no responder/)
    assert.match(html, /No aplica/)
    assert.match(html, /Pendiente/)
    assert.match(html, /Respondido/)
    assert.doesNotMatch(html, /Calificación|Clasificación comercial|Evaluaciones guardadas/)
    assert.match(html, /Recopilación/)
    assert.doesNotMatch(html, /\$0/)
    detail.opportunity.answers.budget = 0
    detail.opportunity.collection.budget = 'answered'
    const withZero = renderToStaticMarkup(createElement(CommercialCard, { detail }))
    assert.match(withZero, /\$0\.00 MXN/)
    assert.match(withZero, /role="tablist"/)
    assert.match(withZero, /aria-selected="true"/)
  } finally { repo.close() }
})

test('desglose visual diferencia pendiente de cero y conserva evaluación histórica', async () => {
  const rules = { ...defaultRules, id: 'demo', createdAt: '2026-01-01T00:00:00.000Z' }
  const metadata = { id: 'evaluation', opportunityId: 'demo', createdAt: rules.createdAt, ruleVersion: 1 }
  const calculated = calculate({ intention: 'compare' }, rules, { timeframe: 'pending', intention: 'answered', capacity: 'unknown' })
  const html = renderToStaticMarkup(createElement(EvaluationBreakdown, { evaluation: { ...metadata, ...calculated } }))
  assert.match(html, /criterion-pending/)
  assert.match(html, /Pendiente de abordar/)
  assert.match(html, /0 puntos/)
  assert.match(html, /No sabe/)
  assert.match(html, /15 puntos/)
  const legacy = renderToStaticMarkup(createElement(EvaluationBreakdown, { evaluation: { ...metadata, score: null, grade: null, breakdown: { Temporalidad: 0, Intención: 15, Capacidad: 0 } } }))
  assert.match(legacy, /Evaluación histórica/)
  assert.doesNotMatch(legacy, /Pendiente de abordar/)
})

test('abrir solo consulta GET; selección, borradores y envíos sobreviven a cambios y recarga', async () => {
  const repo = new SqliteRepository(':memory:')
  const service = new CRMService(repo, fake)
  const first = await service.createConversation()
  const second = await service.createConversation()
  const originalFetch = globalThis.fetch
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const memory = new Map<string, string>()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) } })
  const requests: string[] = []
  globalThis.fetch = async (url, options) => {
    assert.ok(!options?.method || options.method === 'GET')
    requests.push(String(url))
    const body = String(url) === '/api/opportunities' ? await service.listOpportunities() : await service.detail(decodeURIComponent(String(url).split('/').at(-1)!))
    return new Response(JSON.stringify(body), { status: 200 })
  }
  try {
    const pending = { text: '  mensaje exacto\n  ', requestId: 'same' }
    const session = rememberSession({ opportunityId: first.opportunity.id, pending, draft: 'Borrador Ana' })
    saveSession(session)
    const before = JSON.stringify([repo.all('opportunities'), repo.all('messages'), repo.all('evaluations')])
    await assert.rejects(openOpportunity(session, second.opportunity.id, true), /Esp era|Espera/)
    assert.equal(requests.length, 0)
    assert.equal(readSession().opportunityId, first.opportunity.id)
    const opened = await openOpportunity(session, second.opportunity.id, false)
    assert.equal(opened.detail.conversation.id, second.conversation.id)
    assert.equal(readSession().opportunityId, second.opportunity.id)
    const edited = rememberSession({ ...opened.session, draft: 'Borrador B' })
    saveSession(edited)
    const returned = await openOpportunity(readSession(), first.opportunity.id, false)
    assert.equal(returned.session.draft, 'Borrador Ana')
    assert.deepEqual(returned.session.pending, pending)
    assert.deepEqual(readSession().pending, pending)
    assert.equal(selectOpportunity(returned.session, second.opportunity.id, false).draft, 'Borrador B')
    const rows = await api.opportunities()
    assert.equal(rows.length, 2)
    assert.equal(requests.at(-1), '/api/opportunities')
    assert.equal(JSON.stringify([repo.all('opportunities'), repo.all('messages'), repo.all('evaluations')]), before)
  } finally {
    globalThis.fetch = originalFetch
    if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage)
    else Reflect.deleteProperty(globalThis, 'sessionStorage')
    repo.close()
  }
})

test('prospectos: oculta puntuaciones históricas y conserva estados y búsqueda', async () => {
  const repo = new SqliteRepository(':memory:')
  const service = new CRMService(repo, fake)
  const first = await service.createConversation()
  const second = await service.createConversation()
  try {
    repo.put('customers', { ...second.customer, name: 'José Pérez' })
    repo.put('opportunities', { ...second.opportunity, score: 0, grade: 'red', vehicleId: 'territory', collection: { timeframe: 'pending', capacity: 'unknown', intention: 'declined' } })
    const rows = await service.listOpportunities()
    const missing = rows.find(row => row.id === first.opportunity.id)!
    const zero = rows.find(row => row.id === second.opportunity.id)!
    const emptyHTML = renderToStaticMarkup(createElement(ProspectRow, { row: missing, blocked: false, selected: false, onOpen: () => {} }))
    assert.match(emptyHTML, /Sin proporcionar/)
    assert.doesNotMatch(emptyHTML, /Calificación|puntos/)
    assert.doesNotMatch(emptyHTML, /0 puntos/)
    const zeroHTML = renderToStaticMarkup(createElement(ProspectRow, { row: zero, blocked: true, selected: true, onOpen: () => {} }))
    assert.doesNotMatch(zeroHTML, /Calificación|puntos|Rojo/)
    assert.match(zeroHTML, /Pendientes: Temporalidad/)
    assert.match(zeroHTML, /No sabe: Capacidad/)
    assert.match(zeroHTML, /Prefiere no responder: Intención/)
    assert.match(zeroHTML, /disabled/)
    assert.deepEqual(filterProspects(rows, 'jose').map(row => row.id), [zero.id])
    assert.deepEqual(filterProspects(rows, 'Territory').map(row => row.id), [zero.id])
    assert.equal(filterProspects(rows, 'inexistente').length, 0)
  } finally { repo.close() }
})

const paginationRows: OpportunityListItem[] = Array.from({ length: 23 }, (_, index) => ({
  id: `opportunity-${index}`, customer: { id: `customer-${index}`, name: index % 2 ? 'Ana' : 'José' },
  vehicleId: index % 2 ? 'lobo' : 'territory', score: null, grade: null, provisional: null,
  status: 'new', collection: {}, lastInteraction: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
}))

test('paginación: cinco inicialmente, límites y cero resultados sin rangos inválidos', async () => {
  const first = prospectPage(paginationRows, initialPagination)
  assert.equal(first.range, '1–5 de 23 prospectos')
  assert.equal(first.items.length, 5)
  assert.equal(first.pageCount, 5)
  assert.deepEqual(first.items.map(item => item.id), ['opportunity-22', 'opportunity-21', 'opportunity-20', 'opportunity-19', 'opportunity-18'])
  const last = prospectPage(paginationRows, { ...initialPagination, page: 500 })
  assert.equal(last.page, 5)
  assert.equal(last.range, '21–23 de 23 prospectos')
  assert.equal(last.items.length, 3)
  assert.equal(prospectPage(paginationRows, { ...initialPagination, page: 0 }).page, 1)
  const empty = prospectPage([], { ...initialPagination, page: 10 })
  assert.equal(empty.range, '0 prospectos')
  assert.equal(empty.pageCount, 0)
  assert.deepEqual(empty.buttons, [])
  const html = renderToStaticMarkup(createElement(Pagination, { result: empty, pageSize: 5, loading: false, onSize: () => {}, onPage: () => {} }))
  assert.match(html, /0 prospectos/)
  assert.doesNotMatch(html, /Anterior|Siguiente|aria-current/)
})

test('búsqueda y orden antes de paginar; búsqueda y cantidad vuelven a primera página', async () => {
  let state = { ...initialPagination, page: 4 }
  state = updatePagination(state, { type: 'search', value: 'jose' })
  assert.equal(state.page, 1)
  const result = prospectPage(paginationRows, state)
  assert.equal(result.total, 12)
  assert.equal(result.range, '1–5 de 12 prospectos')
  assert.ok(result.items.every(item => item.customer.name === 'José'))
  assert.deepEqual(result.items.map(item => item.id), ['opportunity-22', 'opportunity-20', 'opportunity-18', 'opportunity-16', 'opportunity-14'])
  state = updatePagination({ ...state, page: 3 }, { type: 'size', value: 10 })
  assert.equal(state.page, 1)
  assert.equal(prospectPage(paginationRows, state).items.length, 10)
  state = updatePagination({ ...state, page: 2 }, { type: 'size', value: 20 })
  assert.equal(state.page, 1)
  assert.equal(prospectPage(paginationRows, state).items.length, 12)
  state = updatePagination(state, { type: 'search', value: 'ninguno' })
  assert.equal(prospectPage(paginationRows, state).range, '0 prospectos')
})

test('actualización conserva la página válida y ajusta al reducir el listado', async () => {
  const page3 = { ...initialPagination, page: 3 }
  assert.equal(updatePagination(page3, { type: 'refresh', rows: paginationRows }).page, 3)
  const reduced = paginationRows.slice(0, 6)
  const clamped = updatePagination(page3, { type: 'refresh', rows: reduced })
  assert.equal(clamped.page, 2)
  assert.equal(prospectPage(reduced, clamped).range, '6–6 de 6 prospectos')
  // A subsequent refresh must preserve page 2 rather than jumping back to page 3.
  assert.equal(updatePagination(clamped, { type: 'refresh', rows: paginationRows }).page, 2)
  assert.equal(updatePagination(page3, { type: 'refresh', rows: [] }).page, 1)
})

test('páginas compactas, página activa accesible y controles deshabilitados en límites', async () => {
  for (const count of [1, 5, 8, 20, 200]) {
    for (let page = 1; page <= count; page++) {
      const buttons = pageButtons(page, count)
      assert.ok(buttons.length <= 7)
      assert.ok(buttons.includes(page))
      assert.equal(buttons[0], 1)
      assert.equal(buttons.at(-1), count)
      assert.ok(buttons.every(item => item === 'ellipsis' || (item >= 1 && item <= count)))
    }
  }
  assert.ok(pageButtons(50, 100).includes('ellipsis'))
  const first = prospectPage(paginationRows, initialPagination)
  const render = (result: typeof first) => renderToStaticMarkup(createElement(Pagination, { result, pageSize: 5, loading: false, onSize: () => {}, onPage: () => {} }))
  const html = render(first)
  assert.match(html, /aria-label="Página 1" aria-current="page"/)
  assert.match(html, /disabled=""[^>]*>Anterior/)
  assert.match(html, /for="prospect-page-size"/)
  assert.match(render(prospectPage(paginationRows, { ...initialPagination, page: 5 })), /disabled=""[^>]*>Siguiente/)
})

test('formato monetario compartido: miles, dos decimales, cero y fracciones', async () => {
  assert.equal(formatMXN(500000), '$500,000.00 MXN')
  assert.equal(formatMXN(500000.5), '$500,000.50 MXN')
  assert.equal(formatMXN(0), '$0.00 MXN')
  assert.equal(formatMXN(12.34), '$12.34 MXN')
})

test('teléfono: normalización mexicana y agrupación visual sin inventar prefijos', async () => {
  for (const value of ['3521455896', '352 145 5896', '(352) 145-5896', '+52 (352) 145-5896', '52 352 145 5896', '  +52 352 145 5896  ']) {
    assert.equal(phoneSchema.parse(value), '3521455896')
    assert.equal(normalizePhone(value), '3521455896')
    assert.equal(formatPhone(value), '352 145 5896')
  }
  assert.equal(formatPhone(undefined), undefined)
  assert.equal(formatPhone('+1 212 555 0123'), '+1 212 555 0123')
  for (const value of ['+33 12345678', '+1 212 555 0123', '+44 20 1234 5678', '+3521455896', '352145589', '35214558960', '0052 3521455896', '+5213521455896', '3521455896 ext 12', '352abc1455896', '++52 3521455896', '352+1455896', '']) {
    const result = phoneSchema.safeParse(value)
    assert.equal(result.success, false, value)
    if (!result.success) assert.match(result.error.issues[0].message, /México.*10 dígitos/)
  }
  assert.equal(normalizePhone('+33 12345678'), '+3312345678')
  assert.equal(normalizePhone('35214558960'), '35214558960')
  assert.equal(phoneHasEvidence('3521455896', 'Mi teléfono es +52 (352) 145-5896.'), true)
  assert.equal(phoneHasEvidence('2125550123', '+1 212 555 0123'), false)
  assert.equal(phoneHasEvidence('3521455896', '++52 3521455896'), false)
  assert.equal(phoneHasEvidence('3521455896', '3521455896 ext 12'), false)
})

test('contacto renderizado: agrupación nacional y estados pendientes o rechazados', async () => {
  const repo = new SqliteRepository(':memory:')
  const detail = await new CRMService(repo, fake).createConversation()
  try {
    detail.customer.phone = '3521455896'
    detail.opportunity.collection.phone = 'answered'
    const render = () => renderToStaticMarkup(createElement(CommercialCard, { detail }))
    assert.match(render(), /352 145 5896/)
    assert.doesNotMatch(render(), /\+52/)
    assert.equal(detail.customer.phone, '3521455896')
    for (const status of ['pending', 'unknown', 'declined'] as const) {
      detail.opportunity.collection.phone = status
      assert.doesNotMatch(render(), /352 145 5896/)
    }
    assert.match(render(), /Prefiere no responder/)
  } finally { repo.close() }
})

test('ficha muestra ausencia de dudas como Sin dudas y Respondido', async () => {
  const repo = new SqliteRepository(':memory:')
  try {
    const detail = await new CRMService(repo, fake).createConversation()
    detail.opportunity.answers.questions = 'Sin dudas'
    detail.opportunity.collection.questions = 'answered'
    const html = renderToStaticMarkup(createElement(CommercialCard, { detail }))
    assert.match(html, /<dt>Dudas del cliente<\/dt><dd>Sin dudas<span class="field-state answered">Respondido/)
  } finally { repo.close() }
})

test('orden por fecha ascendente/descendente y empate estable sin mutaciones', async () => {
  const first = { ...paginationRows[0], id: 'a', lastInteraction: '2026-01-01T00:00:00.000Z' }
  const second = { ...paginationRows[1], id: 'b', lastInteraction: '2026-01-01T00:00:00.000Z' }
  const last = { ...paginationRows[2], id: 'c', lastInteraction: '2026-02-01T00:00:00.000Z' }
  const rows = [second, last, first]
  const snapshot = JSON.stringify(rows)
  assert.deepEqual(sortProspects(rows, 'recent').map(row => row.id), ['c', 'a', 'b'])
  assert.deepEqual(sortProspects(rows, 'oldest').map(row => row.id), ['a', 'b', 'c'])
  assert.equal(JSON.stringify(rows), snapshot)
})

test('orden español: mayúsculas y acentos equivalentes, ñ y nombres vacíos al final', async () => {
  const fixture = (id: string, name?: string): OpportunityListItem => ({ ...paginationRows[0], id, customer: { id, name } })
  const rows = [fixture('empty3', '  '), fixture('b', 'ÁLVARO'), fixture('z', 'Zoe'), fixture('empty1'), fixture('o', 'Olga'), fixture('n', 'Ñora'), fixture('empty2', ''), fixture('a', 'alvaro')]
  const original = JSON.stringify(rows)
  assert.deepEqual(sortProspects(rows, 'nameAsc').map(row => row.id), ['a', 'b', 'n', 'o', 'z', 'empty1', 'empty2', 'empty3'])
  assert.deepEqual(sortProspects(rows, 'nameDesc').map(row => row.id), ['z', 'o', 'n', 'a', 'b', 'empty1', 'empty2', 'empty3'])
  for (const order of ['nameAsc', 'nameDesc'] as const) {
    assert.deepEqual(sortProspects([...rows].reverse(), order), sortProspects(rows, order))
  }
  assert.equal(JSON.stringify(rows), original)
  // The placeholder is visual only; a real name containing it sorts normally.
  const withLiteral = [...rows, fixture('literal', 'Sin proporcionar')]
  assert.equal(sortProspects(withLiteral, 'nameAsc').findIndex(row => row.id === 'literal') < 5, true)
  const emptyHTML = renderToStaticMarkup(createElement(ProspectRow, { row: rows[0], blocked: false, selected: false, onOpen: () => {} }))
  assert.match(emptyHTML, /<h3>Sin proporcionar<\/h3>/)
})

test('orden y búsqueda globales antes de paginar; cambiar orden reinicia y actualizar lo conserva', async () => {
  const original = JSON.stringify(paginationRows)
  for (const order of ['recent', 'oldest', 'nameAsc', 'nameDesc'] as ProspectSort[]) {
    const state = updatePagination({ ...initialPagination, search: 'territory', page: 3 }, { type: 'order', value: order })
    assert.equal(state.page, 1)
    assert.equal(state.search, 'territory')
    const expected = sortProspects(filterProspects(paginationRows, 'territory'), order)
    const first = prospectPage(paginationRows, state)
    assert.equal(first.total, 12)
    assert.deepEqual(first.items, expected.slice(0, 5))
    assert.deepEqual(prospectPage(paginationRows, { ...state, page: 2 }).items, expected.slice(5, 10))
    const refreshed = updatePagination({ ...state, page: 2 }, { type: 'refresh', rows: paginationRows })
    assert.equal(refreshed.order, order)
    assert.equal(refreshed.page, 2)
    const reduced = updatePagination(refreshed, { type: 'refresh', rows: paginationRows.slice(0, 2) })
    assert.equal(reduced.order, order)
    assert.equal(reduced.page, 1)
  }
  assert.equal(JSON.stringify(paginationRows), original)
})
