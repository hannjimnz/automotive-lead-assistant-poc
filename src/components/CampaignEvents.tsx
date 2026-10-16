import { useState } from 'react'
import { api } from '../api'
import type { CampaignAccessList } from '../../shared/campaign'
import { vehicleName } from '../../shared/domain'

export function CampaignEvents() {
  const [data, setData] = useState<CampaignAccessList | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  async function refresh() {
    if (loading) return
    setLoading(true)
    setError('')
    try { setData(await api.campaignEvents()) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudieron consultar los accesos.') }
    finally { setLoading(false) }
  }
  return <section className="card" aria-labelledby="campaign-events-title" aria-busy={loading}>
    <div className="panel-heading"><div><h2 id="campaign-events-title">Eventos de campaña</h2><p>Accesos al enlace · Simulación local</p></div><button type="button" className="secondary" disabled={loading} onClick={() => void refresh()}>Actualizar</button></div>
    <div className="campaign-content">
      <p>Se cuentan solicitudes al enlace, no leads ni usuarios únicos. Vistas previas, robots y recargas pueden generar accesos; estos registros no prueban interés humano.</p>
      <a className="text-button" href="/demo/campana">Ver campaña de simulación</a>
      <p role="status">{loading ? 'Consultando accesos…' : data ? `Total de accesos registrados: ${data.total}` : 'Pulsa Actualizar para consultar los accesos guardados.'}</p>
      {error && <p role="alert" className="error">{error}</p>}
      {data && data.events.length === 0 && <p className="muted">Aún no hay accesos registrados.</p>}
      <ol className="campaign-events">{data?.events.map(event => <li key={event.id}><strong>{event.campaignId}</strong><span>{vehicleName(event.vehicleId)}</span><time dateTime={event.createdAt}>{new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }).format(new Date(event.createdAt))} UTC</time></li>)}</ol>
    </div>
  </section>
}
