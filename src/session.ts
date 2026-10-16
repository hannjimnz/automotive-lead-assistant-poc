import type { Detail } from '../shared/domain'
export interface PendingSend { text: string; requestId: string }
interface Workspace { draft: string; pending: PendingSend | null }
export interface Session { opportunityId: string | null; pending: PendingSend | null; draft?: string; workspaces?: Record<string, Workspace> }
const key = 'pasa.chat.session.v1'

export function readSession(): Session {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Session | null
    if (!value || typeof value.opportunityId !== 'string') return { opportunityId: null, pending: null }
    const pending = value.pending
    const workspaces: Record<string, Workspace> = Object.create(null)
    for (const [id, workspace] of Object.entries(value.workspaces ?? {})) {
      if (workspace && typeof workspace.draft === 'string') workspaces[id] = { draft: workspace.draft, pending: validPending(workspace.pending) }
    }
    return { opportunityId: value.opportunityId, pending: validPending(pending), draft: typeof value.draft === 'string' ? value.draft : '', workspaces }
  } catch { return { opportunityId: null, pending: null } }
}

function validPending(value: PendingSend | null): PendingSend | null {
  return value && typeof value.text === 'string' && typeof value.requestId === 'string' ? { text: value.text, requestId: value.requestId } : null
}

export function rememberSession(session: Session): Session {
  if (!session.opportunityId) return session
  return { ...session, workspaces: { ...session.workspaces, [session.opportunityId]: { draft: session.draft ?? '', pending: session.pending } } }
}

export function selectOpportunity(session: Session, id: string, blocked: boolean): Session {
  if (blocked) throw new Error('Espera a que termine el envío y se confirme su estado antes de cambiar de oportunidad.')
  const remembered = rememberSession(session)
  const target = Object.hasOwn(remembered.workspaces ?? {}, id) ? remembered.workspaces![id] : undefined
  return { ...remembered, opportunityId: id, draft: target?.draft ?? '', pending: target?.pending ?? null }
}

export function saveSession(value: Session) {
  try { sessionStorage.setItem(key, JSON.stringify(value)) } catch {
    throw new Error('No se pudo guardar la sesión en este navegador. Habilita el almacenamiento de sesión antes de enviar mensajes.')
  }
}

export function reconcilePending(pending: PendingSend | null, detail: Detail): 'none' | 'complete' | 'stale' | 'conflict' | 'retry' {
  if (!pending) return 'none'
  const index = detail.messages.findIndex(message => message.role === 'user' && message.requestId === pending.requestId)
  const stored = detail.messages[index]
  if (stored && stored.text !== pending.text) return 'conflict'
  if (stored?.status === 'complete') return 'complete'
  if (index >= 0 && detail.messages.slice(index + 1).some(message => message.role === 'user')) return 'stale'
  return 'retry'
}
