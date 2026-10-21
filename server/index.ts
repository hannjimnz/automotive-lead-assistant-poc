import "dotenv/config";

import express from "express";
import type {
  Request,
  Response,
  NextFunction,
} from "express";

import { createSupabaseRepository } from "./supabase-repository.js";
import { ApiError, CRMService } from "./service.js";
import { campaignRoutes } from "./campaigns.js";
import { frontendRoutes } from "./frontend.js";
import { followupRoutes } from "./followup-routes.js";
import { createLeadSyncWorker } from "./lead-sync.js";

const app = express();

const repo = createSupabaseRepository();
await repo.verify();

const service = new CRMService(repo);
await service.ready;
const leadSyncWorker = (await createLeadSyncWorker(repo));

app.use(express.json({ limit: "32kb" }));
app.use(campaignRoutes(repo));
app.use(followupRoutes(service));

app.get("/api/health", async (_req, res) => {
  res.json({
    status: "ok",
    database: "connected",
    prospectSync: {
      enabled: leadSyncWorker !== undefined,
      ...(await repo.leadSyncCounts()),
    },
  });
});

// Inicia una nueva conversación.
app.post("/api/conversations", async (_req, res) => {
  const detail = (await service.createConversation());
  res.status(201).json(detail);
});

// Recupera una conversación por su oportunidad.
app.get("/api/opportunities", async (_req, res) => {
  res.json((await service.listOpportunities()));
});

app.get("/api/opportunities/:id", async (req, res) => {
  const id = String(req.params.id);
  res.json((await service.detail(id)));
});

app.post("/api/opportunities/:id/messages", async (req, res) => {
  res.json(await service.sendMessage(String(req.params.id), req.body));
});

app.use(frontendRoutes());

// Manejo centralizado de errores.
app.use(
  (
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    void _next; // Express identifies error middleware by its four arguments.
    const parseError = error as { type?: string } | null;
    if (parseError?.type === "entity.parse.failed" || parseError?.type === "entity.too.large") {
      res.status(parseError.type === "entity.too.large" ? 413 : 400).json({ code: "INVALID_BODY", message: "El cuerpo JSON es inválido o demasiado grande." });
      return;
    }
    if (error instanceof ApiError) {
      res.status(error.status).json({
        code: error.code,
        message: error.message,
      });
      return;
    }

    // No imprime solicitudes, credenciales ni datos del cliente.
    console.error("Error interno de API", {
      type: error instanceof Error ? error.name : "UnknownError",
    });

    res.status(500).json({
      code: "INTERNAL_ERROR",
      message: "No se pudo completar la operación.",
    });
  },
);

const server = app.listen(3001, "127.0.0.1", () => {
  console.log("PASA API: http://127.0.0.1:3001");
  console.log("Supabase PostgreSQL y servicio disponibles.");
});

async function runFollowups() {
  try { (await service.followups.tick()); }
  catch (error) { console.error('Fallo de seguimiento', { category: 'FOLLOWUP_EXECUTION_FAILED', type: error instanceof Error ? error.name : 'UnknownError' }); }
}
runFollowups(); // Recover overdue persisted tasks on startup.
const followupTimer = setInterval(runFollowups, 30_000);
followupTimer.unref();

function shutdown() {
  clearInterval(followupTimer);
  server.close(async () => {
    void (leadSyncWorker?.stop() ?? Promise.resolve()).finally(async () => {
      (await repo.close());
      process.exit(0);
    });
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
