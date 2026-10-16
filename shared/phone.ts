import { z } from 'zod'

export const phoneValidationMessage = 'Esta demostración admite teléfonos de México: 10 dígitos nacionales, con espacios, guiones o paréntesis, y opcionalmente el código +52. No se admiten otros códigos de país ni extensiones. ¿Puedes confirmar el número y si corresponde a México?'

export function normalizePhone(value: string): string {
  const compact = value.replace(/[\s().-]/g, '')
  // Strip exactly one Mexican country code, only with a full national number.
  if (/^(?:\+52|52)\d{10}$/.test(compact)) return compact.slice(-10)
  return compact
}

export const phoneSchema = z.string().max(100, phoneValidationMessage)
  .transform(normalizePhone)
  .pipe(z.string().regex(/^\d{10}$/, phoneValidationMessage))

export function formatPhone(value?: string): string | undefined {
  if (value === undefined) return undefined
  const result = phoneSchema.safeParse(value)
  // Preserve out-of-scope historical values as supplied, without guessing.
  if (!result.success) return value
  const phone = result.data
  return `${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6)}`
}

export function phoneHasEvidence(normalized: string, quote: string): boolean {
  // Validate the cited number as well: the extractor must not drop a foreign code.
  const candidates = quote.matchAll(/\+*\d[\d\s()+.-]*\d/g)
  return Array.from(candidates).some(candidate => {
    const suffix = quote.slice(candidate.index + candidate[0].length)
    if (/^\s*(?:ext(?:ensi[oó]n)?\.?|extension|x|#)\s*\d/i.test(suffix)) return false
    const parsed = phoneSchema.safeParse(candidate[0])
    return parsed.success && parsed.data === normalized
  })
}
