// Einstellungen aus Umgebungsvariablen (siehe docs/02-architektur.md, Abschnitt „Backend“).
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { GameServerTarget } from "./lawin";

export interface BackendConfig {
  /** VANITY_BACKEND_PORT – HTTP (alle umgeleiteten Epic-Anfragen + /vanity/*) */
  httpPort: number;
  /** VANITY_MATCHMAKER_PORT – WebSocket für Matchmaker und XMPP */
  matchmakerPort: number;
  /** VANITY_BIND – Adresse, auf der beide Ports lauschen */
  bind: string;
  /** VANITY_DATA_DIR – beschreibbare Daten (Profile, Einstellungen) */
  dataDir: string;
  /** VANITY_GAMESERVER – wohin der Matchmaker Spieler schickt */
  gameServer: GameServerTarget;
}

export class ConfigError extends Error {}

export const DEFAULT_GAME_SERVER_PORT = 7777;

export function parsePort(value: unknown, name: string): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const port = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${name}: "${String(value)}" ist kein gültiger Port (1–65535)`);
  }
  return port;
}

/** IPv4/IPv6-Adresse oder Rechnername (ohne Leerzeichen, ohne Port). */
export function isValidHost(host: string): boolean {
  if (net.isIP(host) !== 0) return true;
  return host.length > 0 && host.length <= 253 && /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host);
}

/** "ip:port" (Port optional, Standard 7777). IPv6 mit Port in eckigen Klammern: "[::1]:7777". */
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

  if (!isValidHost(ip)) throw new ConfigError(`${name}: "${value}" ist keine gültige Adresse (erwartet "ip:port")`);
  return { ip, port };
}

export function defaultDataDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "Vanity", "backend");
  }
  return path.join(os.homedir(), ".vanity", "backend");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const value = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };

  const bind = value("VANITY_BIND") ?? "127.0.0.1";
  if (net.isIP(bind) === 0) throw new ConfigError(`VANITY_BIND: "${bind}" ist keine IP-Adresse`);

  const dataDirRaw = value("VANITY_DATA_DIR");

  return {
    httpPort: parsePort(value("VANITY_BACKEND_PORT") ?? "3551", "VANITY_BACKEND_PORT"),
    matchmakerPort: parsePort(value("VANITY_MATCHMAKER_PORT") ?? "80", "VANITY_MATCHMAKER_PORT"),
    bind,
    dataDir: path.resolve(dataDirRaw ?? defaultDataDir()),
    gameServer: parseGameServer(value("VANITY_GAMESERVER") ?? `127.0.0.1:${DEFAULT_GAME_SERVER_PORT}`, "VANITY_GAMESERVER"),
  };
}
