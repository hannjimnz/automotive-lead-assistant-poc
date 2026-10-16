import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { SqliteRepository } from './repository.js';
import type { CampaignAccessList } from '../shared/campaign.js';

// Local hypothesis only. Destinations are server-owned, never request parameters.
const campaigns = new Map([
  ['campana-bronco', { vehicleId: 'bronco', destination: '/demo/landing' }],
]);

export function campaignRoutes(repo: SqliteRepository) {
  const router = Router();
  router.get('/r/:campaignId', (req, res) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    const campaignId = String(req.params.campaignId);
    const campaign = campaigns.get(campaignId);
    if (!campaign) {
      res.status(404).json({ code: 'CAMPAIGN_NOT_FOUND', message: 'La campaña no existe.' });
      return;
    }
    repo.put('campaignAccesses', {
      id: randomUUID(), campaignId, vehicleId: campaign.vehicleId, createdAt: new Date().toISOString(),
    });
    res.redirect(302, campaign.destination);
  });
  router.get('/api/campaign-events', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const events = repo.all('campaignAccesses').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    res.json({ events, total: events.length } satisfies CampaignAccessList);
  });
  return router;
}
