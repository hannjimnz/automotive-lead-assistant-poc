import { missingBlocks, type Detail } from './domain.js';

export function followupState(detail: Detail) {
  const user = detail.messages.filter(message => message.role === 'user').at(-1);
  const o = detail.opportunity;
  const contactPending = (['name', 'phone', 'email', 'vehicleId'] as const).some(field => {
    const value = field === 'vehicleId' ? o.vehicleId : detail.customer[field];
    return (o.collection?.[field] ?? (value === undefined ? 'pending' : 'answered')) === 'pending';
  });
  const questionsPending = (o.collection?.questions ?? (o.answers.questions === undefined ? 'pending' : 'answered')) === 'pending';
  const incomplete = contactPending || questionsPending || missingBlocks(o.answers, o.collection).length > 0 || o.proposals?.some(proposal => proposal.status === 'pending') === true;
  const reason = !user ? 'Se necesita un mensaje del usuario procesado correctamente.'
    : detail.messages.some(message => message.status === 'pending') ? 'Hay un mensaje en procesamiento.'
      : user.status !== 'complete' ? 'El último mensaje no fue procesado; reinténtalo o continúa con otro mensaje.'
        : !incomplete ? 'La recopilación está completa; no hay recordatorios pendientes.' : '';
  const tasks = detail.tasks.filter(task => task.kind === 'followup' && task.cycleId === user?.id);
  const first = tasks.find(task => task.attempt === 1);
  const last = tasks.find(task => task.attempt === 2);
  const firstReason = reason || (!first ? 'El ciclo todavía no está programado.' : first.status !== 'pending' ? 'El recordatorio de 24 h ya fue resuelto en este ciclo.' : '');
  const lastReason = reason || (!last ? 'El ciclo todavía no está programado.' : last.status !== 'pending' ? 'El recordatorio de 48 h ya fue resuelto en este ciclo.' : first?.status !== 'completed' ? 'Primero debes ejecutar el recordatorio de 24 h.' : '');
  return { user, incomplete, eligible: !reason, reason, cycleId: user?.id, firstReason, lastReason };
}
