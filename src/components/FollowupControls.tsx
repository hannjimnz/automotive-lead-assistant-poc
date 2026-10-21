import type { Detail } from '../../shared/domain'
import { followupState } from '../../shared/followup'

export function FollowupControls({ detail, blocked, onSimulate }: { detail: Detail; blocked: boolean; onSimulate: (attempt: 1 | 2, cycleId: string) => void }) {
  const state = followupState(detail)
  return <section className="followup-controls" aria-labelledby="followup-title">
    <h3 id="followup-title">Simulación de seguimiento</h3>
    <p>Mensajes internos del chat. Simula el vencimiento de esta conversación; no cambia el reloj ni las fechas guardadas.</p>
    {([1, 2] as const).map(attempt => {
      const reason = blocked ? 'Espera a que termine la operación o resuelve el envío pendiente.' : attempt === 1 ? state.firstReason : state.lastReason
      return <div key={attempt}><button type="button" className="secondary" disabled={Boolean(reason)} aria-describedby={`followup-reason-${attempt}`} onClick={() => state.cycleId && onSimulate(attempt, state.cycleId)}>Simular recordatorio de {attempt === 1 ? 24 : 48} h</button><p id={`followup-reason-${attempt}`} className="footnote">{reason || 'Disponible para este ciclo.'}</p></div>
    })}
  </section>
}
