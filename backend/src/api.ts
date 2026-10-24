// Eigene Endpunkte unter /vanity (siehe docs/02-architektur.md, „Eigene Endpunkte“).
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { isValidHost, parseGameServer, parsePort, DEFAULT_GAME_SERVER_PORT, ConfigError } from "./config";
import type { GameServerTarget } from "./lawin";

export interface ServerStatus {
  name: string;
  hosting: boolean;
  playlist: string;
  players: number;
  maxPlayers: number;
  /** Fortnite-Version des gehosteten Spiels, z. B. "19.10" (setzt der Launcher) */
  version: string;
}

type FieldKind = "string" | "boolean" | "count";
const STATUS_FIELDS: Record<keyof ServerStatus, FieldKind> = {
  name: "string",
  hosting: "boolean",
  playlist: "string",
  players: "count",
  maxPlayers: "count",
  version: "string",
};
const MAX_STRING = 200;

export interface VanityApiOptions {
  version: string;
  getGameServer(): GameServerTarget;
  setGameServer(target: GameServerTarget): void;
}

/** true nur für Anfragen vom selben Rechner (127.0.0.1 / ::1). Proxy-Header werden ignoriert. */
export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

class BadRequest extends Error {}

function parseGameServerBody(body: unknown): GameServerTarget {
  if (typeof body === "string") return parseGameServer(body, "gameServer");
  if (typeof body !== "object" || body === null) throw new BadRequest('erwartet { "ip": "…", "port": 7777 }');

  const { ip, port } = body as { ip?: unknown; port?: unknown };
  if (typeof ip !== "string" || !isValidHost(ip.trim())) throw new BadRequest('"ip" fehlt oder ist ungültig');
  return { ip: ip.trim(), port: port === undefined ? DEFAULT_GAME_SERVER_PORT : parsePort(port, "port") };
}

function parseStatusBody(body: unknown): Partial<ServerStatus> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("erwartet ein JSON-Objekt");
  const input = body as Record<string, unknown>;
  const result: Record<string, string | boolean | number> = {};

  for (const [key, kind] of Object.entries(STATUS_FIELDS)) {
    const value = input[key];
    if (value === undefined) continue;
    if (kind === "string" && typeof value === "string" && value.length <= MAX_STRING) result[key] = value;
    else if (kind === "boolean" && typeof value === "boolean") result[key] = value;
    else if (kind === "count" && typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100000) result[key] = value;
    else throw new BadRequest(`"${key}" hat den falschen Typ (erwartet ${kind === "count" ? "Ganzzahl ≥ 0" : kind})`);
  }
  return result as Partial<ServerStatus>;
}

export function createVanityRouter(options: VanityApiOptions): Router {
  const router = express.Router();
  const status: ServerStatus = { name: "Vanity", hosting: false, playlist: "", players: 0, maxPlayers: 0, version: "" };
  const fullStatus = () => ({ ...status, gameServer: options.getGameServer() });

  // Nur vom eigenen Rechner. Außerdem nur mit Content-Type application/json: so kann eine fremde
  // Webseite im Browser des Nutzers die Endpunkte nicht per einfachem Formular-POST auslösen.
  const localJsonOnly = (req: Request, res: Response, next: NextFunction): void => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.status(403).json({ ok: false, error: "nur von 127.0.0.1 erlaubt" });
      return;
    }
    if (!req.is("application/json")) {
      res.status(415).json({ ok: false, error: "Content-Type muss application/json sein" });
      return;
    }
    next();
  };

  // Lesende Endpunkte darf jeder abfragen, auch aus einer Weboberfläche (Server-Browser).
  const publicRead = (_req: Request, res: Response, next: NextFunction): void => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "no-store");
    next();
  };

  router.get("/vanity/health", publicRead, (_req, res) => {
    res.json({ ok: true, version: options.version });
  });

  router.get("/vanity/status", publicRead, (_req, res) => {
    res.json(fullStatus());
  });

  router.post("/vanity/status", localJsonOnly, express.json({ limit: "16kb" }), (req, res) => {
    const update = parseStatusBody(req.body);
    const body = req.body as { gameServer?: unknown };
    const gameServer = body.gameServer === undefined ? undefined : parseGameServerBody(body.gameServer);

    Object.assign(status, update);
    if (gameServer) options.setGameServer(gameServer);
    res.json(fullStatus());
  });

  router.post("/vanity/gameserver", localJsonOnly, express.json({ limit: "16kb" }), (req, res) => {
    const target = parseGameServerBody(req.body);
    options.setGameServer(target);
    res.json({ ok: true, gameServer: options.getGameServer() });
  });

  // Unbekannte /vanity-Pfade nicht an LawinServer weiterreichen.
  router.use("/vanity", (_req, res) => {
    res.status(404).json({ ok: false, error: "unbekannter Vanity-Endpunkt" });
  });

  router.use((err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (!req.path.startsWith("/vanity")) return next(err);
    const parseFailed = (err as { type?: string }).type === "entity.parse.failed";
    if (err instanceof BadRequest || err instanceof ConfigError || parseFailed) {
      res.status(400).json({ ok: false, error: parseFailed ? "ungültiges JSON" : (err as Error).message });
      return;
    }
    next(err);
  });

  return router;
}
