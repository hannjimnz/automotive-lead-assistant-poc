import { useRef, useState } from 'react'
import { catalog, labels, missingBlocks, vehicleName, type CollectionField, type CollectionStatus, type Detail } from '../../shared/domain'
import { EvaluationBreakdown } from './EvaluationBreakdown'
import { formatMXN } from '../../shared/money'
import { formatPhone } from '../../shared/phone'

const states: Record<CollectionStatus, string> = { pending: 'Pendiente', answered: 'Respondido', unknown: 'No sabe', declined: 'Prefiere no responder', not_applicable: 'No aplica' }
const grades = { green: 'Verde', yellow: 'Amarillo', red: 'Rojo' }
const money = (value?: number) => value === undefined ? undefined : formatMXN(value)
const date = (value: string) => new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
const tabs = ['Información', 'Calificación', 'Historial'] as const

function Field({ label, value, status }: { label: string; value?: string; status?: CollectionStatus }) {
  const resolved = status ?? (value !== undefined ? 'answered' : 'pending')
  return <div className="field"><dt>{label}</dt><dd>{resolved === 'answered' ? value ?? 'Dato no disponible' : states[resolved]}<span className={`field-state ${resolved}`}>{states[resolved]}</span></dd></div>
}

export function CommercialCard({ detail }: { detail: Detail | null }) {
  const [tab, setTab] = useState<(typeof tabs)[number]>('Información')
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const o = detail?.opportunity
  const a = o?.answers
  const field = (key: CollectionField, label: string, value?: string) => <Field key={key} label={label} value={value} status={o?.collection?.[key]} />
  const latest = detail?.evaluations.at(-1)
  const score = latest ? latest.score : o?.score ?? null
  const grade = latest ? latest.grade : o?.grade
  const pending = o ? missingBlocks(o.answers, o.collection) : []
  const contactPending = o ? (['name', 'phone', 'email', 'vehicleId'] as const).filter(key => o.collection?.[key] === 'pending' || (!o.collection?.[key] && !(key === 'vehicleId' ? o.vehicleId : detail?.customer[key]))) : []
  return <section className="card commercial" aria-labelledby="card-title">
    <div className="panel-heading"><div><p className="eyebrow">Ficha comercial</p><h2 id="card-title">Información para el asesor</h2></div><span className="badge subtle">{o ? labels.status[o.status] : 'Sin conversación'}</span></div>
    <div className="tabs" role="tablist" aria-label="Secciones de la ficha">
      {tabs.map((name, index) => <button key={name} ref={element => { buttons.current[index] = element }} role="tab" id={`tab-${index}`} aria-controls={`panel-${index}`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)} onKeyDown={event => {
        let next: number | undefined
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
        if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
        if (event.key === 'Home') next = 0
        if (event.key === 'End') next = tabs.length - 1
        if (next !== undefined) { event.preventDefault(); setTab(tabs[next]); buttons.current[next]?.focus() }
      }}>{name}</button>)}
    </div>
    <div role="tabpanel" id={`panel-${tabs.indexOf(tab)}`} aria-labelledby={`tab-${tabs.indexOf(tab)}`} tabIndex={0} className="tab-content">
      {!detail || !o || !a ? <div className="empty small"><span className="empty-symbol" aria-hidden="true">≡</span><h3>Tu ficha se construye aquí</h3><p>Inicia una conversación. Los datos confirmados aparecerán conforme avance el chat.</p></div> : <>
        {tab === 'Información' && <>
          <h3>Contacto e interés</h3><dl className="fields">
            {field('name', 'Nombre', detail.customer.name)}{field('phone', 'Teléfono', formatPhone(detail.customer.phone))}{field('email', 'Correo electrónico', detail.customer.email)}{field('vehicleId', 'Vehículo de interés', o.vehicleId ? vehicleName(o.vehicleId) : undefined)}
          </dl><h3>Perfil de compra</h3><dl className="fields">
            {field('timeframe', 'Temporalidad', a.timeframe ? labels.timeframe[a.timeframe] : undefined)}{field('intention', 'Intención', a.intention ? labels.intention[a.intention] : undefined)}{field('capacity', 'Capacidad declarada', a.capacity ? labels.capacity[a.capacity] : undefined)}{field('budget', 'Presupuesto total', money(a.budget))}{field('payment', 'Forma de pago', a.payment ? labels.payment[a.payment] : undefined)}{field('downPayment', 'Enganche', money(a.downPayment))}{field('tradeIn', 'Vehículo a cuenta', a.tradeIn === undefined ? undefined : a.tradeIn ? 'Sí' : 'No')}{field('tradeInBrand', 'Marca', a.tradeInBrand)}{field('tradeInModel', 'Modelo', a.tradeInModel)}{field('tradeInYear', 'Año', a.tradeInYear?.toString())}{a.tradeInDetails !== undefined && field('tradeInDetails', 'Otros detalles', a.tradeInDetails)}
          </dl><h3>Seguimiento</h3><dl className="fields">
            {field('branch', 'Sucursal', a.branch ? catalog.branches.find(b => b.id === a.branch)?.name ?? a.branch : undefined)}{field('action', 'Acción solicitada', a.action ? labels.action[a.action] : undefined)}{field('questions', 'Dudas del cliente', a.questions)}<Field label="Siguiente paso registrado" value={o.nextAction} />
          </dl><p className="footnote">La acción solicitada no confirma una cita ni una reserva.</p>
        </>}
        {tab === 'Calificación' && <>
          <div className={`score-box ${score === null ? 'unclassified' : grade ?? 'unclassified'}`}><p className="eyebrow">Clasificación comercial</p><strong>{score === null ? 'Sin clasificar' : `${score} / 100`}</strong><span>{score === null ? 'Faltan criterios por abordar para calcular la puntuación.' : grade ? `Clasificación ${grades[grade].toLowerCase()}` : 'Sin color registrado'}</span></div>
          {score !== null && latest?.provisional && <p className="provisional-notice" role="status">Calificación provisional: hay datos desconocidos o no proporcionados</p>}
          <h3>Última evaluación</h3>{latest ? <><EvaluationBreakdown evaluation={latest} /><p className="footnote">Reglas v{latest.ruleVersion} · {date(latest.createdAt)}</p></> : <p className="muted">Todavía no hay evaluaciones guardadas.</p>}
          <div className="notice"><strong>Reglas de demostración</strong><p>La puntuación usa temporalidad, intención y capacidad declarada. No asigna puntos por vehículo ni constituye una evaluación crediticia.</p></div>
          <h3>Recopilación de información</h3><p>La clasificación y los datos pendientes se muestran por separado.</p>{pending.length || contactPending.length ? <ul className="pending-list">{contactPending.length > 0 && <li>Contacto y vehículo de interés ({contactPending.length} campos)</li>}{pending.map(block => <li key={block}>{block}</li>)}</ul> : <p className="muted">No hay bloques pendientes. Los campos desconocidos o rechazados conservan su estado.</p>}
        </>}
        {tab === 'Historial' && <>
          <h3>Eventos guardados</h3><ol className="timeline">{[...detail.events].reverse().map(event => <li key={event.id}><strong>{event.type === 'message_failed' ? 'Mensaje no procesado' : event.description}</strong>{event.type === 'message_failed' && <span>El intento quedó registrado; consulta el estado en el chat.</span>}<time dateTime={event.createdAt}>{date(event.createdAt)}</time></li>)}</ol>
          <h3>Evaluaciones guardadas</h3>{detail.evaluations.length ? <ol className="timeline">{[...detail.evaluations].reverse().map(evaluation => <li key={evaluation.id}><strong>{evaluation.score === null ? 'Sin clasificar' : `${evaluation.score} puntos · ${evaluation.grade ? grades[evaluation.grade] : 'Sin color'}`}</strong>{evaluation.provisional && <span>Datos provisionales</span>}<span>Reglas v{evaluation.ruleVersion}</span><EvaluationBreakdown evaluation={evaluation} /><time dateTime={evaluation.createdAt}>{date(evaluation.createdAt)}</time></li>)}</ol> : <p className="muted">Todavía no hay evaluaciones.</p>}
        </>}
      </>}
    </div>
  </section>
}
