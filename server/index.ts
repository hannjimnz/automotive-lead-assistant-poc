import "dotenv/config";

import express from "express";
import type {
  Request,
  Response,
  NextFunction,
} from "express";

import { SqliteRepository } from "./repository.js";
import { ApiError, CRMService } from "./service.js";

const app = express();

const repo = new SqliteRepository(
  process.env.DATABASE_PATH || "data/pasa.sqlite",
);

const service = new CRMService(repo);

app.use(express.json({ limit: "32kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    database: "connected",
  });
});

// Inicia una nueva conversación.
app.post("/api/conversations", (_req, res) => {
  const detail = service.createConversation();
  res.status(201).json(detail);
});

// Recupera una conversación por su oportunidad.
app.get("/api/opportunities", (_req, res) => {
  res.json(service.listOpportunities());
});

app.get("/api/opportunities/:id", (req, res) => {
  const id = String(req.params.id);
  res.json(service.detail(id));
});

app.post("/api/opportunities/:id/messages", async (req, res) => {
  res.json(await service.sendMessage(String(req.params.id), req.body));
});

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
  console.log("SQLite y servicio disponibles.");
});

function shutdown() {
  server.close(() => {
    repo.close();
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
