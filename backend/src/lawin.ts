// Bridge to the (JavaScript) parts of LawinServer in ../lawinserver.
// esbuild bundles everything into dist/main.js; the require() calls inside the functions only run
// when they are called – that is, only after main.ts has called niobium.configure().
import type { Express } from "express";

export interface GameServerTarget {
  ip: string;
  port: number;
}

interface NiobiumSettings {
  resourceDir: string;
  dataDir: string;
  bindAddress: string;
  matchmakerPort: number;
  gameServer: GameServerTarget;
}

interface NiobiumBridge {
  /** Paths relative to the LawinServer folder that live in the data folder (folders end with "/"). */
  readonly WRITABLE: readonly string[];
  readonly settings: Readonly<NiobiumSettings>;
  configure(options: Partial<NiobiumSettings>): void;
  setGameServer(ip: string, port: number): void;
}

/** lawinserver/structure/niobium.js – paths, ports, game server target (no side effects when loaded). */
export const niobium = require("../lawinserver/structure/niobium.js") as NiobiumBridge;

/** Builds LawinServer's Express app (all Epic endpoints + the 404 answer). */
export function createLawinApp(): Express {
  const lawin = require("../lawinserver/index.js") as { createApp(): Express };
  return lawin.createApp();
}

interface Listening {
  once(event: "listening", listener: () => void): unknown;
  once(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
}

/**
 * Starts XMPP + the matchmaker WebSocket on niobium.settings.matchmakerPort.
 * Resolves once it listens; rejects with the listen error (e.g. code EADDRINUSE).
 */
export function startXmppAndMatchmaker(): Promise<void> {
  const wss = require("../lawinserver/structure/xmpp.js") as Listening;
  return new Promise((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
}
