import type { OpportunityListItem } from '../shared/domain'
import { filterProspects, sortProspects, type ProspectSort } from './prospects'

export const pageSizes = [5, 10, 20] as const
export type PageSize = (typeof pageSizes)[number]
export interface PaginationState { search: string; pageSize: PageSize; page: number; order: ProspectSort }
export const initialPagination: PaginationState = { search: '', pageSize: 5, page: 1, order: 'recent' }
type Action = { type: 'search'; value: string } | { type: 'order'; value: ProspectSort } | { type: 'size'; value: PageSize } | { type: 'page'; value: number } | { type: 'refresh'; rows: OpportunityListItem[] }

export function updatePagination(state: PaginationState, action: Action): PaginationState {
  if (action.type === 'search') return { ...state, search: action.value, page: 1 }
  if (action.type === 'size') return { ...state, pageSize: action.value, page: 1 }
  if (action.type === 'order') return { ...state, order: action.value, page: 1 }
  if (action.type === 'page') return { ...state, page: action.value }
  return { ...state, page: prospectPage(action.rows, state).page }
}

export function pageButtons(page: number, count: number): (number | 'ellipsis')[] {
  if (count <= 7) return Array.from({ length: count }, (_, index) => index + 1)
  const start = Math.max(2, Math.min(page - 1, count - 3))
  const selected = [1, start, start + 1, start + 2, count]
  const buttons: (number | 'ellipsis')[] = []
  for (const number of selected) {
    const previous = buttons.at(-1)
    if (typeof previous === 'number') {
      if (number - previous === 2) buttons.push(previous + 1)
      else if (number - previous > 2) buttons.push('ellipsis')
    }
    buttons.push(number)
  }
  return buttons
}

export function prospectPage(rows: OpportunityListItem[], state: PaginationState) {
  const filtered = sortProspects(filterProspects(rows, state.search), state.order)
  const total = filtered.length
  const pageCount = Math.ceil(total / state.pageSize)
  const page = Math.max(1, Math.min(state.page, pageCount || 1))
  const offset = (page - 1) * state.pageSize
  const start = total ? offset + 1 : 0
  const end = Math.min(offset + state.pageSize, total)
  return { items: filtered.slice(offset, offset + state.pageSize), total, pageCount, page, start, end, range: total ? `${start}–${end} de ${total} prospectos` : '0 prospectos', buttons: pageButtons(page, pageCount) }
}
