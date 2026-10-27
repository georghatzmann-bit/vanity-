// Rift backend: entry point.
// Reads the settings from environment variables, prepares the data folder, puts the
// /niobium endpoints in front of LawinServer and starts HTTP (NIOBIUM_BACKEND_PORT) and
// XMPP + matchmaker (NIOBIUM_MATCHMAKER_PORT).
import http from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { createNiobiumRouter } from "./api";
import { forwardAsyncErrors } from "./async-errors";
import { ConfigError, loadConfig, type BackendConfig } from "./config";
import { findResourceDir, prepareDataDir } from "./data";
import { createLawinApp, niobium, startXmppAndMatchmaker } from "./lawin";
import { createStubRouter } from "./stubs";

declare const __NIOBIUM_VERSION__: string | undefined;
const VERSION = typeof __NIOBIUM_VERSION__ === "string" ? __NIOBIUM_VERSION__ : "dev";

function log(message: string): void {
  console.log(`[Rift] ${message}`);
}

function pathOf(req: Request): string {
  return req.originalUrl.split("?")[0] ?? req.originalUrl;
}

/** One line per request: `[HTTP] GET /path → 200` */
function requestLog(req: Request, res: Response, next: NextFunction): void {
  const method = req.method;
  const path = pathOf(req);
  res.on("close", () => {
    console.log(`[HTTP] ${method} ${path} → ${res.writableFinished ? res.statusCode : "aborted"}`);
  });
  next();
}

function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const status = (err as { status?: unknown }).status;
  const code = typeof status === "number" && status >= 400 && status < 600 ? status : 500;
  if (code >= 500) console.error(`[Rift] Error at ${req.method} ${pathOf(req)}:`, err);
  if (res.headersSent) {
    // The answer is already on its way (e.g. an error after res.json) – just finish it cleanly
    if (!res.writableEnded) res.end();
    return;
  }
  res.status(code).json({
    errorCode: code >= 500 ? "errors.com.rift.internal_error" : "errors.com.rift.bad_request",
    errorMessage: code >= 500 ? "Internal error in the Rift backend" : String((err as Error).message ?? err),
    numericErrorCode: code,
    originatingService: "rift",
    intent: "prod",
  });
}

function urlHost(bind: string): string {
  if (bind === "0.0.0.0" || bind === "::") return "127.0.0.1";
  return bind.includes(":") ? `[${bind}]` : bind;
}

function main(): void {
  let config: BackendConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[Rift] ${err instanceof ConfigError ? err.message : String(err)}`);
    process.exit(1);
  }

  const resourceDir = findResourceDir(__dirname);
  niobium.configure({
    resourceDir,
    dataDir: config.dataDir,
    bindAddress: config.bind,
    matchmakerPort: config.matchmakerPort,
    gameServer: config.gameServer,
  });

  const copied = prepareDataDir(resourceDir, config.dataDir, niobium.WRITABLE);
  log(`Data folder: ${config.dataDir}${copied.length ? ` (${copied.length} default files copied)` : ""}`);

  // LawinServer uses async handlers: errors in them become a 500 answer (instead of a hanging
  // request), everything else is only logged, so the backend keeps running.
  forwardAsyncErrors();
  process.on("unhandledRejection", (reason) => {
    console.error("[Rift] Unhandled error:", reason);
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(requestLog);
  app.use(
    createNiobiumRouter({
      version: VERSION,
      getGameServer: () => ({ ...niobium.settings.gameServer }),
      setGameServer: (target) => {
        niobium.setGameServer(target.ip, target.port);
        log(`The matchmaker now sends players to ${target.ip}:${target.port}`);
      },
    }),
  );
  app.use(createStubRouter()); // endpoints of newer builds that LawinServer doesn't know
  app.use(createLawinApp());
  app.use(errorHandler);

  const server = http.createServer(app);
  server.on("error", (err: NodeJS.ErrnoException) => {
    const reason = err.code === "EADDRINUSE" ? "is already in use" : `doesn't work (${err.code ?? err.message})`;
    console.error(`[Rift] HTTP port ${config.bind}:${config.httpPort} ${reason}`);
    process.exit(1);
  });

  server.listen(config.httpPort, config.bind, () => {
    log(`Backend ${VERSION} is running on http://${urlHost(config.bind)}:${config.httpPort} (bind ${config.bind})`);
    log(`Matchmaker target: ${config.gameServer.ip}:${config.gameServer.port}`);
    startXmppAndMatchmaker();
  });

  const stop = (): void => {
    log("shutting down");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
