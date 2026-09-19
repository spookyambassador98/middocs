import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { config } from "./config.js";
import { authRouter } from "./auth/routes.js";
import { documentsRouter } from "./documents/routes.js";
import { attachRealtime } from "./realtime/socket.js";

async function main() {
  const app = express();
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, instance: config.instanceId });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/documents", documentsRouter);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[http] unhandled error", err);
    res.status(500).json({ error: "Internal server error" });
  });

  const httpServer = createServer(app);
  const { shutdown } = await attachRealtime(httpServer);

  httpServer.listen(config.port, () => {
    console.log(`[${config.instanceId}] listening on :${config.port}`);
  });

  const stop = async (signal: string) => {
    console.log(`[${config.instanceId}] received ${signal}, shutting down...`);
    await shutdown();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
