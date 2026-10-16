import { api } from './api'
import { saveSession, selectOpportunity, type Session } from './session'

export async function openOpportunity(session: Session, id: string, blocked: boolean) {
  // Check before fetching: a blocked selection cannot alter browser or server state.
  selectOpportunity(session, id, blocked)
  const detail = await api.detail(id)
  const next = selectOpportunity(session, detail.opportunity.id, false)
  saveSession(next)
  return { detail, session: next }
}
