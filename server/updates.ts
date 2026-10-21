import { randomUUID } from 'node:crypto';
import { answersSchema, identitySchema, catalog, labels, missingBlocks, commercialSummary, noQuestionsValue, type Answers, type CollectionField, type Detail, type Message, type DataProposal, type StagedTradeInDetail } from '../shared/domain.js';
import { formatMXN } from '../shared/money.js';
import { formatPhone, phoneHasEvidence, phoneValidationMessage } from '../shared/phone.js';
import type { AgentOutput } from './agent.js';
import { amountMatches, amountTopicMatches, amountsIn, hasAmountRange } from './amount-evidence.js';

type Update = AgentOutput['updates'][number];
export const fieldLabels: Record<CollectionField, string> = {
  name: 'nombre', phone: 'teléfono', email: 'correo', vehicleId: 'vehículo de interés', timeframe: 'temporalidad', intention: 'intención', capacity: 'capacidad declarada', budget: 'presupuesto', payment: 'forma de pago', downPayment: 'enganche', tradeIn: 'vehículo a cuenta', tradeInBrand: 'marca a cuenta', tradeInModel: 'modelo a cuenta', tradeInYear: 'año a cuenta', tradeInDetails: 'detalles a cuenta', branch: 'sucursal', action: 'siguiente acción', questions: 'dudas',
};
const normalized = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const ambiguous = (text: string) => /\b(quiza|tal vez|puede ser|creo\b|podria|no estoy segur|a lo mejor|no se si\b|aun no decido|me lo pienso)/.test(normalized(text));
const affirmative = (text: string) => /^(si|correcto|correcta|confirmo|de acuerdo)[.!\s]*$/.test(normalized(text));
const negative = (text: string) => /^(no|incorrecto|incorrecta|no confirmo)[.!\s]*$/.test(normalized(text));
const tradeInNegative = (text: string) => /^(?:no+p?|ningun[oa]|nada|no tengo(?: (?:ningun[oa](?: vehiculo| auto)?|(?:un )?(?:vehiculo|auto)(?: a cuenta)?|nada))?)(?:[, ]+(?:gracias|por ahora))?[.! ]*$/.test(normalized(text));
const mentions: Partial<Record<CollectionField, RegExp>> = {
  name: /nombre|llamo/, phone: /telefon|numero|celular/, email: /correo|email/, vehicleId: /vehiculo|interes|busco/, timeframe: /fecha|plazo|dias|meses|comprar|temporalidad/,
  intention: /intencion|comparo|comparar|explor|avanzar/, capacity: /recursos|capacidad|dinero disponible/, budget: /presupuesto/, payment: /pago|credito|contado/, downPayment: /enganche/,
  tradeIn: /a cuenta|auto|vehiculo/, tradeInBrand: /marca/, tradeInModel: /modelo/, tradeInYear: /ano/, branch: /sucursal/, action: /cita|llamada|accion|prueba|seguimiento/, questions: /dudas|preguntas/,
};
const asksConfirmation = (text: string) => (text.match(/¿[^?]*\?/g) ?? []).some(question => /\bconfirm|es correcto|esta bien|es ese/.test(normalized(question)));
const vagueTimeframe = (text: string) => /\bmas adelante\b/.test(normalized(text)) && !/\d|mes|fecha|semana|ano/.test(normalized(text));
const unclearRejection = (text: string) => /^(nop\b|no[, ]+ese no\b)/.test(normalized(text));
const withinThirtyDaysWeek = (text: string) => text.match(/\b(?:(?:la\s+)?(?:pr[oó]xima|siguiente)\s+semana|(?:la\s+)?semana\s+que\s+viene|la\s+semana\s+(?:que\s+entra|entrante)|(?:en|dentro\s+de)\s+(?:una|dos|tres|cuatro|1|2|3|4)\s+semanas?)\b/i);
function asksColorsAndVersions(text: string): boolean {
  const value = normalized(text);
  const asksCatalogVehicles = /catalogo/.test(value) && /vehiculos?/.test(value) && /\b(?:aparecen|hay|incluye|muestra|lista|ofrecen)\b/.test(value);
  return !asksCatalogVehicles && /\bcolor(?:es)?\b/.test(value) && /\b(?:modelos?|versiones?|ediciones?)\b/.test(value);
}
const briefContactRefusal = (text: string) => /^(?:nop(?:[, ]+no quiero)?|no(?:[, ]+gracias)?|no te lo doy|no quiero|prefiero no|no deseo)[.! ]*$/.test(normalized(text));
const contactRefusal = /\b(?:no (?:doy|comparto|digo|proporciono|facilito|entrego)|(?:prefiero|quiero|deseo) no (?:dar|compartir|decir|proporcionar|facilitar)|no (?:quiero|deseo|voy a) (?:dar|compartir|proporcionar|facilitar))\b/;
const typoBrand = (text: string) => {
  const match = text.match(/\bvolsvaguen\b/i);
  if (match && /\bno\s+(?:es|era|ser[aá])\s*$/i.test(text.slice(0, match.index))) return undefined;
  return match ? { value: 'Volkswagen', quote: match[0] } : undefined;
};
// Only explicit, scoped contact refusals; absence of a contact value is not a refusal.
function contactRefusals(text: string): Update[] {
  return text.split(/[.;!?\n,]|\bpero\b|\baunque\b|\by (?=(?:s[ií] |mi |el |quiero |doy |comparto ))/i).flatMap(clause => {
    const value = normalized(clause);
    if (!contactRefusal.test(value) || /\b(?:de mi|de su|de otra|ajeno)\b/.test(value)) return [];
    return (['phone', 'email'] as const).filter(field => mentions[field]!.test(value))
      .map(field => ({ field, status: 'declined' as const, value: null, quote: clause.trim(), mode: 'apply' as const }));
  });
}
function invalidContacts(text: string): Update[] {
  const phone = text.match(/\b(?:tel[eé]fono|celular|n[uú]mero)(?:\s+es|\s*:)?\s+([+\d][\d ()+.-]*)/i);
  const email = text.match(/[^\s,;!?]+@[^\s,;!?]*/);
  const candidates: Update[] = [];
  if (phone) candidates.push({ field: 'phone', status: 'answered', value: phone[1].trim(), quote: phone[0].trim(), mode: 'apply' });
  if (email) candidates.push({ field: 'email', status: 'answered', value: email[0].replace(/\.$/, ''), quote: email[0], mode: 'apply' });
  return candidates.filter(update => !validate(update).valid);
}
function resolvedQuestions(text: string): string | undefined {
  const match = text.match(/\b(?:ya (?:se (?:resolvi[oó]|aclar[oó])|resolv[ií]|aclar[eé]) (?:mi |la |esa |esta )?(?:duda|pregunta)|(?:ya )?se (?:resolvieron|aclararon)(?: (?:las? )?(?:dudas?|preguntas?)(?: (?:de|sobre) [^.;!?]*)?)?|(?:ya )?me (?:contestaron|respondieron) (?:eso|todo|esas? (?:dudas?|preguntas?)|las? (?:dudas?|preguntas?)|lo de [^.;!?]*)|(?:ya )?(?:quedaron|est[aá]n) (?:resueltas?|aclaradas?) (?:las? )?(?:dudas?|preguntas?)(?: (?:de|sobre) [^.;!?]*)?|(?:mi|la|esa|esta) (?:duda|pregunta) (?:ya )?(?:qued[oó]|est[aá]) (?:resuelta|aclarada))\b/i);
  if (!match) {
    const standalone = text.match(/\bya se (?:resolvi[o\u00f3]|aclar[o\u00f3])(?=$|[,.!?;]|\s+(?:y|pero|aunque)\b)/i);
    if (!standalone) return undefined;
    const prefix = normalized(text.slice(0, standalone.index).split(/[.;!?\n,]/).at(-1) ?? '');
    if (/¿|\b(?:no|si|cuando)\b/.test(prefix)) return undefined;
    return standalone[0];
  }
  const prefix = normalized(text.slice(0, match.index).split(/[.;!?\n,]/).at(-1) ?? '');
  if (/¿|\b(?:no|si|cuando)\b/.test(prefix)) return undefined;
  return match[0];
}
const noQuestions = (text: string, context: boolean): boolean => {
  const value = normalized(text).replace(/[.!]+$/g, '');
  const explicit = /^(?:(?:por ahora|de momento)[, ]+)?(?:no (?:tengo|hay|me quedan|tiene) (?:(?:ninguna?|mas) )?(?:dudas?|preguntas?)|sin (?:dudas|preguntas)|ninguna? (?:duda|pregunta))(?:(?:[, ]+(?:muchas )?gracias)|[, ]+por ahora)?$/;
  const resolution = resolvedQuestions(text);
  const clauses = value.split(/[.;!?\n]+|\b(?:y|pero|aunque)\b/).map(clause => clause.trim()).filter(Boolean);
  const shortNoMore = context && /^(?:no[, ]*)?(?:ya .+?[, ]*)?no (?:tengo|hay|me quedan) ninguna otra(?:s? (?:dudas?|preguntas?))?$/.test(value);
  return explicit.test(value) || Boolean(clauses.at(-1) && explicit.test(clauses.at(-1)!)) || Boolean(resolution && normalized(resolution) === value) || shortNoMore || (context && /^ningun[ao](?:[, ]+(?:muchas )?gracias)?$/.test(value));
};
// Compare wording only for obvious repeats; retain the original text as evidence.
const questionKey = (text: string) => [...new Set(normalized(text).replace(/\bprecios\b/g, 'precio')
  .replace(/\b(otra|duda|dudas|pregunta|preguntas|sabes|sabe|saber|que|cual|el|la|los|las|de|del|hay|tiene|es|vehiculo)\b/g, ' ')
  .match(/[a-z0-9]+/g) ?? [])].sort().join(' ');

function newQuestion(update: Update, previous: string | undefined): Update {
  if (update.field !== 'questions' || update.status !== 'answered' || !update.value || !previous || previous === noQuestionsValue) return update;
  // Some extractions include the saved text. Only remove that exact saved prefix;
  // the remaining new query still goes through literal quote validation below.
  const value = update.value.trim();
  if (value.startsWith(previous) && value.length > previous.length) {
    return { ...update, value: value.slice(previous.length).replace(/^[\s;|]+/, '') };
  }
  return update;
}
const clarification = (field: CollectionField, answers?: Answers): string => {
  if (field === 'timeframe') return '¿En más de tres meses o todavía sin fecha?';
  if (field === 'budget') return '¿Cuál es tu presupuesto total? Puedes indicarlo en pesos o en miles; si es un rango, dime qué monto deseas registrar.';
  if (field === 'downPayment') return '¿Cuánto tienes previsto de enganche? Puedes indicarlo en pesos o en miles, o decir si todavía no lo sabes.';
  if (field === 'email') return '¿Cuál es tu correo electrónico completo? También puedes decirme si prefieres no compartirlo.';
  if (field === 'phone') return '¿Cuál es el teléfono que quieres registrar? También puedes decirme si prefieres no compartirlo.';
  if (field === 'questions') return '¿Tienes alguna duda que quieras dejar anotada para el asesor?';
  if (field === 'tradeInBrand') {
    const vehicle = [answers?.tradeInModel, answers?.tradeInYear].filter(value => value !== undefined).join(' ');
    return vehicle ? `¿De qué marca es tu ${vehicle}?` : '¿De qué marca es el vehículo que darías a cuenta?';
  }
  if (field === 'tradeInModel') return '¿Cuál es el modelo del vehículo que darías a cuenta?';
  if (field === 'tradeInYear') return '¿De qué año es el vehículo que darías a cuenta?';
  return `¿Puedes aclarar ${fieldLabels[field]} que deseas registrar, o decirme si no lo sabes o prefieres no compartirlo?`;
};

// Shared by direct changes, candidates, and confirmations; confirmation never bypasses it.
function validate(update: Update, questionsContext = false): { valid: true; value: unknown } | { valid: false; reason: string } {
  const { field, value, quote, status } = update;
  if (status !== 'answered') return value === null ? { valid: true, value: undefined } : { valid: false, reason: 'INVALID_STATUS_VALUE' };
  if (value === null || !value.trim() || affirmative(value) || negative(value)) return { valid: false, reason: 'MISSING_VALUE' };
  let parsed: unknown = value;
  if (field === 'name' || field === 'phone' || field === 'email') {
    const result = identitySchema.shape[field].safeParse(value);
    if (!result.success) return { valid: false, reason: field === 'phone' ? 'INVALID_PHONE' : 'INVALID_IDENTITY' };
    parsed = result.data;
    const evidence = field === 'phone' ? phoneHasEvidence(result.data, quote) : normalized(quote).replace(/\s/g, '').includes(normalized(result.data).replace(/\s/g, ''));
    if (!evidence) return { valid: false, reason: field === 'phone' ? 'INVALID_PHONE' : 'UNSUPPORTED_VALUE' };
  } else if (field === 'vehicleId') {
    const vehicle = catalog.vehicles.find(vehicle => vehicle.id === value);
    if (!vehicle) return { valid: false, reason: 'INVALID_CATALOG' };
    if (!normalized(quote).includes(normalized(vehicle.id)) && !normalized(quote).includes(normalized(vehicle.name))) return { valid: false, reason: 'UNSUPPORTED_VALUE' };
  } else {
    if (['budget', 'downPayment', 'tradeInYear'].includes(field)) {
      if (!/^\d+(?:\.\d+)?$/.test(value)) return { valid: false, reason: 'INVALID_NUMBER' };
      parsed = Number(value);
      const evidence = field === 'tradeInYear'
        ? (quote.match(/\b\d{4}\b/g) ?? []).some(number => Number(number) === parsed)
        : amountMatches(parsed as number, quote);
      if (!evidence) return { valid: false, reason: 'UNSUPPORTED_VALUE' };
    }
    if (field === 'tradeIn') parsed = value === 'true' ? true : value === 'false' ? false : null;
    const result = answersSchema.shape[field].safeParse(parsed);
    if (!result.success) return { valid: false, reason: 'INVALID_VALUE' };
    parsed = result.data;
    if (field === 'branch' && !catalog.branches.some(branch => branch.id === value)) return { valid: false, reason: 'INVALID_CATALOG' };
    if (field === 'branch' && !normalized(quote).includes(normalized(value))) return { valid: false, reason: 'UNSUPPORTED_VALUE' };
    if (field === 'capacity' && value === 'ready' && /sin recursos|no tengo recursos/.test(normalized(quote))) return { valid: false, reason: 'UNSUPPORTED_VALUE' };
    const confirmedNoQuestions = field === 'questions' && value === noQuestionsValue && noQuestions(quote, questionsContext);
    if (field === 'questions' && value === noQuestionsValue && !confirmedNoQuestions) return { valid: false, reason: 'UNSUPPORTED_VALUE' };
    const correctedBrandEvidence = field === 'tradeInBrand' && typoBrand(quote)?.value === value;
    if (['tradeInBrand', 'tradeInModel', 'questions'].includes(field) && !confirmedNoQuestions && !correctedBrandEvidence && !normalized(quote).includes(normalized(value))) return { valid: false, reason: 'UNSUPPORTED_VALUE' };
  }
  return { valid: true, value: parsed };
}

export function applyUpdates(detail: Detail, output: AgentOutput, message: Message, assistantId: string, checkContact: (field: 'phone' | 'email', value: string) => void) {
  const o = detail.opportunity;
  const c = detail.customer;
  o.collection ??= {};
  o.proposals ??= [];
  const beforeQuestion = o.pendingQuestion;
  const previousQuestions = o.answers.questions;
  delete o.pendingQuestion;
  const accepted: unknown[] = [];
  const rejected: { field: CollectionField; reason: string }[] = [];
  const transitions: unknown[] = [];
  const proposalEvents: unknown[] = [];
  const stagedTradeInDetails: StagedTradeInDetail[] = [];
  // A reminder does not replace the last substantive question or confirmation.
  const last = detail.messages.filter(item => item.id !== message.id && !item.followupTaskId).at(-1);
  const askedField = beforeQuestion?.messageId === last?.id && beforeQuestion?.fields.length === 1 ? beforeQuestion.fields[0] : undefined;
  // Older turns may lack questionFields; their actual single question still
  // provides context for a brief answer such as "ninguna, gracias".
  const hasPreviousQuestion = Boolean(previousQuestions && previousQuestions !== noQuestionsValue);
  const questionsContext = askedField === 'questions' || hasPreviousQuestion || (!beforeQuestion && last?.role === 'assistant' && (last.text.match(/\?/g) ?? []).length === 1 && /dudas?|preguntas?/.test(normalized(last.text)));
  const tradeInContext = askedField === 'tradeIn' || (!beforeQuestion && last?.role === 'assistant' && (last.text.match(/\?/g) ?? []).length === 1 && /vehiculo.*a cuenta/.test(normalized(last.text)));
  const noTradeInCorrection = o.answers.tradeIn === false && normalized(message.text).replace(/[.! ]+$/g, '') === 'nada'
    && last?.role === 'assistant' && /correg|que dato/.test(normalized(last.text));
  const noTradeIn = (tradeInContext && tradeInNegative(message.text)) || noTradeInCorrection;
  const explicitNoQuestions = noQuestions(message.text, questionsContext);
  const resolutionQuote = hasPreviousQuestion ? resolvedQuestions(message.text) : undefined;
  const closesPreviousQuestion = hasPreviousQuestion && (Boolean(resolutionQuote) || /\bno (?:tengo|hay|me quedan) (?:mas dudas?|ninguna otra(?:s? (?:dudas?|preguntas?))?)\b/.test(normalized(message.text)));
  const weekQuote = withinThirtyDaysWeek(message.text);
  const briefDeclinedField = ['phone', 'email'].includes(askedField ?? '') && briefContactRefusal(message.text) ? askedField as 'phone' | 'email' : undefined;
  // Normalize only an explicit absence of doubts, keeping its literal evidence.
  const updates = output.updates.filter(update => {
    if (update.field !== 'questions') return true;
    if (explicitNoQuestions || resolutionQuote && update.value === noQuestionsValue) return false;
    if (closesPreviousQuestion && previousQuestions && update.value && normalized(update.value) === normalized(previousQuestions)) return false;
    return true;
  }).map(update =>
    update.field === 'questions' && message.text.includes(update.quote) && noQuestions(update.quote, questionsContext)
      ? { ...update, status: 'answered' as const, value: noQuestionsValue, mode: 'apply' as const }
      : update);
  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];
    const correction = update.field === 'tradeInBrand' && update.value ? typoBrand(update.value) : undefined;
    if (correction && normalized(update.quote).includes(normalized(correction.quote))) updates[i] = { ...update, value: correction.value };
  }
  if (weekQuote && (askedField === 'timeframe' || updates.some(update => update.field === 'timeframe'))) {
    const timeframeUpdates = updates.filter(update => update.field === 'timeframe');
    if (timeframeUpdates.length === 1) {
      const index = updates.findIndex(update => update.field === 'timeframe');
      updates[index] = { ...updates[index], status: 'answered', value: '0-30', quote: weekQuote[0], mode: 'apply' };
    } else if (!timeframeUpdates.length) {
      updates.push({ field: 'timeframe', status: 'answered', value: '0-30', quote: weekQuote[0], mode: 'apply' });
    }
  }
  if (explicitNoQuestions) updates.push({ field: 'questions', status: 'answered', value: noQuestionsValue, quote: message.text, mode: 'apply' });
  if (briefDeclinedField) {
    for (let i = updates.length - 1; i >= 0; i--) if (updates[i].field === briefDeclinedField) updates.splice(i, 1);
    updates.push({ field: briefDeclinedField, status: 'declined', value: null, quote: message.text, mode: 'apply' });
  }
  const recognizedBrand = typoBrand(message.text);
  if (recognizedBrand && o.answers.tradeIn === true && (o.collection.tradeInBrand ?? (o.answers.tradeInBrand ? 'answered' : 'pending')) === 'pending'
    && !updates.some(update => update.field === 'tradeInBrand')) {
    updates.push({ field: 'tradeInBrand', status: 'answered', value: recognizedBrand.value, quote: recognizedBrand.quote, mode: ambiguous(message.text) ? 'propose' : 'apply' });
  }
  for (const refusal of contactRefusals(message.text)) {
    if (updates.some(update => update.field === refusal.field && update.status === 'answered' && validate(update).valid)) continue;
    for (let i = updates.length - 1; i >= 0; i--) if (updates[i].field === refusal.field) updates.splice(i, 1);
    updates.push(refusal);
  }
  for (const invalid of invalidContacts(message.text)) {
    if (!updates.some(update => update.field === invalid.field)) updates.push(invalid);
  }
  const clarifyTime = vagueTimeframe(message.text) && (askedField === 'timeframe' || output.updates.some(update => update.field === 'timeframe'));
  const clarifyRejection = unclearRejection(message.text) && !briefDeclinedField && !noTradeIn;
  const monetaryQuestion = output.questionFields?.length === 1 && ['budget', 'downPayment'].includes(output.questionFields[0]) && output.message.includes('?') && amountsIn(output.message).length > 0;
  const requestedConfirmation = asksConfirmation(output.message) || monetaryQuestion;
  const confirmationFields = output.questionFields?.length ? output.questionFields : output.updates.filter(update => update.status === 'answered').map(update => update.field);
  const getValue = (field: CollectionField) => field === 'name' || field === 'phone' || field === 'email' ? c[field] : field === 'vehicleId' ? o.vehicleId : o.answers[field];
  const change = (field: CollectionField, status: typeof o.collection[CollectionField], value: unknown, sourceId: string) => {
    const previous = { value: getValue(field) ?? null, status: o.collection[field] ?? (getValue(field) === undefined ? 'pending' : 'answered'), sourceMessageId: o.answerSources[field] };
    if (field === 'name' || field === 'phone' || field === 'email') { if (status === 'answered') c[field] = value as string; else delete c[field]; }
    else if (field === 'vehicleId') { if (status === 'answered') o.vehicleId = value as string; else delete o.vehicleId; }
    else { if (status === 'answered') Object.assign(o.answers, { [field]: value }); else delete o.answers[field]; }
    o.collection[field] = status;
    o.answerSources[field] = sourceId;
    transitions.push({ field, previous, next: { status, value: getValue(field) ?? null, sourceMessageId: sourceId }, messageId: message.id });
  };
  if (resolutionQuote && !explicitNoQuestions) {
    // Clear only the current query. The user's messages and prior audit events remain intact.
    change('questions', 'answered', noQuestionsValue, message.id);
    accepted.push({ field: 'questions', status: 'answered', value: noQuestionsValue, quote: resolutionQuote, sourceMessageId: message.id, messageId: message.id });
  }
  const resolve = (proposal: DataProposal, status: DataProposal['status']) => {
    proposal.status = status;
    proposal.resolvedByMessageId = message.id;
    proposal.resolutionQuote = message.text;
    proposalEvents.push({ ...proposal });
  };
  const active = o.proposals.filter(proposal => proposal.status === 'pending');
  const generic = affirmative(message.text) || negative(message.text) || noTradeIn;
  let confirmation = false;
  let clarifyConfirmation = false;
  const work: { update: Update; sourceId: string; proposal?: DataProposal }[] = [];
  // A boolean answer is a value only for a single, explicitly tracked trade-in question.
  if (noTradeIn && !active.length) {
    work.push({ update: { field: 'tradeIn', status: 'answered', value: 'false', quote: message.text }, sourceId: message.id });
  } else if (generic && !active.length && beforeQuestion?.fields.length === 1 && beforeQuestion.fields[0] === 'tradeIn' && beforeQuestion.messageId === last?.id) {
    work.push({ update: { field: 'tradeIn', status: 'answered', value: affirmative(message.text) ? 'true' : 'false', quote: message.text }, sourceId: message.id });
  }
  if (generic && active.length === 1 && active[0].askedMessageId === last?.id && last?.role === 'assistant') {
    const proposal = active[0];
    const source = detail.messages.find(item => item.id === proposal.sourceMessageId && item.role === 'user');
    if (source?.text.includes(proposal.quote)) {
      if (affirmative(message.text)) {
        work.push({ update: { field: proposal.field as Update['field'], status: 'answered', value: proposal.value, quote: proposal.quote }, sourceId: source.id, proposal });
        confirmation = true;
      } else { resolve(proposal, 'rejected'); confirmation = true; }
    }
  }
  if (generic && !confirmation && active.length) clarifyConfirmation = true;
  for (const proposal of active) {
    if (work.some(item => item.proposal === proposal) || proposal.status !== 'pending') continue;
    const replacement = updates.find(update => update.field === proposal.field);
    resolve(proposal, replacement ? replacement.status === 'declined' ? 'cancelled' : 'superseded' : 'expired');
  }
  const counts = new Map<string, number>();
  for (const update of updates) counts.set(update.field, (counts.get(update.field) ?? 0) + 1);
  if (!generic) for (const update of updates) {
    if ((clarifyTime && update.field === 'timeframe') || clarifyRejection) continue;
    if (counts.get(update.field) !== 1 || !update.quote.trim() || !message.text.includes(update.quote)) rejected.push({ field: update.field, reason: 'INVALID_EVIDENCE' });
    else work.push({ update, sourceId: message.id });
  }
  if (generic && !confirmation && !work.length) clarifyConfirmation = true;
  const confirmingTradeIn = work.some(item => item.update.field === 'tradeIn' && item.update.status === 'answered' && item.update.value === 'true');
  const stagedForThisQuestion = beforeQuestion?.fields.length === 1 && beforeQuestion.fields[0] === 'tradeIn' && beforeQuestion.messageId === last?.id
    ? beforeQuestion.stagedTradeInDetails ?? [] : [];
  if (confirmingTradeIn) for (const staged of stagedForThisQuestion) {
    if (!work.some(item => item.update.field === staged.field)) {
      work.push({ update: { field: staged.field, status: 'answered', value: staged.value, quote: staged.quote }, sourceId: staged.sourceMessageId });
    }
  }
  // Parents are processed before dependencies, independently of extraction order.
  work.sort((a, b) => Number(['payment', 'tradeIn'].includes(b.update.field)) - Number(['payment', 'tradeIn'].includes(a.update.field)));
  for (const { update: extracted, sourceId, proposal } of work) {
    const update = newQuestion(extracted, resolutionQuote ? previousQuestions : o.answers.questions);
    const { field, status } = update;
    const validated = validate(update, questionsContext);
    // A separate question or hesitation must not turn an explicit datum into a candidate.
    const evidenceClause = message.text.split(/[;!?¿\n]|\.(?:\s|$)/).find(clause => clause.includes(update.quote)) ?? update.quote;
    const uncertain = field !== 'questions' && (ambiguous(update.quote) || (!proposal && ambiguous(evidenceClause)));
    const oneQuestion = beforeQuestion?.fields.length === 1 && beforeQuestion.fields[0] === field && beforeQuestion.messageId === last?.id;
    const fieldExplicit = mentions[field]?.test(normalized(update.quote)) ?? false;
    const capacityFromBudget = field === 'capacity' && /presupuesto/.test(normalized(update.quote)) && !mentions.capacity!.test(normalized(update.quote));
    const withdrawalEvidence = status === 'unknown'
      ? /no se|desconozco|ignoro|no tengo.*definid|sin.*definir/.test(normalized(update.quote))
      : contactRefusal.test(normalized(update.quote)) || /prefiero no|no quiero|no deseo|no (?:lo )?(?:comparto|digo|proporciono)|rechazo|no compartir/.test(normalized(update.quote))
        || (field === briefDeclinedField && briefContactRefusal(update.quote));
    const preserveRequested = /no (?:quiero|deseo) (?:cambiar|corregir)|no cambies|no borres|no elimines/.test(normalized(update.quote));
    const vagueRemoval = status !== 'answered' && (uncertain || preserveRequested || (!fieldExplicit && !oneQuestion) || !withdrawalEvidence);
    const dependencyInvalid = (field === 'downPayment' && o.answers.payment !== 'credit') || (field.startsWith('tradeIn') && field !== 'tradeIn' && o.answers.tradeIn !== true);
    const moneyField = field === 'budget' || field === 'downPayment';
    const moneyAmbiguous = status === 'answered' && moneyField && (hasAmountRange(proposal ? update.quote : message.text) || !amountTopicMatches(field, update.quote, proposal ? update.quote : message.text, proposal ? undefined : askedField));
    const stageTradeInDetail = dependencyInvalid && ['tradeInBrand', 'tradeInModel', 'tradeInYear'].includes(field)
      && output.questionFields?.length === 1 && output.questionFields[0] === 'tradeIn'
      && status === 'answered' && validated.valid && !uncertain && update.mode !== 'propose';
    if (stageTradeInDetail) {
      stagedTradeInDetails.push({ field: field as StagedTradeInDetail['field'], value: String(validated.value), quote: update.quote, sourceMessageId: sourceId });
      continue;
    }
    if (!validated.valid || capacityFromBudget || vagueRemoval || dependencyInvalid || moneyAmbiguous) {
      rejected.push({ field, reason: !validated.valid ? validated.reason : dependencyInvalid ? 'NOT_APPLICABLE' : 'NEEDS_CLARIFICATION' });
      if (proposal) resolve(proposal, 'cancelled');
      continue;
    }
    if (status === 'answered' && (field === 'phone' || field === 'email')) checkContact(field, validated.value as string);
    const confirmationRequestedForField = requestedConfirmation && confirmationFields.length === 1 && confirmationFields[0] === field;
    const explicitAbsence = field === 'questions' && validated.value === noQuestionsValue && noQuestions(update.quote, questionsContext);
    if (status === 'answered' && !proposal && !explicitAbsence && (update.mode === 'propose' || uncertain || confirmationRequestedForField)) {
      const candidate: DataProposal = { id: randomUUID(), field, value: update.value!, sourceMessageId: sourceId, quote: update.quote, status: 'pending' };
      o.proposals.push(candidate);
      proposalEvents.push({ ...candidate });
      continue;
    }
    // Closing the topic does not withdraw a previously recorded customer query.
    const keepQuestions = explicitAbsence && !closesPreviousQuestion && o.answers.questions && o.answers.questions !== noQuestionsValue;
    let storedValue = validated.value;
    if (field === 'questions' && status === 'answered' && !explicitAbsence && typeof validated.value === 'string' && o.answers.questions && o.answers.questions !== noQuestionsValue) {
      const previous = o.answers.questions;
      const key = questionKey(validated.value);
      const duplicate = previous.split('\n').some(question => normalized(question) === normalized(validated.value as string) || (key && questionKey(question) === key));
      storedValue = duplicate ? previous : `${previous}\n${validated.value}`;
      if (!answersSchema.shape.questions.safeParse(storedValue).success) {
        rejected.push({ field, reason: 'INVALID_VALUE' });
        if (proposal) resolve(proposal, 'cancelled');
        continue;
      }
    }
    if (!keepQuestions) change(field, status, storedValue, sourceId);
    if (proposal) resolve(proposal, 'confirmed');
    accepted.push({ ...update, value: keepQuestions ? o.answers.questions : validated.value ?? null, sourceMessageId: sourceId, messageId: message.id, proposalId: proposal?.id, ...(keepQuestions ? { topicClosed: true } : {}) });
  }
  const dependencies = (parent: 'payment' | 'tradeIn', fields: (keyof Answers)[], applies: boolean | undefined) => {
    const parentChanged = transitions.some(item => (item as { field: string }).field === parent);
    for (const field of fields) {
      if (applies === false || (applies === undefined && parentChanged) || (applies === true && o.collection[field] === 'not_applicable')) {
        change(field, applies === false ? 'not_applicable' : 'pending', undefined, message.id);
        for (const proposal of o.proposals!) if (proposal.field === field && proposal.status === 'pending') resolve(proposal, 'cancelled');
      }
    }
  };
  dependencies('payment', ['downPayment'], o.answers.payment === undefined ? undefined : o.answers.payment === 'credit');
  dependencies('tradeIn', ['tradeInDetails', 'tradeInBrand', 'tradeInModel', 'tradeInYear'], o.answers.tradeIn);
  const clarifyingTradeIn = !noTradeIn && output.questionFields?.length === 1 && output.questionFields[0] === 'tradeIn' && output.message.includes('?');
  if (clarifyingTradeIn && o.answers.tradeIn === false) change('tradeIn', 'pending', undefined, message.id);
  const remaining = o.proposals.filter(proposal => proposal.status === 'pending');
  const outsideCatalogue = rejected.some(item => item.field === 'vehicleId' && item.reason === 'INVALID_CATALOG')
    && output.updates.some(update => update.field === 'vehicleId' && message.text.includes(update.quote)
      && !catalog.vehicles.some(vehicle => new RegExp(`\\b${vehicle.id}\\b`).test(normalized(update.quote))));
  const savedFields = (accepted as { field: CollectionField }[]).map(item => item.field);
  const savedAcknowledgement = () => {
    const parts: string[] = [];
    if (savedFields.includes('tradeInModel') || savedFields.includes('tradeInYear')) {
      const vehicle = [o.answers.tradeInBrand, o.answers.tradeInModel, o.answers.tradeInYear].filter(value => value !== undefined).join(' ');
      if (vehicle) parts.push(`Gracias, anoté ${vehicle} como vehículo a cuenta.`);
    }
    if (savedFields.includes('action') && o.answers.action) parts.push(`Anoté tu solicitud de ${labels.action[o.answers.action].toLowerCase()}, pendiente de confirmación.`);
    if (savedFields.includes('budget') && o.answers.budget !== undefined) parts.push(`Tu presupuesto registrado es ${formatMXN(o.answers.budget)}.`);
    return parts.join(' ');
  };
  const pendingContacts = (['name', 'phone', 'email', 'vehicleId'] as const).filter(field => (o.collection[field] ?? (getValue(field) === undefined ? 'pending' : 'answered')) === 'pending');
  const blocks = [...pendingContacts.map(field => fieldLabels[field]), ...missingBlocks(o.answers, o.collection)];
  const collectionOrder: CollectionField[] = [
    'name', 'phone', 'email', 'vehicleId', 'timeframe', 'intention', 'capacity', 'budget', 'payment',
    ...(o.answers.payment === 'credit' ? ['downPayment' as const] : []),
    'tradeIn',
    ...(o.answers.tradeIn === true ? ['tradeInBrand' as const, 'tradeInModel' as const, 'tradeInYear' as const] : []),
    'branch', 'action',
  ];
  const nextField = collectionOrder.find(field => {
    const status = o.collection[field];
    return status === undefined ? getValue(field) === undefined : status === 'pending';
  });
  o.nextActionCode = remaining.length
    ? 'confirm_proposed_data'
    : nextField
      ? `collect_${nextField}`
      : o.answers.action
        ? 'request_recorded'
        : 'review_with_advisor';
  o.nextAction = remaining.length ? 'Confirmar datos propuestos' : blocks.length ? `Recopilar: ${blocks[0]}` : o.answers.action ? `Solicitud registrada: ${labels.action[o.answers.action]}` : 'Revisar información con un asesor';
  let response = output.message;
  if (noTradeIn && !active.length) {
    response = `${noTradeInCorrection ? 'Entendido, no cambiaremos tu respuesta: no entregarás un vehículo a cuenta.' : 'Entendido, no entregarás un vehículo a cuenta.'} ${nextField ? clarification(nextField, o.answers) : 'Gracias, conservo la información.'}`;
    if (nextField) o.pendingQuestion = { fields: [nextField], messageId: assistantId };
  } else if (briefDeclinedField) {
    response = `Entendido, no hace falta compartirlo. ${nextField ? clarification(nextField, o.answers) : 'Gracias, conservo lo que me compartiste.'}`;
    if (nextField) o.pendingQuestion = { fields: [nextField], messageId: assistantId };
  } else if (clarifyTime || clarifyRejection) {
    response = clarifyTime ? clarification('timeframe') : '¿Qué dato quieres corregir y cuál es el valor correcto? Conservo los datos actuales mientras lo aclaramos.';
    if (clarifyTime) o.pendingQuestion = { fields: ['timeframe'], messageId: assistantId };
  } else if (rejected.length) {
    const mentionsRejectedCandidate = output.updates.some(update => rejected.some(item => item.field === update.field) && update.value && normalized(output.message).includes(normalized(update.value)));
    const agentStatements = normalized(output.message).replace(/¿[^?]*\?/g, '');
    const claimsRejectedWrite = /guard|registr|anot|actualiz/.test(agentStatements)
      && (rejected.some(item => agentStatements.includes(normalized(fieldLabels[item.field])))
        || !savedFields.some(field => agentStatements.includes(normalized(fieldLabels[field]))));
    const safeClarification = rejected.length === 1 && output.questionFields?.length === 1 && output.questionFields[0] === rejected[0].field && (output.message.match(/\?/g) ?? []).length === 1
      && !(outsideCatalogue && rejected[0].field === 'vehicleId')
      && !claimsRejectedWrite && !/confirm|agend|notific|contact|llam|reserva|guarde todo|registre todo/.test(agentStatements)
      && !/tradeIn|questions|vehicleId/.test(output.message) && !mentionsRejectedCandidate;
    const target = rejected[0].field;
    const corrections = rejected.filter((item, index) => rejected.findIndex(other => other.field === item.field) === index).map(item => {
      if (item.field === 'vehicleId' && outsideCatalogue) return '';
      if (item.reason === 'INVALID_PHONE') return `No pude registrar el teléfono indicado. ${phoneValidationMessage}`;
      if (item.field === 'email' && item.reason === 'INVALID_IDENTITY') return 'El correo indicado no tiene un formato válido. ¿Cuál es tu correo electrónico completo? También puedes decirme si prefieres no compartirlo.';
      if (item.field === 'tradeInYear' && item.reason === 'INVALID_VALUE') return 'El año indicado no es válido para este registro. ¿Cuál es el año correcto del vehículo a cuenta?';
      return clarification(item.field, o.answers);
    });
    response = safeClarification ? output.message : [savedAcknowledgement(), ...corrections].filter(Boolean).join(' ');
    const correctionFields = [...new Set(rejected.filter(item => !(item.field === 'vehicleId' && outsideCatalogue)).map(item => item.field))];
    if (safeClarification || correctionFields.length) o.pendingQuestion = { fields: safeClarification ? [target] : correctionFields, messageId: assistantId };
  } else if (remaining.length === 1) {
    const candidate = remaining[0];
    const display = candidate.field === 'phone' ? formatPhone(candidate.value) : ['budget', 'downPayment'].includes(candidate.field) ? formatMXN(Number(candidate.value)) : candidate.value;
    response = `Aún no cambié ${fieldLabels[candidate.field]}. ¿Confirmas el valor «${display}»?`;
    candidate.askedMessageId = assistantId;
    proposalEvents.push({ ...candidate, type: 'asked' });
    o.pendingQuestion = { fields: [candidate.field], messageId: assistantId };
  } else if (remaining.length > 1 || clarifyConfirmation) response = '¿Qué dato quieres confirmar? Hay varias posibilidades y prefiero asegurarme antes de cambiarlo.';
  else if (confirmation) response = accepted.length ? 'Gracias, quedó registrado.' : 'Entendido, conservo la información anterior.';
  else if (active.length && !accepted.length && (generic || /guard|registr|anot|actualiz/.test(normalized(response)))) response = '¿Qué dato quieres retomar? La propuesta anterior ya no está vigente.';
  else if (requestedConfirmation) {
    const field = confirmationFields.length === 1 ? confirmationFields[0] : nextField;
    response = [savedAcknowledgement(), field ? clarification(field, o.answers) : 'Gracias, conservo la información que me compartiste.'].filter(Boolean).join(' ');
    if (field) o.pendingQuestion = { fields: [field], messageId: assistantId };
  }
  else if (clarifyingTradeIn) o.pendingQuestion = {
    fields: ['tradeIn'], messageId: assistantId,
    ...(stagedTradeInDetails.length ? { stagedTradeInDetails } : {}),
  };
  else if (output.questionFields?.length && (response.match(/\?/g) ?? []).length === 1) o.pendingQuestion = { fields: [...new Set(output.questionFields)], messageId: assistantId };
  if (!rejected.length && !remaining.length && !clarifyTime && !clarifyRejection && !confirmation) {
    const questionsResolved = o.collection.questions === 'answered';
    const repeatsQuestion = output.questionFields?.includes('questions') || (response.includes('?') && /dudas?|preguntas?/.test(normalized(response)));
    const unsafeClosing = /contact|notific|llamar|cita confirmada|reserva|resumen/i.test(response);
    if (explicitNoQuestions && savedFields.includes('questions')) {
      if (repeatsQuestion || unsafeClosing) response = `Gracias. ${o.answers.questions === noQuestionsValue ? noQuestionsValue + '. ' : 'Conservo tus consultas anotadas. '}${commercialSummary(o)}`;
      delete o.pendingQuestion;
    } else if (!output.questionFields?.length && !response.includes('?') && o.answers.tradeIn === true && (savedFields.includes('tradeInModel') || savedFields.includes('tradeInYear')) && (o.collection.tradeInBrand ?? (o.answers.tradeInBrand ? 'answered' : 'pending')) === 'pending') {
      response = [savedAcknowledgement(), clarification('tradeInBrand', o.answers)].filter(Boolean).join(' ');
      o.pendingQuestion = { fields: ['tradeInBrand'], messageId: assistantId };
    } else if (!output.questionFields?.length && !response.includes('?') && savedFields.includes('action') && o.answers.action === 'test_drive' && (o.collection.questions ?? (o.answers.questions ? 'answered' : 'pending')) === 'pending') {
      const agentAsksQuestions = output.questionFields?.length === 1 && output.questionFields[0] === 'questions' && !/contact|notific|agend|reserva|llam/i.test(output.message);
      response = agentAsksQuestions ? output.message : [savedAcknowledgement(), clarification('questions')].filter(Boolean).join(' ');
      o.pendingQuestion = { fields: ['questions'], messageId: assistantId };
    } else if (questionsResolved && repeatsQuestion) {
      // Repair the repeated question, retaining the answer that precedes it.
      response = response.replace(/¿[^?]*\?/g, '').trim() || (o.answers.questions === noQuestionsValue ? `Gracias. ${noQuestionsValue}.` : 'Tu consulta quedó anotada.');
      delete o.pendingQuestion;
    }
    if (o.pendingQuestion?.fields.every(field => (o.collection![field] ?? (getValue(field) === undefined ? 'pending' : 'answered')) !== 'pending')) {
      // questionFields describes the requested topic, not the customer's query.
      // Remove only the final repeated question, keeping any preceding answer.
      response = response.replace(/¿[^?]*\?\s*$/, '').trim() || 'Gracias, conservo la información que me compartiste.';
      delete o.pendingQuestion;
    }
  }
  const closesDoubtTopic = explicitNoQuestions || Boolean(resolutionQuote);
  if (closesDoubtTopic) {
    response = response.replace(/¿[^?]*(?:dudas?|preguntas?)[^?]*\?/gi, '').trim();
    const closedDoubtStillPromised = o.answers.questions === noQuestionsValue
      && !rejected.length
      && !remaining.length
      && /\b(?:consulta|duda|pregunta)\b/.test(normalized(response))
      && /\b(?:asesor|anotad[ao]|registrad[ao]|pendiente|enviar|mandar|pasar|compartir)\b/.test(normalized(response));
    if (closedDoubtStillPromised) response = `Gracias. ${noQuestionsValue}. ${commercialSummary(o)}`;
    if (!response) response = o.answers.questions === noQuestionsValue ? 'Gracias. Sin dudas.' : 'Gracias, dejo anotada tu nueva consulta.';
    if (o.pendingQuestion?.fields.includes('questions')) {
      const remainingFields = o.pendingQuestion.fields.filter(field => field !== 'questions');
      if (remainingFields.length) o.pendingQuestion = { ...o.pendingQuestion, fields: remainingFields };
      else delete o.pendingQuestion;
    }
  }
  if (confirmingTradeIn && stagedForThisQuestion.length && o.answers.tradeIn === true
    && o.answers.tradeInBrand && o.answers.tradeInModel && o.answers.tradeInYear !== undefined
    && (!output.questionFields?.length || output.questionFields.every(field => ['tradeIn', 'tradeInBrand', 'tradeInModel', 'tradeInYear'].includes(field)))) {
    response = savedAcknowledgement();
  }
  if (weekQuote && savedFields.includes('timeframe')) {
    response = response.replace(/\b(?:el )?(?:pr[oó]ximo|siguiente) mes\b|\ben un mes\b|\b(?:entre )?1 (?:a|y) 3 meses\b|\b31-90\b/gi, 'dentro de los próximos 30 días');
  }
  const selectedVehicle = catalog.vehicles.find(vehicle => vehicle.id === o.vehicleId);
  if (selectedVehicle && asksColorsAndVersions(message.text)) {
    const explicitlyNamesVehicle = normalized(message.text).includes(normalized(selectedVehicle.name));
    if (explicitlyNamesVehicle) {
      response = `El catálogo de demostración no permite confirmar los colores, el inventario ni las versiones reales de ${selectedVehicle.name}. Un asesor debe confirmar esa información.`;
    } else {
      const otherVehicleNames = catalog.vehicles.filter(vehicle => vehicle.id !== selectedVehicle.id).map(vehicle => vehicle.name);
      const otherVehicles = otherVehicleNames.length > 1
        ? `${otherVehicleNames.slice(0, -1).join(', ')} y ${otherVehicleNames.at(-1)}`
        : otherVehicleNames[0] ?? '';
      response = `El catálogo de demostración no permite confirmar los colores, el inventario ni las versiones reales de ${selectedVehicle.name}. Los otros nombres que aparecen en el catálogo (${otherVehicles}) son vehículos distintos, no versiones de ${selectedVehicle.name}. ¿Te refieres a las versiones de ${selectedVehicle.name} o a los vehículos que aparecen en el catálogo?`;
    }
  }
  if (outsideCatalogue) {
    response = `El vehículo que mencionas no figura en el catálogo de demostración. Eso no confirma su disponibilidad en el inventario real; un asesor tendría que verificarla. ${response}`;
  }
  return { accepted, rejected, transitions, proposalEvents, response };
}
