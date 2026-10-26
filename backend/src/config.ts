// Settings from environment variables (see docs/02-architecture.md, section "Backend").
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { GameServerTarget } from "./lawin";

export interface BackendConfig {
  /** NIOBIUM_BACKEND_PORT – HTTP (all redirected Epic requests + /niobium/*) */
  httpPort: number;
  /** NIOBIUM_MATCHMAKER_PORT – WebSocket for the matchmaker and XMPP */
  matchmakerPort: number;
  /** NIOBIUM_BIND – address both ports listen on */
  bind: string;
  /** NIOBIUM_DATA_DIR – writable data (profiles, settings) */
  dataDir: string;
  /** NIOBIUM_GAMESERVER – where the matchmaker sends players */
  gameServer: GameServerTarget;
}

export class ConfigError extends Error {}

export const DEFAULT_GAME_SERVER_PORT = 7777;

export function parsePort(value: unknown, name: string): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const port = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${name}: "${String(value)}" is not a valid port (1–65535)`);
  }
  return port;
}

/** IPv4/IPv6 address or host name (no spaces, no port). */
export function isValidHost(host: string): boolean {
  if (net.isIP(host) !== 0) return true;
  return host.length > 0 && host.length <= 253 && /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host);
}

/** "ip:port" (port optional, default 7777). IPv6 with a port in square brackets: "[::1]:7777". */
export function parseGameServer(value: string, name: string): GameServerTarget {
  const text = value.trim();
  let ip = text;
  let port = DEFAULT_GAME_SERVER_PORT;

  const bracketed = /^\[([^\]]+)\](?::(.*))?$/.exec(text);
  if (bracketed) {
    ip = bracketed[1] ?? "";
    if (bracketed[2] !== undefined) port = parsePort(bracketed[2], name);
  } else if (text.split(":").length === 2) {
    const [host = "", portText = ""] = text.split(":");
    ip = host;
    port = parsePort(portText, name);
  }

  if (!isValidHost(ip)) throw new ConfigError(`${name}: "${value}" is not a valid address (expected "ip:port")`);
  return { ip, port };
}

export function defaultDataDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    // Not "backend": that is where the installer puts the backend itself (see engine.rs).
    return path.join(localAppData, "Niobium", "backend-data");
  }
  return path.join(os.homedir(), ".niobium", "backend");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const value = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };

  const bind = value("NIOBIUM_BIND") ?? "127.0.0.1";
  if (net.isIP(bind) === 0) throw new ConfigError(`NIOBIUM_BIND: "${bind}" is not an IP address`);

  const dataDirRaw = value("NIOBIUM_DATA_DIR");

  return {
    httpPort: parsePort(value("NIOBIUM_BACKEND_PORT") ?? "3551", "NIOBIUM_BACKEND_PORT"),
    matchmakerPort: parsePort(value("NIOBIUM_MATCHMAKER_PORT") ?? "80", "NIOBIUM_MATCHMAKER_PORT"),
    bind,
    dataDir: path.resolve(dataDirRaw ?? defaultDataDir()),
    gameServer: parseGameServer(value("NIOBIUM_GAMESERVER") ?? `127.0.0.1:${DEFAULT_GAME_SERVER_PORT}`, "NIOBIUM_GAMESERVER"),
  };
}
