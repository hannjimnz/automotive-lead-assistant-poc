export interface CampaignAccess {
  id: string;
  campaignId: string;
  vehicleId: string;
  createdAt: string;
}

export interface CampaignAccessList {
  events: CampaignAccess[];
  total: number;
}
