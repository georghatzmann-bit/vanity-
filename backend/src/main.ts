// Vanity-Backend: Einstiegspunkt.
// Liest die Einstellungen aus Umgebungsvariablen, bereitet den Daten-Ordner vor, hängt die
// /vanity-Endpunkte vor LawinServer und startet HTTP (VANITY_BACKEND_PORT) sowie
// XMPP + Matchmaker (VANITY_MATCHMAKER_PORT).
import http from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { createVanityRouter } from "./api";
import { forwardAsyncErrors } from "./async-errors";
import { ConfigError, loadConfig, type BackendConfig } from "./config";
import { findResourceDir, prepareDataDir } from "./data";
import { createLawinApp, startXmppAndMatchmaker, vanity } from "./lawin";

declare const __VANITY_VERSION__: string | undefined;
const VERSION = typeof __VANITY_VERSION__ === "string" ? __VANITY_VERSION__ : "dev";

function log(message: string): void {
  console.log(`[Vanity] ${message}`);
}

function pathOf(req: Request): string {
  return req.originalUrl.split("?")[0] ?? req.originalUrl;
}

/** Eine Zeile pro Anfrage: `[HTTP] GET /pfad → 200` */
function requestLog(req: Request, res: Response, next: NextFunction): void {
  const method = req.method;
  const path = pathOf(req);
  res.on("close", () => {
    console.log(`[HTTP] ${method} ${path} → ${res.writableFinished ? res.statusCode : "abgebrochen"}`);
  });
  next();
}

function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const status = (err as { status?: unknown }).status;
  const code = typeof status === "number" && status >= 400 && status < 600 ? status : 500;
  if (code >= 500) console.error(`[Vanity] Fehler bei ${req.method} ${pathOf(req)}:`, err);
  if (res.headersSent) {
    // Antwort läuft schon (z. B. Fehler nach res.json) – nur sauber abschließen
    if (!res.writableEnded) res.end();
    return;
  }
  res.status(code).json({
    errorCode: code >= 500 ? "errors.com.vanity.internal_error" : "errors.com.vanity.bad_request",
    errorMessage: code >= 500 ? "Interner Fehler im Vanity-Backend" : String((err as Error).message ?? err),
    numericErrorCode: code,
    originatingService: "vanity",
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
    console.error(`[Vanity] ${err instanceof ConfigError ? err.message : String(err)}`);
    process.exit(1);
  }

  const resourceDir = findResourceDir(__dirname);
  vanity.configure({
    resourceDir,
    dataDir: config.dataDir,
    bindAddress: config.bind,
    matchmakerPort: config.matchmakerPort,
    gameServer: config.gameServer,
  });

  const copied = prepareDataDir(resourceDir, config.dataDir, vanity.WRITABLE);
  log(`Daten-Ordner: ${config.dataDir}${copied.length ? ` (${copied.length} Standard-Dateien kopiert)` : ""}`);

  // LawinServer nutzt async-Handler: Fehler darin werden zu einer 500-Antwort (statt hängender
  // Anfrage), alles Übrige wird nur geloggt, damit das Backend weiterläuft.
  forwardAsyncErrors();
  process.on("unhandledRejection", (reason) => {
    console.error("[Vanity] Unbehandelter Fehler:", reason);
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(requestLog);
  app.use(
    createVanityRouter({
      version: VERSION,
      getGameServer: () => ({ ...vanity.settings.gameServer }),
      setGameServer: (target) => {
        vanity.setGameServer(target.ip, target.port);
        log(`Matchmaker schickt Spieler jetzt zu ${target.ip}:${target.port}`);
      },
    }),
  );
  app.use(createLawinApp());
  app.use(errorHandler);

  const server = http.createServer(app);
  server.on("error", (err: NodeJS.ErrnoException) => {
    const reason = err.code === "EADDRINUSE" ? "ist schon belegt" : `geht nicht (${err.code ?? err.message})`;
    console.error(`[Vanity] HTTP-Port ${config.bind}:${config.httpPort} ${reason}`);
    process.exit(1);
  });

  server.listen(config.httpPort, config.bind, () => {
    log(`Backend ${VERSION} läuft auf http://${urlHost(config.bind)}:${config.httpPort} (Bind ${config.bind})`);
    log(`Matchmaker-Ziel: ${config.gameServer.ip}:${config.gameServer.port}`);
    startXmppAndMatchmaker();
  });

  const stop = (): void => {
    log("wird beendet");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
