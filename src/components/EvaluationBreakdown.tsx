import { scoringFields, type Evaluation } from '../../shared/domain'

const names = { timeframe: 'Temporalidad', intention: 'Intención', capacity: 'Capacidad' }

export function EvaluationBreakdown({ evaluation }: { evaluation: Evaluation }) {
  if (!evaluation.criteria) return <><dl className="breakdown">{Object.entries(evaluation.breakdown).map(([name, points]) => <div key={name}><dt>{name}</dt><dd>{points === null ? 'Pendiente' : `${points} puntos`}</dd></div>)}</dl><p className="footnote">Evaluación histórica: no se registraron estados ni provisionalidad.</p></>
  return <dl className="breakdown">{scoringFields.map(field => {
    const criterion = evaluation.criteria![field]
    const pending = criterion.points === null
    const state = pending ? criterion.status === 'not_applicable' ? 'Estado no válido para clasificar' : criterion.status === 'answered' ? 'Respuesta no válida' : 'Pendiente de abordar' : criterion.status === 'unknown' ? 'No sabe' : criterion.status === 'declined' ? 'Prefiere no responder' : 'Respondido'
    return <div key={field} className={pending ? 'criterion-pending' : 'criterion-scored'}><dt>{names[field]}<span className="criterion-status">{state}</span></dt><dd>{pending ? 'Pendiente' : `${criterion.points} puntos`}</dd></div>
  })}</dl>
}
