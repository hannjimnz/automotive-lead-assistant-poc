import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Repository } from './repository.js';
import type { CampaignAccessList } from '../shared/campaign.js';
import { redirectPage } from './redirect-page.js';

// Local hypothesis only. Destinations are server-owned, never request parameters.
const campaigns = new Map([
  ['campana-bronco', { vehicleId: 'bronco', destination: '/demo/landing' }],
]);

export function campaignRoutes(repo: Repository) {
  const router = Router();
  router.get('/r/:campaignId', async (req, res) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    const campaignId = String(req.params.campaignId);
    const campaign = campaigns.get(campaignId);
    if (!campaign) {
      res.status(404).json({ code: 'CAMPAIGN_NOT_FOUND', message: 'La campaña no existe.' });
      return;
    }
    try {
      (await repo.put('campaignAccesses', {
        id: randomUUID(), campaignId, vehicleId: campaign.vehicleId, createdAt: new Date().toISOString(),
      }));
    } catch (error) {
      console.error('No se pudo registrar el acceso de campaña', {
        category: 'CAMPAIGN_ACCESS_WRITE_FAILED',
        type: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    // No ETag or HTTP redirect: the page itself offers the fixed destination.
    res.status(200).type('html').end(redirectPage(campaign.destination));
  });
  router.get('/api/campaign-events', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const events = (await repo.all('campaignAccesses')).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    res.json({ events, total: events.length } satisfies CampaignAccessList);
  });
  return router;
}
