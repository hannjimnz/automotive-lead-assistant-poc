const mxn = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  currencyDisplay: 'narrowSymbol',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

// Only call for known monetary fields, never for arbitrary conversation text.
export function formatMXN(value: number): string {
  return `${mxn.format(value)} MXN`
}
