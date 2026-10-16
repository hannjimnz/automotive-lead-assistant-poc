import { randomUUID } from "node:crypto";

import {
  defaultRules,
  identitySchema,
  calculate,
  type Message,
  type CollectionProgress,
  type Customer,
  type Detail,
  type Opportunity,
  type OpportunityListItem,
} from "../shared/domain.js";

import { agentFieldSchema, agentOutputSchema, AnthropicAgent, type ChatAgent } from "./agent.js";
import { z } from "zod";
import { phoneSchema } from "../shared/phone.js";
import { applyUpdates } from "./updates.js";
import { SqliteRepository } from "./repository.js";

export class ApiError extends Error {
  public status: number;
  public code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class CRMService {
  private repo: SqliteRepository;
  private agent: ChatAgent;
  private active = new Set<string>();

  constructor(repo: SqliteRepository, agent: ChatAgent = new AnthropicAgent()) {
    this.repo = repo;
    this.agent = agent;

    // Crea las reglas iniciales solo si no existen.
    if (this.repo.all("rules").length === 0) {
      this.repo.put("rules", {
        ...defaultRules,
        id: randomUUID(),
        createdAt: this.now(),
      });
    }

    // Recupera mensajes interrumpidos por un reinicio.
    for (const message of this.repo.all("messages")) {
      if (message.status === "pending") {
        this.repo.put("messages", {
          ...message,
          status: "error",
          error: "El servidor se reinició. Puedes reintentar.",
        });
      }
    }
  }

  private now(): string {
    return new Date().toISOString();
  }

  listOpportunities(): OpportunityListItem[] {
    const customers = new Map(this.repo.all("customers").map(customer => [customer.id, customer]));
    // Repository insertion order preserves the latest saved evaluation, without recalculation.
    const latest = new Map(this.repo.all("evaluations").map(evaluation => [evaluation.opportunityId, evaluation]));
    return this.repo.all("opportunities").map(opportunity => {
      const customer = customers.get(opportunity.customerId);
      const collection = { ...opportunity.collection };
      for (const field of agentFieldSchema.options) {
        if (collection[field] === undefined) {
          const value = field === "vehicleId" ? opportunity.vehicleId : field === "name" || field === "phone" || field === "email" ? customer?.[field] : opportunity.answers[field];
          collection[field] = value === undefined ? "pending" : "answered";
        }
      }
      return {
        id: opportunity.id,
        customer: { id: opportunity.customerId, ...(customer?.name ? { name: customer.name } : {}) },
        vehicleId: opportunity.vehicleId,
        score: opportunity.score ?? null,
        grade: opportunity.grade ?? null,
        provisional: latest.get(opportunity.id)?.provisional ?? null,
        status: opportunity.status,
        collection,
        lastInteraction: opportunity.lastInteraction,
      };
    }).sort((a, b) => Date.parse(b.lastInteraction) - Date.parse(a.lastInteraction) || a.id.localeCompare(b.id));
  }

  async sendMessage(id: string, input: unknown): Promise<Detail> {
    const parsed = z.object({ text: z.string().min(1).max(8000).refine(v => v.trim().length > 0), requestId: z.string().trim().min(1).max(100) }).strict().safeParse(input);
    if (!parsed.success) throw new ApiError(400, "INVALID_MESSAGE", "Se requieren text y requestId válidos.");
    const { text, requestId } = parsed.data;
    if (this.active.has(id)) throw new ApiError(409, "MESSAGE_IN_PROGRESS", "Hay un mensaje en proceso para esta oportunidad.");
    const detail = this.detail(id);
    if (detail.messages.some(m => m.status === "pending")) throw new ApiError(409, "MESSAGE_IN_PROGRESS", "Hay un mensaje en proceso para esta oportunidad.");
    const existing = detail.messages.find(m => m.role === "user" && m.requestId === requestId);
    if (existing && existing.text !== text) throw new ApiError(409, "REQUEST_ID_CONFLICT", "requestId ya corresponde a otro texto.");
    if (existing && detail.messages.slice(detail.messages.indexOf(existing) + 1).some(m => m.role === "user")) throw new ApiError(409, "STALE_REQUEST", "Este mensaje tiene mensajes posteriores; no se puede reintentar.");
    if (existing?.status === "complete") return detail;
    if (existing?.status === "pending") throw new ApiError(409, "MESSAGE_IN_PROGRESS", "El mensaje sigue en proceso.");
    this.active.add(id);
    const message: Message = { ...existing, id: existing?.id ?? randomUUID(), conversationId: detail.conversation.id, role: "user", text, requestId, createdAt: existing?.createdAt ?? this.now(), status: "pending" };
    delete message.error;
    let stage = "save_message";
    try {
      this.repo.transaction(() => this.repo.put("messages", message));
      stage = "agent";
      if (!this.agent.configured) throw new ApiError(503, "AI_NOT_CONFIGURED", "Configura el proveedor de IA para procesar mensajes.");
      const raw = await this.agent.respond({ contact: detail.customer, vehicleId: detail.opportunity.vehicleId, answers: detail.opportunity.answers, collection: detail.opportunity.collection ?? {}, messages: detail.messages.filter(m => m.id !== message.id), proposals: detail.opportunity.proposals, pendingQuestion: detail.opportunity.pendingQuestion }, text);
      stage = "validate_output";
      const output = agentOutputSchema.parse(raw);
      return this.repo.transaction(() => {
        const current = this.detail(id);
        const customer = current.customer;
        const opportunity = current.opportunity;
        const assistantId = randomUUID();
        stage = "apply_updates";
        const changes = applyUpdates(current, output, message, assistantId, (field, value) => {
          const conflict = this.repo.all("customers").some(other => {
            if (other.id === customer.id) return false;
            const candidate = field === "phone" ? phoneSchema.safeParse(other.phone) : identitySchema.shape.email.safeParse(other.email);
            return candidate.success && candidate.data === value;
          });
          if (conflict) throw new ApiError(409, "CONTACT_CONFLICT", "El teléfono o correo pertenece a otro cliente. No se modificó ningún contacto.");
        });
        const rules = this.repo.all("rules").at(-1)!;
        const evaluation = calculate(opportunity.answers, rules, opportunity.collection);
        const now = this.now();
        stage = "persist_result";
        Object.assign(opportunity, { score: evaluation.score, grade: evaluation.grade, ruleVersion: rules.version, status: evaluation.score === null ? "conversing" : "qualified", updatedAt: now, lastInteraction: now, revision: opportunity.revision + 1 });
        customer.updatedAt = now;
        this.repo.put("customers", customer);
        this.repo.put("opportunities", opportunity);
        this.repo.put("messages", { ...message, status: "complete" });
        this.repo.put("messages", { id: assistantId, conversationId: detail.conversation.id, role: "assistant", text: changes.response, status: "complete", requestId, createdAt: now });
        this.repo.put("evaluations", { id: randomUUID(), opportunityId: id, ...evaluation, ruleVersion: rules.version, createdAt: now });
        this.repo.put("events", { id: randomUUID(), opportunityId: id, type: "message_processed", description: "Actualizaciones del mensaje validadas.", createdAt: now, data: { messageId: message.id, requestId, accepted: changes.accepted, rejected: changes.rejected, transitions: changes.transitions, proposals: changes.proposalEvents, collection: opportunity.collection } });
        return this.detail(id);
      });
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(502, "AI_PROCESSING_FAILED", "No se pudo procesar el mensaje. Reintenta con el mismo requestId y texto.");
      this.repo.transaction(() => {
        this.repo.put("messages", { ...message, status: "error", error: apiError.code });
        this.repo.put("events", { id: randomUUID(), opportunityId: id, type: "message_failed", description: apiError.code, createdAt: this.now(), data: { messageId: message.id, requestId } });
      });
      const metadata = error as { status?: unknown; request_id?: unknown; requestID?: unknown } | null;
      const knownCategories = ["AI_RESPONSE_TRUNCATED", "AI_RESPONSE_MISSING", "AI_RESPONSE_INVALID_JSON", "AI_NOT_CONFIGURED"];
      const category = error instanceof Error && knownCategories.includes(error.message) ? error.message : error instanceof z.ZodError ? "AI_RESPONSE_INVALID_SCHEMA" : apiError.code;
      const providerId = metadata?.requestID ?? metadata?.request_id;
      console.error("Fallo de procesamiento", { category, stage, ...(typeof metadata?.status === "number" ? { httpStatus: metadata.status } : {}), ...(typeof providerId === "string" && /^[\w-]{1,200}$/.test(providerId) ? { providerRequestId: providerId } : {}) });
      throw apiError;
    } finally {
      this.active.delete(id);
    }
  }

  createConversation(): Detail {
    return this.repo.transaction(() => {
      const now = this.now();

      const customer: Customer = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
      };

      const collection: CollectionProgress = {};

      for (const field of agentFieldSchema.options) {
        collection[field] = "pending";
      }

      const opportunity: Opportunity = {
        id: randomUUID(),
        customerId: customer.id,
        promotionId: null,
        source: "Chat local de demostración",
        campaign: "",
        status: "new",
        answers: {},
        collection,
        answerSources: {},
        score: null,
        grade: null,
        ruleVersion: null,
        nextAction: "Recopilar información",
        createdAt: now,
        updatedAt: now,
        lastInteraction: now,
        revision: 0,
      };

      const conversation = {
        id: randomUUID(),
        opportunityId: opportunity.id,
        createdAt: now,
      };

      this.repo.put("customers", customer);
      this.repo.put("opportunities", opportunity);
      this.repo.put("conversations", conversation);

      this.repo.put("messages", {
        id: randomUUID(),
        conversationId: conversation.id,
        role: "assistant",
        text:
          "¡Hola! Soy el asistente de PASA. " +
          "Puedo ayudarte a registrar tu interés en un vehículo " +
          "y preparar la información para un asesor. " +
          "Estamos usando un catálogo de demostración. " +
          "¿Cómo te llamas?",
        status: "complete",
        createdAt: now,
      });

      this.repo.put("events", {
        id: randomUUID(),
        opportunityId: opportunity.id,
        type: "conversation_started",
        description: "Conversación de demostración iniciada.",
        createdAt: now,
      });

      return this.detail(opportunity.id);
    });
  }

  detail(id: string): Detail {
    const opportunity = this.repo.get("opportunities", id);

    if (!opportunity) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        "No se encontró la oportunidad.",
      );
    }

    const customer = this.repo.get(
      "customers",
      opportunity.customerId,
    );

    const conversation = this.repo
      .all("conversations")
      .find((item) => item.opportunityId === id);

    if (!customer || !conversation) {
      throw new ApiError(
        500,
        "INCOMPLETE_RECORD",
        "No se pudo recuperar la ficha completa.",
      );
    }

    return {
      opportunity,
      customer,
      conversation,
      messages: this.repo
        .all("messages")
        .filter((item) => item.conversationId === conversation.id),
      evaluations: this.repo
        .all("evaluations")
        .filter((item) => item.opportunityId === id),
      events: this.repo
        .all("events")
        .filter((item) => item.opportunityId === id),
      tasks: this.repo
        .all("tasks")
        .filter((item) => item.opportunityId === id),
    };
  }
}
