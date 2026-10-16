import { vehicleName, type OpportunityListItem } from '../shared/domain'

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

export const prospectSortOptions = {
  recent: { label: 'Más recientes', description: 'Última actividad: más recientes primero' },
  oldest: { label: 'Más antiguos', description: 'Última actividad: más antiguos primero' },
  nameAsc: { label: 'Nombre A–Z', description: 'Nombre: A–Z · Sin nombre al final' },
  nameDesc: { label: 'Nombre Z–A', description: 'Nombre: Z–A · Sin nombre al final' },
} as const
export type ProspectSort = keyof typeof prospectSortOptions
const names = new Intl.Collator('es', { sensitivity: 'base' })

export function sortProspects(rows: OpportunityListItem[], order: ProspectSort): OpportunityListItem[] {
  return [...rows].sort((a, b) => {
    let difference: number
    if (order === 'nameAsc' || order === 'nameDesc') {
      const first = a.customer.name?.trim() ?? ''
      const second = b.customer.name?.trim() ?? ''
      if (!first || !second) difference = Number(!first) - Number(!second)
      else difference = names.compare(first, second) * (order === 'nameDesc' ? -1 : 1)
    } else {
      difference = (Date.parse(a.lastInteraction) - Date.parse(b.lastInteraction)) * (order === 'recent' ? -1 : 1)
    }
    // IDs provide a total, deterministic tie-break independent of fetch/input order.
    return difference || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
}

export function filterProspects(rows: OpportunityListItem[], search: string) {
  const query = normalize(search.trim())
  return rows.filter(row => normalize(`${row.customer.name ?? ''} ${row.vehicleId ? vehicleName(row.vehicleId) : ''}`).includes(query))
}
