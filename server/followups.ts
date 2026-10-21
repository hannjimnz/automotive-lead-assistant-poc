import { randomUUID } from 'node:crypto';
import type { Detail, Task } from '../shared/domain.js';
import { followupState } from '../shared/followup.js';
import type { Repository } from './repository.js';

export class Followups {
  private repo: Repository;
  private detail: (id: string) => Promise<Detail>;
  private clock: () => Date;
  constructor(repo: Repository, detail: (id: string) => Promise<Detail>, clock: () => Date) {
    this.repo = repo;
    this.detail = detail;
    this.clock = clock;
  }

  private async finish(task: Task, status: Task['status'], reason: string, mode?: Task['mode']) {
    const now = this.clock().toISOString();
    (await this.repo.put('tasks', { ...task, status, reason, completedAt: now, ...(mode ? { mode } : {}) }));
    (await this.repo.put('events', { id: randomUUID(), opportunityId: task.opportunityId, type: `followup_${status}`,
      description: `Seguimiento de ${task.attempt === 1 ? 24 : 48} h ${status === 'skipped' ? 'omitido' : 'cancelado'}: ${reason}`,
      createdAt: now, data: { taskId: task.id, cycleId: task.cycleId, mode } }));
  }

  // Called inside the caller's transaction, including the accepted-message commit.
  async sync(detail: Detail, anchorAt?: string) {
    const state = followupState(detail);
    for (const task of detail.tasks) if (task.kind === 'followup' && task.status === 'pending' && (!state.eligible || task.cycleId !== state.cycleId)) {
      (await this.finish(task, 'cancelled', task.cycleId !== state.cycleId ? 'El usuario respondió; ciclo anterior cerrado.' : state.reason));
    }
    if (!state.eligible || !state.user) return;
    const existing = detail.tasks.find(task => task.kind === 'followup' && task.cycleId === state.cycleId);
    // A persisted task also persists the cycle anchor; never restart it after a reminder.
    const anchor = anchorAt ?? (existing ? new Date(Date.parse(existing.dueAt) - existing.attempt * 24 * 3600000).toISOString() : state.user.createdAt);
    for (const attempt of [1, 2] as const) {
      const id = `followup:${detail.opportunity.id}:${state.user.id}:${attempt}`;
      if (!(await this.repo.get('tasks', id))) (await this.repo.put('tasks', {
        id, opportunityId: detail.opportunity.id, kind: 'followup', cycleId: state.user.id, anchorMessageId: state.user.id,
        attempt, dueAt: new Date(Date.parse(anchor) + attempt * 24 * 3600000).toISOString(), status: 'pending',
      }));
    }
  }

  async execute(taskId: string, mode: 'automatic' | 'simulated'): Promise<{ sent: boolean; reason: string }> {
    return (await this.repo.transaction(async () => {
      const task = (await this.repo.get('tasks', taskId));
      if (!task || task.kind !== 'followup') return { sent: false, reason: 'El recordatorio no existe.' };
      if (task.status !== 'pending') return { sent: false, reason: 'Este recordatorio ya fue resuelto.' };
      const detail = (await this.detail(task.opportunityId));
      const state = followupState(detail);
      // Processing is temporary: leave due tasks pending until processing ends.
      if (detail.messages.some(message => message.status === 'pending')) return { sent: false, reason: 'Hay un mensaje en procesamiento.' };
      if (!state.eligible || state.cycleId !== task.cycleId) {
        (await this.finish(task, 'cancelled', state.reason || 'El ciclo ya no está vigente.'));
        return { sent: false, reason: state.reason || 'El ciclo ya no está vigente.' };
      }
      if (mode === 'automatic' && Date.parse(task.dueAt) > this.clock().getTime()) return { sent: false, reason: 'El recordatorio aún no vence.' };
      if (task.attempt === 2) {
        const first = detail.tasks.find(item => item.kind === 'followup' && item.cycleId === task.cycleId && item.attempt === 1);
        if (first?.status !== 'completed') {
          if (mode === 'automatic' && first?.status === 'pending' && Date.parse(first.dueAt) <= this.clock().getTime()) {
            (await this.finish(first, 'skipped', 'Ambos vencieron; se entrega solo el último recordatorio.', mode));
          } else return { sent: false, reason: 'Primero debes ejecutar el recordatorio de 24 h.' };
        }
      }
      const now = this.clock().toISOString();
      const messageId = `message:${task.id}`;
      (await this.repo.put('messages', { id: messageId, followupTaskId: task.id, conversationId: detail.conversation.id, role: 'assistant', status: 'complete', createdAt: now,
        text: task.attempt === 1 ? '¡Hola! Si te viene bien, podemos retomar los datos que quedaron pendientes. Puedes continuar cuando quieras.'
          : '¡Hola! Este es el último recordatorio por ahora. Si más adelante quieres retomar la conversación, aquí puedes continuar, sin prisa.' }));
      (await this.repo.put('tasks', { ...task, status: 'completed', completedAt: now, mode, messageId }));
      (await this.repo.put('events', { id: randomUUID(), opportunityId: task.opportunityId, type: 'followup_sent',
        description: `Recordatorio de ${task.attempt === 1 ? 24 : 48} h enviado (${mode === 'simulated' ? 'simulación' : 'automático'}).`,
        createdAt: now, data: { taskId: task.id, cycleId: task.cycleId, mode, messageId } }));
      (await this.repo.put('opportunities', { ...detail.opportunity, updatedAt: now, lastInteraction: now, revision: detail.opportunity.revision + 1 }));
      return { sent: true, reason: '' };
    }));
  }

  async tick() {
    for (const opportunity of (await this.repo.all('opportunities'))) {
      const detail = (await this.detail(opportunity.id));
      // Do not cancel a current cycle merely because a provider call is in flight.
      if (detail.messages.some(message => message.status === 'pending')) continue;
      (await this.repo.transaction(async () => (await this.sync((await this.detail(opportunity.id))))));
      const due = (await this.repo.all('tasks')).filter(task => task.kind === 'followup' && task.opportunityId === opportunity.id && task.status === 'pending' && Date.parse(task.dueAt) <= this.clock().getTime());
      const latest = due.sort((a, b) => b.attempt - a.attempt)[0];
      if (latest) (await this.execute(latest.id, 'automatic'));
    }
  }
}
