import { randomUUID } from 'node:crypto';
import { answersSchema, identitySchema, catalog, labels, missingBlocks, commercialSummary, noQuestionsValue, type Answers, type CollectionField, type Detail, type Message, type DataProposal } from '../shared/domain.js';
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
const mentions: Partial<Record<CollectionField, RegExp>> = {
  name: /nombre|llamo/, phone: /telefon|numero|celular/, email: /correo|email/, vehicleId: /vehiculo|interes|busco/, timeframe: /fecha|plazo|dias|meses|comprar|temporalidad/,
  intention: /intencion|comparo|comparar|explor|avanzar/, capacity: /recursos|capacidad|dinero disponible/, budget: /presupuesto/, payment: /pago|credito|contado/, downPayment: /enganche/,
  tradeIn: /a cuenta|auto|vehiculo/, tradeInBrand: /marca/, tradeInModel: /modelo/, tradeInYear: /ano/, branch: /sucursal/, action: /cita|llamada|accion|prueba|seguimiento/, questions: /dudas|preguntas/,
};
const asksConfirmation = (text: string) => (text.match(/¿[^?]*\?/g) ?? []).some(question => /\bconfirm|es correcto|esta bien|es ese/.test(normalized(question)));
const vagueTimeframe = (text: string) => /\bmas adelante\b/.test(normalized(text)) && !/\d|mes|fecha|semana|ano/.test(normalized(text));
const unclearRejection = (text: string) => /^(nop\b|no[, ]+ese no\b)/.test(normalized(text));
const noQuestions = (text: string, context: boolean): boolean => {
  const value = normalized(text).replace(/[.!]+$/g, '');
  const explicit = /^(?:(?:por ahora|de momento)[, ]+)?(?:no (?:tengo|hay|me quedan) (?:(?:ninguna?|mas) )?(?:dudas?|preguntas?)|sin (?:dudas|preguntas)|ninguna? (?:duda|pregunta))(?:(?:[, ]+(?:muchas )?gracias)|[, ]+por ahora)?$/;
  return explicit.test(value) || (context && /^ningun[ao](?:[, ]+(?:muchas )?gracias)?$/.test(value));
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
    if (['tradeInBrand', 'tradeInModel', 'questions'].includes(field) && !confirmedNoQuestions && !normalized(quote).includes(normalized(value))) return { valid: false, reason: 'UNSUPPORTED_VALUE' };
  }
  return { valid: true, value: parsed };
}

export function applyUpdates(detail: Detail, output: AgentOutput, message: Message, assistantId: string, checkContact: (field: 'phone' | 'email', value: string) => void) {
  const o = detail.opportunity;
  const c = detail.customer;
  o.collection ??= {};
  o.proposals ??= [];
  const beforeQuestion = o.pendingQuestion;
  delete o.pendingQuestion;
  const accepted: unknown[] = [];
  const rejected: { field: CollectionField; reason: string }[] = [];
  const transitions: unknown[] = [];
  const proposalEvents: unknown[] = [];
  const last = detail.messages.filter(item => item.id !== message.id).at(-1);
  const askedField = beforeQuestion?.messageId === last?.id && beforeQuestion?.fields.length === 1 ? beforeQuestion.fields[0] : undefined;
  // Older turns may lack questionFields; their actual single question still
  // provides context for a brief answer such as "ninguna, gracias".
  const questionsContext = askedField === 'questions' || (!beforeQuestion && last?.role === 'assistant' && (last.text.match(/\?/g) ?? []).length === 1 && /dudas?|preguntas?/.test(normalized(last.text)));
  const explicitNoQuestions = noQuestions(message.text, questionsContext);
  // Normalize only an explicit absence of doubts, keeping its literal evidence.
  const updates = output.updates.filter(update => !explicitNoQuestions || update.field !== 'questions').map(update =>
    update.field === 'questions' && message.text.includes(update.quote) && noQuestions(update.quote, questionsContext)
      ? { ...update, status: 'answered' as const, value: noQuestionsValue, mode: 'apply' as const }
      : update);
  if (explicitNoQuestions) updates.push({ field: 'questions', status: 'answered', value: noQuestionsValue, quote: message.text, mode: 'apply' });
  const clarifyTime = vagueTimeframe(message.text) && (askedField === 'timeframe' || output.updates.some(update => update.field === 'timeframe'));
  const clarifyRejection = unclearRejection(message.text);
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
  const resolve = (proposal: DataProposal, status: DataProposal['status']) => {
    proposal.status = status;
    proposal.resolvedByMessageId = message.id;
    proposal.resolutionQuote = message.text;
    proposalEvents.push({ ...proposal });
  };
  const active = o.proposals.filter(proposal => proposal.status === 'pending');
  const generic = affirmative(message.text) || negative(message.text);
  let confirmation = false;
  let clarifyConfirmation = false;
  const work: { update: Update; sourceId: string; proposal?: DataProposal }[] = [];
  // A boolean answer is a value only for a single, explicitly tracked trade-in question.
  if (generic && !active.length && beforeQuestion?.fields.length === 1 && beforeQuestion.fields[0] === 'tradeIn' && beforeQuestion.messageId === last?.id) {
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
  // Parents are processed before dependencies, independently of extraction order.
  work.sort((a, b) => Number(['payment', 'tradeIn'].includes(b.update.field)) - Number(['payment', 'tradeIn'].includes(a.update.field)));
  for (const { update: extracted, sourceId, proposal } of work) {
    const update = newQuestion(extracted, o.answers.questions);
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
      : /prefiero no|no quiero|no deseo|no (?:lo )?(?:comparto|digo|proporciono)|rechazo|no compartir/.test(normalized(update.quote));
    const preserveRequested = /no (?:quiero|deseo) (?:cambiar|corregir)|no cambies|no borres|no elimines/.test(normalized(update.quote));
    const vagueRemoval = status !== 'answered' && (uncertain || preserveRequested || (!fieldExplicit && !oneQuestion) || !withdrawalEvidence);
    const dependencyInvalid = (field === 'downPayment' && o.answers.payment !== 'credit') || (field.startsWith('tradeIn') && field !== 'tradeIn' && o.answers.tradeIn !== true);
    const moneyField = field === 'budget' || field === 'downPayment';
    const moneyAmbiguous = status === 'answered' && moneyField && (hasAmountRange(proposal ? update.quote : message.text) || !amountTopicMatches(field, update.quote, proposal ? update.quote : message.text, proposal ? undefined : askedField));
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
    const keepQuestions = explicitAbsence && o.answers.questions && o.answers.questions !== noQuestionsValue;
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
  const remaining = o.proposals.filter(proposal => proposal.status === 'pending');
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
  o.nextAction = remaining.length ? 'Confirmar datos propuestos' : blocks.length ? `Recopilar: ${blocks[0]}` : o.answers.action ? `Solicitud registrada: ${labels.action[o.answers.action]}` : 'Revisar información con un asesor';
  let response = output.message;
  if (clarifyTime || clarifyRejection) {
    response = clarifyTime ? clarification('timeframe') : '¿Qué dato quieres corregir y cuál es el valor correcto? Conservo los datos actuales mientras lo aclaramos.';
    if (clarifyTime) o.pendingQuestion = { fields: ['timeframe'], messageId: assistantId };
  } else if (rejected.length) {
    const mentionsRejectedCandidate = output.updates.some(update => rejected.some(item => item.field === update.field) && update.value && normalized(output.message).includes(normalized(update.value)));
    const agentStatements = normalized(output.message).replace(/¿[^?]*\?/g, '');
    const claimsRejectedWrite = /guard|registr|anot|actualiz/.test(agentStatements)
      && (rejected.some(item => agentStatements.includes(normalized(fieldLabels[item.field])))
        || !savedFields.some(field => agentStatements.includes(normalized(fieldLabels[field]))));
    const safeClarification = rejected.length === 1 && output.questionFields?.length === 1 && output.questionFields[0] === rejected[0].field && (output.message.match(/\?/g) ?? []).length === 1
      && !claimsRejectedWrite && !/confirm|agend|notific|contact|llam|reserva|guarde todo|registre todo/.test(agentStatements)
      && !/tradeIn|questions|vehicleId/.test(output.message) && !mentionsRejectedCandidate;
    const target = rejected[0].field;
    response = safeClarification ? output.message : [savedAcknowledgement(), rejected.some(item => item.reason === 'INVALID_PHONE') ? `No pude registrar el teléfono indicado. ${phoneValidationMessage}` : clarification(target, o.answers)].filter(Boolean).join(' ');
    o.pendingQuestion = { fields: [target], messageId: assistantId };
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
    const field = confirmationFields.length === 1 ? confirmationFields[0] : undefined;
    response = field ? clarification(field) : '¿Qué dato y valor quieres registrar?';
    if (field) o.pendingQuestion = { fields: [field], messageId: assistantId };
  }
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
  return { accepted, rejected, transitions, proposalEvents, response };
}
