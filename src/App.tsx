import { useEffect, useRef, useState } from 'react'
import type { Detail } from '../shared/domain'
import { api, ApiError } from './api'
import { readSession, saveSession, reconcilePending, rememberSession, selectOpportunity, type PendingSend, type Session } from './session'
import { CommercialCard } from './components/CommercialCard'
import { Prospects } from './components/Prospects'
import { openOpportunity } from './openOpportunity'
import { ThemeToggle } from './components/ThemeToggle'
import './App.css'

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'No se pudo completar la operación.'

function App() {
  const [session, setSession] = useState<Session>(readSession)
  const sessionRef = useRef(session)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [draft, setDraft] = useState(session.draft ?? '')
  const [view, setView] = useState<'Chat' | 'Prospectos'>('Chat')
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const generation = useRef(0)
  const [loading, setLoading] = useState(Boolean(session.opportunityId))
  const [error, setError] = useState('')
  const [retryBlocked, setRetryBlocked] = useState(false)
  const [verified, setVerified] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const serverPending = detail?.messages.some(message => message.status === 'pending') ?? false
  const [missingRecord, setMissingRecord] = useState(false)
  const persistedAttempt = detail?.messages.find(message => message.role === 'user' && message.requestId === session.pending?.requestId)
  const unresolvedSend = Boolean(session.pending && (!persistedAttempt || persistedAttempt.status === 'pending'))
  const switchBlocked = busy || loading || serverPending || (unresolvedSend && !missingRecord) || Boolean(session.opportunityId && !verified && !missingRecord)

  function persist(next: Session) {
    const remembered = rememberSession(next)
    saveSession(remembered)
    sessionRef.current = remembered
    setSession(remembered)
  }

  function acceptDetail(next: Detail) {
    if (next.opportunity.id !== sessionRef.current.opportunityId) return
    setDetail(next)
    setVerified(true)
    setMissingRecord(false)
    const current = sessionRef.current
    const result = reconcilePending(current.pending, next)
    if (result === 'none') { setRetryBlocked(false); return }
    if (result === 'complete') {
      persist({ ...current, pending: null })
      setRetryBlocked(false)
      setError('')
    } else {
      const stale = result === 'stale'
      const conflict = result === 'conflict'
      setRetryBlocked(stale || conflict)
      if (stale) setError('Este intento tiene mensajes posteriores y ya no puede reintentarse. Puedes continuar con otro mensaje.')
      if (conflict) setError('Este requestId corresponde a otro texto. Puedes continuar con otro mensaje.')
      const stored = next.messages.find(message => message.role === 'user' && message.requestId === current.pending?.requestId)
      if (!stale && !conflict && stored?.status === 'error') {
        setError(previous => previous || 'El servidor guardó este mensaje como no procesado. Puedes reintentarlo o continuar con otro mensaje.')
      }
    }
  }

  // Only read on mount/reload. Conversation creation always requires a click.
  useEffect(() => {
    const id = session.opportunityId
    if (!id) return
    const controller = new AbortController()
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function recover() {
      const requestGeneration = generation.current
      try {
        const next = await api.detail(id!, controller.signal)
        if (cancelled || requestGeneration !== generation.current) return
        acceptDetail(next)
        setLoading(false)
        if (next.messages.some(message => message.status === 'pending')) timer = setTimeout(recover, 2000)
      } catch (failure) {
        if (cancelled || requestGeneration !== generation.current) return
        setError(errorMessage(failure))
        setLoading(false)
        setVerified(false)
        setMissingRecord(failure instanceof ApiError && failure.code === 'NOT_FOUND')
      }
    }
    void recover()
    return () => { cancelled = true; controller.abort(); clearTimeout(timer) }
    // The opportunity ID is the lifecycle boundary; pending sends use sessionRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.opportunityId])

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }, [detail?.messages.length, busy, session.pending])
  useEffect(() => { if (view === 'Chat' && detail && verified && !busy && !loading && !serverPending && !session.pending) inputRef.current?.focus() }, [view, detail, verified, busy, loading, serverPending, session.pending])

  function changeDraft(text: string) {
    setDraft(text)
    try { persist({ ...sessionRef.current, draft: text }) } catch (failure) { setError(errorMessage(failure)) }
  }

  async function open(id: string) {
    if (locked.current || switchBlocked) return
    locked.current = true
    generation.current++
    setBusy(true)
    setError('')
    try {
      const opened = await openOpportunity({ ...sessionRef.current, draft }, id, false)
      persist(opened.session)
      setDraft(opened.session.draft ?? '')
      setRetryBlocked(false)
      setView('Chat')
      acceptDetail(opened.detail)
    } catch (failure) { setError(errorMessage(failure)) }
    finally { locked.current = false; setBusy(false) }
  }

  async function refresh() {
    if (locked.current || !sessionRef.current.opportunityId) return
    locked.current = true
    generation.current++
    setBusy(true)
    setError('')
    try { acceptDetail(await api.detail(sessionRef.current.opportunityId)) } catch (failure) { setError(errorMessage(failure)); setVerified(false); setMissingRecord(failure instanceof ApiError && failure.code === 'NOT_FOUND') }
    finally { locked.current = false; setBusy(false); setLoading(false) }
  }

  async function start() {
    if (locked.current || serverPending || loading || (unresolvedSend && !missingRecord) || (sessionRef.current.opportunityId && !verified && !missingRecord)) return
    locked.current = true
    generation.current++
    setBusy(true)
    setError('')
    try {
      // Check storage before creating a record, so a disabled browser store cannot lose it.
      saveSession(sessionRef.current)
      const next = await api.createConversation()
      persist(selectOpportunity({ ...sessionRef.current, draft }, next.opportunity.id, false))
      setDetail(next)
      setVerified(true)
      setMissingRecord(false)
      setRetryBlocked(false)
      setDraft('')
      setView('Chat')
    } catch (failure) { setError(errorMessage(failure)) }
    finally { locked.current = false; setBusy(false) }
  }

  async function send(retry = false) {
    const current = sessionRef.current
    if (locked.current || serverPending || loading || !verified || !current.opportunityId || (retry && retryBlocked)) return
    const pending: PendingSend | null = retry ? current.pending : draft.trim() ? { text: draft, requestId: crypto.randomUUID() } : null
    if (!pending || (!retry && current.pending)) return
    locked.current = true
    generation.current++
    setBusy(true)
    setError('')
    try {
      persist({ ...current, pending, draft: '' })
      setDraft('')
      const next = await api.sendMessage(current.opportunityId, pending)
      acceptDetail(next)
    } catch (failure) {
      setError(errorMessage(failure))
      if (failure instanceof ApiError && ['STALE_REQUEST', 'REQUEST_ID_CONFLICT'].includes(failure.code)) setRetryBlocked(true)
      // A failed HTTP response may follow a committed server write. Always reconcile.
      try { acceptDetail(await api.detail(current.opportunityId)) }
      catch { setVerified(false); setError(`${errorMessage(failure)} No se pudo recuperar la ficha. Actualiza el estado antes de continuar.`) }
    } finally { locked.current = false; setBusy(false) }
  }

  function continueWithNewMessage() {
    if (busy || serverPending || unresolvedSend || !verified) return
    try { persist({ ...sessionRef.current, pending: null }); setRetryBlocked(false); setError(''); inputRef.current?.focus() } catch (failure) { setError(errorMessage(failure)) }
  }

  const localPending = session.pending && !detail?.messages.some(message => message.role === 'user' && message.requestId === session.pending?.requestId)
  const cannotSend = busy || loading || serverPending || !verified || !detail || Boolean(session.pending)

  return <div className="app-shell">
    <header className="app-header"><div className="brand"><span className="brand-mark" aria-hidden="true">P</span><div><h1>PASA · Asistente comercial</h1><p>Una conversación. Toda la información a la mano.</p></div><span className="badge">Demo</span></div><div className="header-actions"><ThemeToggle /><button className="secondary" onClick={() => void start()} disabled={busy || loading || serverPending || (unresolvedSend && !missingRecord) || Boolean(session.opportunityId && !verified && !missingRecord)}>{detail || session.opportunityId ? 'Nueva conversación' : 'Iniciar conversación'}</button></div></header>
    <nav className="main-nav" aria-label="Navegación principal">{(['Chat', 'Prospectos'] as const).map(name => <button key={name} aria-current={view === name ? 'page' : undefined} onClick={() => setView(name)}>{name}</button>)}</nav>
    {view === 'Prospectos' && <main>{error && <p className="error" role="alert">{error}</p>}<Prospects blocked={switchBlocked} selectedId={session.opportunityId} onOpen={id => void open(id)} /></main>}
    <main className="workspace" hidden={view !== 'Chat'}>
      <section className="card chat" aria-labelledby="chat-title" aria-busy={busy || loading}>
        <div className="panel-heading"><div className="assistant-heading"><span className="avatar" aria-hidden="true">P</span><div><h2 id="chat-title">Asistente PASA</h2><p>Te ayudamos a preparar tu siguiente paso</p></div></div><span className="badge subtle">Chat local</span></div>
        <div className="chat-messages" role="log" aria-label="Mensajes de la conversación" aria-live="polite" aria-relevant="additions text">
          {loading ? <p className="loading">Recuperando conversación…</p> : !detail ? <div className="empty"><span className="empty-symbol" aria-hidden="true">↗</span><p className="eyebrow">Bienvenido a PASA</p><h2>Tu próximo vehículo<br />empieza con una conversación</h2><p>Cuéntanos qué buscas. Registraremos tu interés y los datos que quieras compartir para un asesor.</p>{!session.opportunityId && <button className="primary" onClick={() => void start()} disabled={busy}>Iniciar conversación</button>}<span className="footnote">Catálogo de demostración · Sin reservas reales</span></div> : <>
            {detail.messages.map(message => <article className={`message ${message.role}`} key={message.id}><span className="message-author">{message.role === 'user' ? 'Tú' : 'Asistente PASA'}</span><p>{message.text}</p><div className="message-meta"><time dateTime={message.createdAt}>{new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt))}</time>{message.role === 'user' && <span>{message.status === 'pending' ? 'En proceso' : message.status === 'error' ? 'No procesado' : 'Procesado'}</span>}</div></article>)}
            {localPending && session.pending && <article className="message user"><span className="message-author">Tú</span><p>{session.pending.text}</p><span className="message-meta">{busy ? 'Enviando…' : 'Resultado pendiente de confirmar'}</span></article>}
          </>}
          <div ref={endRef} />
        </div>
        <div className="chat-controls">
          <div role="status" className="status-line">{busy ? 'Procesando…' : serverPending ? 'El servidor está procesando un mensaje. Actualiza el estado antes de continuar.' : session.pending ? 'Hay un envío pendiente. Reintentar conserva exactamente su texto e identificador.' : detail ? 'Puedes compartir varios datos en un mismo mensaje.' : 'Inicia una conversación para escribir.'}</div>
          {error && <p className="error" role="alert">{error}</p>}
          {(session.pending || error || serverPending || (session.opportunityId && !detail && !loading)) && <div className="recovery-actions">
            {session.pending && <button className="primary" disabled={busy || loading || serverPending || retryBlocked || !verified} onClick={() => void send(true)}>Reintentar mensaje</button>}
            {session.opportunityId && <button className="secondary" disabled={busy || loading} onClick={() => void refresh()}>Actualizar estado</button>}
            {session.pending && <button className="text-button" disabled={busy || loading || serverPending || unresolvedSend || !verified} onClick={continueWithNewMessage}>Continuar con otro mensaje</button>}
          </div>}
          <form onSubmit={event => { event.preventDefault(); void send() }}><label htmlFor="message">Tu mensaje</label><div className="composer"><textarea ref={inputRef} id="message" value={draft} onChange={event => changeDraft(event.target.value)} placeholder="Escribe aquí lo que estás buscando…" rows={2} maxLength={8000} disabled={cannotSend} /><button className="primary" type="submit" disabled={cannotSend || !draft.trim()}>Enviar <span aria-hidden="true">↗</span></button></div><p className="footnote">Demo local. Las condiciones comerciales se confirman con un asesor.</p></form>
        </div>
      </section>
      <CommercialCard detail={detail} />
    </main>
    <footer className="app-footer">PASA · Demostración de atención comercial <span>Datos y reglas de ejemplo</span></footer>
  </div>
}

export default App
