// Compare monetary meaning without rewriting the user's text or extracting other fields.
export function amountsIn(text: string): number[] {
  const matches = text.matchAll(/(?:\$\s*)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(millones|mill[oó]n|mil)\b)?/gi);
  return Array.from(matches, match => Number(match[1].replace(/,/g, '')) * (match[2] ? /^mil$/i.test(match[2]) ? 1000 : 1000000 : 1));
}

export function hasAmountRange(text: string): boolean {
  return amountsIn(text).length > 1 && /\d[\d,.]*(?:\s*(?:mil|millones?|mill[oó]n))?\s*(?:[–—-]|\ba\b|\bo\b|\by\b|\bhasta\b)\s*\$?\s*\d/i.test(text);
}

export function amountMatches(value: number, quote: string): boolean {
  if (/-\s*\$?\s*\d/.test(quote)) return false;
  const amounts = amountsIn(quote);
  if (!amounts.length) return value === 0 && /\bcero\b/i.test(quote);
  return amounts.length === 1 && amounts[0] === value;
}

function topics(text: string) {
  const result: string[] = [];
  if (/presupuesto|\btotal\b/i.test(text)) result.push('budget');
  if (/enganche/i.test(text)) result.push('downPayment');
  if (/mensual|al mes/i.test(text)) result.push('monthly');
  return result;
}

export function amountTopicMatches(field: 'budget' | 'downPayment', quote: string, message: string, askedField?: string): boolean {
  const explicit = topics(quote);
  if (explicit.length) return explicit.length === 1 && explicit[0] === field;
  const clause = message.split(/[;\n]|,\s+(?=[a-záéíóú])/i).find(part => part.includes(quote)) ?? message;
  const contextual = topics(clause);
  if (contextual.length) return contextual.length === 1 && contextual[0] === field;
  return !askedField || !['budget', 'downPayment'].includes(askedField) || askedField === field;
}
