import type { Detail, OpportunityListItem } from '../shared/domain'
import type { CampaignAccessList } from '../shared/campaign'

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function request<T = Detail>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new ApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor. Comprueba que la API esté disponible.')
  }
  let body: unknown
  try { body = await response.json() } catch {
    throw new ApiError(response.status, 'INVALID_RESPONSE', 'El servidor no devolvió una respuesta válida.')
  }
  if (!response.ok) {
    const failure = body as { code?: string; message?: string } | null
    throw new ApiError(response.status, failure?.code ?? 'API_ERROR', failure?.message ?? 'No se pudo completar la operación.')
  }
  return body as T
}

export const api = {
  campaignEvents: (signal?: AbortSignal) => request<CampaignAccessList>('/api/campaign-events', { signal, cache: 'no-store' }),
  opportunities: (signal?: AbortSignal) => request<OpportunityListItem[]>('/api/opportunities', { signal }),
  createConversation: () => request('/api/conversations', { method: 'POST' }),
  detail: (id: string, signal?: AbortSignal) => request(`/api/opportunities/${encodeURIComponent(id)}`, { signal }),
  sendMessage: (id: string, message: { text: string; requestId: string }) => request(`/api/opportunities/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify(message) }),
}
