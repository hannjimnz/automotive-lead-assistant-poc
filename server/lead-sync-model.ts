import { createHash } from "node:crypto";

import { noQuestionsValue, type CollectionField, type CollectionStatus, type Detail } from "../shared/domain.js";
import type { Repository } from "./repository.js";

export const leadSyncSystemOrigin = "pasa-chatbot-poc";

export interface LeadSyncSnapshot {
  systemOrigin: string;
  externalId: string;
  contact: {
    name: string | null;
    phone: string | null;
    email: string | null;
    vehicleInterest: string | null;
  };
  profile: {
    timeframe: string | null;
    intention: string | null;
    declaredCapacity: string | null;
    budget: number | null;
    paymentMethod: string | null;
    downPayment: number | null;
    tradeIn: boolean | null;
    tradeInBrand: string | null;
    tradeInModel: string | null;
    tradeInYear: number | null;
    branch: string | null;
    requestedAction: string | null;
    questions: string | null;
    nextStep: string;
  };
  collectionStates: Record<CollectionField, CollectionStatus>;
}

const synchronizedFields: CollectionField[] = [
  "name", "phone", "email", "vehicleId", "timeframe", "intention", "capacity", "budget",
  "payment", "downPayment", "tradeIn", "tradeInBrand", "tradeInModel", "tradeInYear",
  "branch", "action", "questions",
];

export function buildLeadSyncSnapshot(detail: Detail): LeadSyncSnapshot {
  const { customer, opportunity } = detail;
  const values: Partial<Record<CollectionField, unknown>> = {
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    vehicleId: opportunity.vehicleId,
    ...opportunity.answers,
  };
  const collectionStates = Object.fromEntries(synchronizedFields.map(field => {
    const savedStatus = opportunity.collection?.[field];
    const hasValue = values[field] !== undefined && values[field] !== null;
    return [field, savedStatus ?? (hasValue ? "answered" : "pending")];
  })) as Record<CollectionField, CollectionStatus>;
  const answers = opportunity.answers;

  return {
    systemOrigin: leadSyncSystemOrigin,
    externalId: opportunity.id,
    contact: {
      name: customer.name ?? null,
      phone: customer.phone ?? null,
      email: customer.email ?? null,
      vehicleInterest: opportunity.vehicleId ?? null,
    },
    profile: {
      timeframe: answers.timeframe ?? null,
      intention: answers.intention ?? null,
      declaredCapacity: answers.capacity ?? null,
      budget: answers.budget ?? null,
      paymentMethod: answers.payment ?? null,
      downPayment: answers.downPayment ?? null,
      tradeIn: answers.tradeIn ?? null,
      tradeInBrand: answers.tradeInBrand ?? null,
      tradeInModel: answers.tradeInModel ?? null,
      tradeInYear: answers.tradeInYear ?? null,
      branch: answers.branch ?? null,
      requestedAction: answers.action ?? null,
      questions: answers.questions === noQuestionsValue ? null : answers.questions ?? null,
      nextStep: opportunity.nextActionCode ?? "review_with_advisor",
    },
    collectionStates,
  };
}

export function canonicalLeadSyncSnapshot(snapshot: LeadSyncSnapshot): string {
  return JSON.stringify(sortCanonical(snapshot));
}

export function hashLeadSyncSnapshot(snapshot: LeadSyncSnapshot): string {
  return createHash("sha256").update(canonicalLeadSyncSnapshot(snapshot)).digest("hex");
}

export async function enqueueLeadSyncSnapshot(repo: Repository, detail: Detail, now: string): Promise<number> {
  const snapshot = buildLeadSyncSnapshot(detail);
  const canonical = canonicalLeadSyncSnapshot(snapshot);
  const hash = createHash("sha256").update(canonical).digest("hex");
  return (await repo.queueLeadSync(snapshot.externalId, canonical, hash, now));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, sortCanonical(item)]),
    );
  }
  return value;
}
