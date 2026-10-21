import { Router } from 'express';
import { z } from 'zod';
import { ApiError, type CRMService } from './service.js';

export function followupRoutes(service: CRMService) {
  const router = Router();
  router.post('/api/opportunities/:id/followups/simulate', async (req, res) => {
    const input = z.object({ attempt: z.union([z.literal(1), z.literal(2)]), cycleId: z.string().min(1).max(200) }).strict().safeParse(req.body);
    if (!input.success) throw new ApiError(400, 'INVALID_FOLLOWUP', 'Se requieren attempt (1 o 2) y el ciclo vigente.');
    const detail = (await service.detail(String(req.params.id)));
    const user = detail.messages.filter(message => message.role === 'user').at(-1);
    if (user?.id !== input.data.cycleId) throw new ApiError(409, 'STALE_FOLLOWUP', 'El ciclo cambió. Actualiza la conversación antes de simular.');
    const task = detail.tasks.find(item => item.kind === 'followup' && item.cycleId === input.data.cycleId && item.attempt === input.data.attempt);
    if (!task) throw new ApiError(409, 'FOLLOWUP_NOT_ELIGIBLE', 'No hay un recordatorio programado para este ciclo.');
    if (task.status === 'completed') { res.json(detail); return; }
    const result = (await service.followups.execute(task.id, 'simulated'));
    if (!result.sent) throw new ApiError(409, 'FOLLOWUP_NOT_ELIGIBLE', result.reason);
    res.json((await service.detail(detail.opportunity.id)));
  });
  return router;
}
