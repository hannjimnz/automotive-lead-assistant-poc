import { z } from "zod";
import { formatMXN } from "./money.js";
import { phoneSchema } from "./phone.js";
export { normalizePhone } from "./phone.js";

export const labels = {
  timeframe: {
    "0-30": "En los próximos 30 días",
    "31-90": "Entre 1 y 3 meses",
    "90+": "En más de 3 meses",
    undefined: "Por definir",
  },
  intention: {
    advance: "Quiere avanzar",
    compare: "Compara opciones",
    explore: "Explora",
  },
  capacity: {
    ready: "Recursos compatibles",
    review: "Revisar alternativas",
    unavailable: "Sin recursos por ahora",
  },
  payment: { credit: "Crédito", cash: "Contado" },
  action: {
    appointment: "Cita en agencia",
    test_drive: "Prueba de manejo",
    call: "Llamada de asesor",
    later: "Seguimiento posterior",
  },
  status: {
    new: "Nuevo",
    conversing: "En conversación",
    qualified: "Calificado",
    no_response: "Sin respuesta",
    discarded: "Descartado",
  },
};

export const collectionStatusSchema = z.enum([
  "pending",
  "answered",
  "unknown",
  "declined",
  "not_applicable",
]);

export type CollectionStatus = z.infer<typeof collectionStatusSchema>;
export const noQuestionsValue = "Sin dudas";
export const answersSchema = z
  .object({
    timeframe: z.enum(["0-30", "31-90", "90+", "undefined"]).optional(),
    intention: z.enum(["advance", "compare", "explore"]).optional(),
    capacity: z.enum(["ready", "review", "unavailable"]).optional(),
    payment: z.enum(["credit", "cash"]).optional(),
    downPayment: z.number().min(0).max(100000000).optional(),
    tradeIn: z.boolean().optional(),
    tradeInDetails: z.string().max(500).optional(),
    branch: z.string().max(100).optional(),
    action: z.enum(["appointment", "test_drive", "call", "later"]).optional(),
    questions: z.string().max(2000).optional(),
    

    budget: z.number().min(0).max(100000000).optional(),
    tradeInBrand: z.string().trim().min(1).max(100).optional(),
    tradeInModel: z.string().trim().min(1).max(100).optional(),
    tradeInYear: z.number().int().min(1900).max(2100).optional(),
    
  })
  .strict();
export type Answers = z.infer<typeof answersSchema>;
export type CollectionField =
  | keyof Answers
  | "name"
  | "phone"
  | "email"
  | "vehicleId";

export type CollectionProgress =
  Partial<Record<CollectionField, CollectionStatus>>;

export type NextActionCode =
  | "confirm_proposed_data"
  | `collect_${CollectionField}`
  | "request_recorded"
  | "review_with_advisor";

export type Status = keyof typeof labels.status;
export type Grade = "green" | "yellow" | "red";
export const scoringFields = ["timeframe", "intention", "capacity"] as const;
export type ScoringField = (typeof scoringFields)[number];
export type EvaluationCriteria = Record<ScoringField, {
  status: CollectionStatus;
  points: number | null;
}>;
export interface Customer {
  id: string;
  name?: string;
  phone?: string;
  email?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Opportunity {
  id: string;
  customerId: string;
  vehicleId?: string;
  promotionId: string | null;
  source: string;
  campaign: string;
  status: Status;
  answers: Answers;
  collection: CollectionProgress;
  answerSources: Record<string, string>;
  score: number | null;
  grade: Grade | null;
  ruleVersion: number | null;
  nextAction: string;
  nextActionCode?: NextActionCode;
  createdAt: string;
  updatedAt: string;
  lastInteraction: string;
  rejectionReason?: string;
  pendingIdentity?: Partial<Pick<Customer, "name" | "phone" | "email">>;
  revision: number;
  proposals?: DataProposal[];
  pendingQuestion?: {
    fields: CollectionField[];
    messageId: string;
    stagedTradeInDetails?: StagedTradeInDetail[];
  };
}
export interface StagedTradeInDetail {
  field: "tradeInBrand" | "tradeInModel" | "tradeInYear";
  value: string;
  quote: string;
  sourceMessageId: string;
}
export interface DataProposal {
  id: string;
  field: CollectionField;
  value: string;
  sourceMessageId: string;
  quote: string;
  status: "pending" | "confirmed" | "rejected" | "superseded" | "expired" | "cancelled";
  askedMessageId?: string;
  resolvedByMessageId?: string;
  resolutionQuote?: string;
}
export interface Conversation {
  id: string;
  opportunityId: string;
  createdAt: string;
}
export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  status: "pending" | "complete" | "error";
  requestId?: string;
  error?: string;
  followupTaskId?: string;
}
export interface Evaluation {
  id: string;
  opportunityId: string;
  score: number | null;
  grade: Grade | null;
  ruleVersion: number;
  breakdown: Record<string, number | null>;
  // Optional only for historical evaluations saved before these metadata existed.
  provisional?: boolean;
  unknownCriteria?: ScoringField[];
  declinedCriteria?: ScoringField[];
  criteria?: EvaluationCriteria;
  createdAt: string;
}
export interface Event {
  id: string;
  opportunityId: string;
  type: string;
  description: string;
  createdAt: string;
  data?: unknown;
}
export interface Task {
  id: string;
  opportunityId: string;
  attempt: 1 | 2;
  dueAt: string;
  status: "pending" | "completed" | "cancelled" | "skipped";
  completedAt?: string;
  kind?: "followup";
  cycleId?: string;
  anchorMessageId?: string;
  mode?: "automatic" | "simulated";
  messageId?: string;
  reason?: string;
}
export interface Rules {
  id: string;
  version: number;
  timeframe: Record<NonNullable<Answers["timeframe"]>, number>;
  intention: Record<NonNullable<Answers["intention"]>, number>;
  capacity: Record<NonNullable<Answers["capacity"]>, number>;
  green: number;
  yellow: number;
  createdAt: string;
}
export interface Capture {
  name: string;
  phone: string;
  email: string;
  vehicleId: string;
  promotionId?: string | null;
  source: string;
  campaign: string;
  requestId: string;
  confirmChanges?: boolean;
}
export const defaultRules: Omit<Rules, "id" | "createdAt"> = {
  version: 1,
  timeframe: { "0-30": 40, "31-90": 20, "90+": 10, undefined: 0 },
  intention: { advance: 30, compare: 15, explore: 0 },
  capacity: { ready: 30, review: 15, unavailable: 0 },
  green: 80,
  yellow: 50,
};
export const catalog = {
  vehicles: [
    {
      id: "territory",
      name: "Ford Territory",
      category: "SUV · Versatilidad para cada día",
      color: "#74939d",
    },
    {
      id: "lobo",
      name: "Ford Lobo",
      category: "Pickup · Potencia y capacidad",
      color: "#668277",
    },
    {
      id: "bronco",
      name: "Ford Bronco Sport",
      category: "SUV · Espíritu de aventura",
      color: "#ac9778",
    },
    {
      id: "mustang",
      name: "Ford Mustang",
      category: "Deportivo · Diseño y desempeño",
      color: "#8b899a",
    },
  ],
  branches: [
    {
      id: "centro",
      name: "Sucursal Centro (demo)",
      hours: "Lun–vie, 9:00–18:00",
    },
    {
      id: "norte",
      name: "Sucursal Norte (demo)",
      hours: "Lun–vie, 9:00–18:00",
    },
    { id: "sur", name: "Sucursal Sur (demo)", hours: "Lun–vie, 9:00–18:00" },
  ],
  promotions: [
    {
      id: "territory-demo",
      vehicleId: "territory",
      name: "Plan Territory · Ejemplo",
      conditions:
        "Ejemplo de demostración: condiciones por confirmar con un asesor. No constituye una oferta comercial.",
      validFrom: "2026-01-01",
      validUntil: "2026-12-31",
    },
    {
      id: "lobo-expired",
      vehicleId: "lobo",
      name: "Campaña Lobo · Vencida",
      conditions:
        "Campaña de ejemplo vencida. Consultar alternativas con un asesor.",
      validFrom: "2025-01-01",
      validUntil: "2025-12-31",
    },
  ],
};
export function vehicleName(id?: string) {
  if (!id) return "Vehículo por definir";

  return catalog.vehicles.find((vehicle) => vehicle.id === id)?.name ?? id;
}
export function isPromotionActive(
  p: (typeof catalog.promotions)[number],
  now: string,
) {
  const day = now.slice(0, 10);
  return p.validFrom <= day && p.validUntil >= day;
}
export const identitySchema = z.object({
  name: z.string().trim().min(2, "Escribe el nombre completo.").max(100),
  phone: phoneSchema,
  email: z
    .string()
    .transform((v) => v.replace(/\s/g, "").toLowerCase())
    .pipe(z.string().email("Escribe un correo válido.").max(200)),
});
export const rulesSchema = z
  .object({
    timeframe: z.object({
      "0-30": z.number().min(0).max(100),
      "31-90": z.number().min(0).max(100),
      "90+": z.number().min(0).max(100),
      undefined: z.number().min(0).max(100),
    }),
    intention: z.object({
      advance: z.number().min(0).max(100),
      compare: z.number().min(0).max(100),
      explore: z.number().min(0).max(100),
    }),
    capacity: z.object({
      ready: z.number().min(0).max(100),
      review: z.number().min(0).max(100),
      unavailable: z.number().min(0).max(100),
    }),
    green: z.number().min(1).max(100),
    yellow: z.number().min(0).max(99),
  })
  .refine(
    (r) => r.yellow < r.green,
    "El umbral amarillo debe ser menor que el verde.",
  )
  .refine(
    (r) =>
      Math.max(...Object.values(r.timeframe)) +
        Math.max(...Object.values(r.intention)) +
        Math.max(...Object.values(r.capacity)) <=
      100,
    "La suma de máximos no puede superar 100 puntos.",
  );
export function calculate(answers: Answers, rules: Rules, collection: CollectionProgress = {}) {
  const criteria = {} as EvaluationCriteria;
  const unknownCriteria: ScoringField[] = [];
  const declinedCriteria: ScoringField[] = [];
  for (const field of scoringFields) {
    const value = answers[field];
    const valid = value !== undefined && answersSchema.shape[field].safeParse(value).success;
    const status = collection[field] ?? (valid ? "answered" : "pending");
    let points: number | null = null;
    if (status === "answered" && valid) {
      points = (rules[field] as Record<string, number>)[value!];
    } else if ((status === "unknown" || status === "declined") && value === undefined) {
      points = 0;
      (status === "unknown" ? unknownCriteria : declinedCriteria).push(field);
    }
    criteria[field] = { status, points };
  }
  const complete = scoringFields.every(field => criteria[field].points !== null);
  const breakdown = {
    Temporalidad: criteria.timeframe.points,
    Intención: criteria.intention.points,
    Capacidad: criteria.capacity.points,
  };
  const score = complete
    ? Object.values(breakdown).reduce<number>((a, b) => a + (b ?? 0), 0)
    : null;
  const grade: Grade | null =
    score === null
      ? null
      : score >= rules.green
        ? "green"
        : score >= rules.yellow
          ? "yellow"
          : "red";
  return { score, grade, breakdown, criteria, provisional: unknownCriteria.length + declinedCriteria.length > 0, unknownCriteria, declinedCriteria };
}
export function missingBlocks(
  answers: Answers,
  collection: CollectionProgress = {},
) {
  const pending = (field: CollectionField) => {
    const status = collection[field];

    if (status !== undefined) {
      return status === "pending";
    }

    // Compatibilidad con respuestas que ya tienen un valor.
    return answers[field as keyof Answers] === undefined;
  };

  const blocks: string[] = [];

  if (pending("timeframe")) {
    blocks.push("temporalidad");
  }

  if (pending("intention")) {
    blocks.push("intención");
  }

  if (
    pending("capacity") ||
    pending("budget") ||
    pending("payment")
  ) {
    blocks.push("capacidad, presupuesto y forma de pago");
  }

  if (answers.payment === "credit" && pending("downPayment")) {
    blocks.push("enganche disponible");
  }

  if (pending("tradeIn")) {
    blocks.push("vehículo a cuenta");
  } else if (
    answers.tradeIn === true &&
    (
      pending("tradeInBrand") ||
      pending("tradeInModel") ||
      pending("tradeInYear")
    )
  ) {
    blocks.push("datos del vehículo a cuenta");
  }

  if (pending("branch") || pending("action")) {
    blocks.push("sucursal y siguiente acción");
  }

  return blocks;
}
export function commercialSummary(o:Opportunity) {
  const a=o.answers;
  return [
    o.vehicleId ? `Interés en ${vehicleName(o.vehicleId)}.` : null,
    a.timeframe?`Compra: ${labels.timeframe[a.timeframe].toLowerCase()}.`:null,
    a.intention?`${labels.intention[a.intention]}.`:null,
    a.payment?`Pago de ${labels.payment[a.payment].toLowerCase()}.`:null,
    a.capacity?`Capacidad declarada: ${labels.capacity[a.capacity].toLowerCase()}.`:null,
    a.downPayment!==undefined?`Enganche declarado: ${formatMXN(a.downPayment)}.`:null,
    a.budget!==undefined?`Presupuesto declarado: ${formatMXN(a.budget)}.`:null,
    a.tradeIn!==undefined?(a.tradeIn?'Tiene vehículo a cuenta.':'Sin vehículo a cuenta.'):null,
    a.questions && a.questions !== noQuestionsValue?`Dudas para el asesor: ${a.questions}.`:null,
    a.branch?`${catalog.branches.find(b=>b.id===a.branch)?.name??a.branch}.`:null,
    a.action?`Solicitud registrada: ${labels.action[a.action].toLowerCase()}; pendiente de confirmación.`:null,
    `Siguiente paso: ${o.nextAction.toLowerCase()}.`,
  ].filter(Boolean).join(' ');
}
export interface Detail {
  opportunity: Opportunity;
  customer: Customer;
  conversation: Conversation;
  messages: Message[];
  evaluations: Evaluation[];
  events: Event[];
  tasks: Task[];
}
export interface OpportunityListItem {
  id: string;
  customer: Pick<Customer, "id" | "name">;
  vehicleId?: string;
  score: number | null;
  grade: Grade | null;
  provisional: boolean | null;
  status: Status;
  collection: CollectionProgress;
  lastInteraction: string;
}
export interface Snapshot {
  customers: Customer[];
  opportunities: Opportunity[];
  rules: Rules;
  tasks: Task[];
  now: string;
  aiConfigured: boolean;
  catalog: typeof catalog;
}
