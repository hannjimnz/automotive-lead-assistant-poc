import { useEffect, useRef, useState } from 'react'
import { labels, vehicleName, type CollectionField, type OpportunityListItem } from '../../shared/domain'
import { api } from '../api'
import { initialPagination, prospectPage, updatePagination } from '../pagination'
import { Pagination } from './Pagination'
import { prospectSortOptions, type ProspectSort } from '../prospects'

const fieldNames: Record<CollectionField, string> = {
  name: 'Nombre', phone: 'Teléfono', email: 'Correo', vehicleId: 'Vehículo', timeframe: 'Temporalidad', intention: 'Intención', capacity: 'Capacidad', budget: 'Presupuesto', payment: 'Forma de pago', downPayment: 'Enganche', tradeIn: 'Vehículo a cuenta', tradeInBrand: 'Marca a cuenta', tradeInModel: 'Modelo a cuenta', tradeInYear: 'Año a cuenta', tradeInDetails: 'Detalles a cuenta', branch: 'Sucursal', action: 'Siguiente acción', questions: 'Dudas',
}
export function ProspectRow({ row, blocked, selected, onOpen }: { row: OpportunityListItem; blocked: boolean; selected: boolean; onOpen: (id: string) => void }) {
  const fields = Object.entries(row.collection) as [CollectionField, string][]
  const names = (status: string) => fields.filter(([, value]) => value === status).map(([field]) => fieldNames[field]).join(', ')
  const displayName = row.customer.name?.trim() || 'Sin proporcionar'
  return <article className="prospect-row" aria-label={`Prospecto: ${displayName}`}>
    <div className="prospect-identity"><h3>{displayName}</h3><p>{row.vehicleId ? vehicleName(row.vehicleId) : 'Sin proporcionar'}</p>{selected && <span className="badge subtle">Conversación seleccionada</span>}</div>
    <dl className="prospect-summary">
      <div><dt>Estado</dt><dd>{labels.status[row.status]}</dd></div>
      <div className="prospect-collection"><dt>Recopilación</dt><dd><span className="collection-pending">Pendientes: {names('pending') || 'Ninguno'}</span><span>No sabe: {names('unknown') || 'Ninguno'}</span><span>Prefiere no responder: {names('declined') || 'Ninguno'}</span></dd></div>
      <div><dt>Última actividad</dt><dd><time dateTime={row.lastInteraction}>{new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(row.lastInteraction))}</time></dd></div>
    </dl>
    <button className="secondary" disabled={blocked} onClick={() => onOpen(row.id)} aria-label={`Abrir conversación de ${displayName}${row.vehicleId ? ` sobre ${vehicleName(row.vehicleId)}` : ''}`}>Abrir</button>
  </article>
}

export function Prospects({ blocked, selectedId, onOpen }: { blocked: boolean; selectedId: string | null; onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<OpportunityListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pagination, setPagination] = useState(initialPagination)
  const request = useRef<AbortController | null>(null)

  async function load() {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError('')
    try {
      const next = await api.opportunities(controller.signal)
      if (!controller.signal.aborted) {
        setRows(next)
        setPagination(current => updatePagination(current, { type: 'refresh', rows: next }))
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'No se pudo recuperar el listado.')
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }
  useEffect(() => {
    // Reads only; safe when StrictMode replays the effect.
    const controller = new AbortController()
    request.current = controller
    void api.opportunities(controller.signal).then(next => {
      if (!controller.signal.aborted) {
        setRows(next)
        setPagination(current => updatePagination(current, { type: 'refresh', rows: next }))
      }
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'No se pudo recuperar el listado.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); request.current?.abort() }
  }, [])
  const result = prospectPage(rows, pagination)
  return <section className="card prospects" aria-labelledby="prospects-title" aria-busy={loading}>
    <div className="panel-heading"><div><p className="eyebrow">Conversaciones guardadas</p><h2 id="prospects-title">Prospectos</h2><p>Una oportunidad por interés · {prospectSortOptions[pagination.order].description}</p></div><button className="secondary" disabled={loading} onClick={() => void load()}>Actualizar listado</button></div>
    <div className="prospect-search">
      <div className="prospect-filters">
        <div className="prospect-search-control"><label htmlFor="prospect-search">Buscar por nombre o vehículo</label><input id="prospect-search" type="search" value={pagination.search} onChange={event => { const value = event.target.value; setPagination(current => updatePagination(current, { type: 'search', value })) }} placeholder="Nombre, Territory, Lobo…" /></div>
        <div className="prospect-sort-control"><label htmlFor="prospect-sort">Ordenar por</label><select id="prospect-sort" value={pagination.order} onChange={event => { const value = event.target.value as ProspectSort; setPagination(current => updatePagination(current, { type: 'order', value })) }}>{(Object.keys(prospectSortOptions) as ProspectSort[]).map(order => <option key={order} value={order}>{prospectSortOptions[order].label}</option>)}</select></div>
      </div>
      <p role="status">{loading ? 'Cargando prospectos…' : error ? 'No se pudo actualizar; los datos pueden estar desactualizados.' : `Orden seleccionado: ${prospectSortOptions[pagination.order].description}.`}</p>{blocked && <p className="notice">La selección está bloqueada mientras se procesa o confirma un envío. Puedes volver a Chat para revisar su estado.</p>}{error && <p className="error" role="alert">{error}</p>}
    </div>
    {!loading && !error && result.total === 0 && <div className="empty small"><h3>{rows.length ? 'No hay coincidencias' : 'Todavía no hay prospectos'}</h3><p>{rows.length ? 'Prueba otro nombre o vehículo.' : 'Las conversaciones que inicies en Chat aparecerán aquí.'}</p></div>}
    <div className="prospect-list">{result.items.map(row => <ProspectRow key={row.id} row={row} blocked={blocked || loading} selected={selectedId === row.id} onOpen={onOpen} />)}</div>
    <Pagination result={result} pageSize={pagination.pageSize} loading={loading} onSize={value => setPagination(current => updatePagination(current, { type: 'size', value }))} onPage={value => setPagination(current => updatePagination(current, { type: 'page', value }))} />
  </section>
}
