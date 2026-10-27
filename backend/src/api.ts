// Own endpoints under /niobium (see backend/README.md, "Own endpoints", and docs/02-architecture.md, "Backend").
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { isValidHost, parseGameServer, parsePort, DEFAULT_GAME_SERVER_PORT, ConfigError } from "./config";
import type { GameServerTarget } from "./lawin";

export interface ServerStatus {
  name: string;
  hosting: boolean;
  playlist: string;
  players: number;
  maxPlayers: number;
  /** Fortnite version of the hosted game, e.g. "19.10" (set by the launcher) */
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

export interface NiobiumApiOptions {
  version: string;
  getGameServer(): GameServerTarget;
  setGameServer(target: GameServerTarget): void;
}

/** true only for requests from the same computer (127.0.0.1 / ::1). Proxy headers are ignored. */
export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

class BadRequest extends Error {}

function parseGameServerBody(body: unknown): GameServerTarget {
  if (typeof body === "string") return parseGameServer(body, "gameServer");
  if (typeof body !== "object" || body === null) throw new BadRequest('expected { "ip": "…", "port": 7777 }');

  const { ip, port } = body as { ip?: unknown; port?: unknown };
  if (typeof ip !== "string" || !isValidHost(ip.trim())) throw new BadRequest('"ip" is missing or invalid');
  return { ip: ip.trim(), port: port === undefined ? DEFAULT_GAME_SERVER_PORT : parsePort(port, "port") };
}

function parseStatusBody(body: unknown): Partial<ServerStatus> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("expected a JSON object");
  const input = body as Record<string, unknown>;
  const result: Record<string, string | boolean | number> = {};

  for (const [key, kind] of Object.entries(STATUS_FIELDS)) {
    const value = input[key];
    if (value === undefined) continue;
    if (kind === "string" && typeof value === "string" && value.length <= MAX_STRING) result[key] = value;
    else if (kind === "boolean" && typeof value === "boolean") result[key] = value;
    else if (kind === "count" && typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100000) result[key] = value;
    else throw new BadRequest(`"${key}" has the wrong type (expected ${kind === "count" ? "a whole number ≥ 0" : kind})`);
  }
  return result as Partial<ServerStatus>;
}

export function createNiobiumRouter(options: NiobiumApiOptions): Router {
  const router = express.Router();
  const status: ServerStatus = { name: "Rift", hosting: false, playlist: "", players: 0, maxPlayers: 0, version: "" };
  const fullStatus = () => ({ ...status, gameServer: options.getGameServer() });

  // Only from this computer. Also only with Content-Type application/json: that way another
  // website in the user's browser can't trigger the endpoints with a simple form POST.
  const localJsonOnly = (req: Request, res: Response, next: NextFunction): void => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.status(403).json({ ok: false, error: "only allowed from 127.0.0.1" });
      return;
    }
    if (!req.is("application/json")) {
      res.status(415).json({ ok: false, error: "Content-Type must be application/json" });
      return;
    }
    next();
  };

  // Anyone may call the reading endpoints, also from a web page (server browser).
  const publicRead = (_req: Request, res: Response, next: NextFunction): void => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "no-store");
    next();
  };

  router.get("/niobium/health", publicRead, (_req, res) => {
    res.json({ ok: true, version: options.version });
  });

  router.get("/niobium/status", publicRead, (_req, res) => {
    res.json(fullStatus());
  });

  router.post("/niobium/status", localJsonOnly, express.json({ limit: "16kb" }), (req, res) => {
    const update = parseStatusBody(req.body);
    const body = req.body as { gameServer?: unknown };
    const gameServer = body.gameServer === undefined ? undefined : parseGameServerBody(body.gameServer);

    Object.assign(status, update);
    if (gameServer) options.setGameServer(gameServer);
    res.json(fullStatus());
  });

  router.post("/niobium/gameserver", localJsonOnly, express.json({ limit: "16kb" }), (req, res) => {
    const target = parseGameServerBody(req.body);
    options.setGameServer(target);
    res.json({ ok: true, gameServer: options.getGameServer() });
  });

  // Don't pass unknown /niobium paths on to LawinServer.
  router.use("/niobium", (_req, res) => {
    res.status(404).json({ ok: false, error: "unknown Rift endpoint" });
  });

  router.use((err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (!req.path.startsWith("/niobium")) return next(err);
    const parseFailed = (err as { type?: string }).type === "entity.parse.failed";
    if (err instanceof BadRequest || err instanceof ConfigError || parseFailed) {
      res.status(400).json({ ok: false, error: parseFailed ? "invalid JSON" : (err as Error).message });
      return;
    }
    next(err);
  });

  return router;
}
