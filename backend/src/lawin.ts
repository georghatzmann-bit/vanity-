// Brücke zu den (JavaScript-)Teilen von LawinServer in ../lawinserver.
// esbuild packt alles in dist/main.js; die require()-Aufrufe in den Funktionen laufen erst,
// wenn sie aufgerufen werden – also erst nachdem main.ts vanity.configure() aufgerufen hat.
import type { Express } from "express";

export interface GameServerTarget {
  ip: string;
  port: number;
}

interface VanitySettings {
  resourceDir: string;
  dataDir: string;
  bindAddress: string;
  matchmakerPort: number;
  gameServer: GameServerTarget;
}

interface VanityBridge {
  /** Pfade relativ zum LawinServer-Ordner, die im Daten-Ordner liegen (Ordner enden mit "/"). */
  readonly WRITABLE: readonly string[];
  readonly settings: Readonly<VanitySettings>;
  configure(options: Partial<VanitySettings>): void;
  setGameServer(ip: string, port: number): void;
}

/** lawinserver/structure/vanity.js – Pfade, Ports, Game-Server-Ziel (hat keine Nebenwirkungen beim Laden). */
export const vanity = require("../lawinserver/structure/vanity.js") as VanityBridge;

/** Baut die Express-App von LawinServer (alle Epic-Endpunkte + 404-Antwort). */
export function createLawinApp(): Express {
  const lawin = require("../lawinserver/index.js") as { createApp(): Express };
  return lawin.createApp();
}

/** Startet XMPP + Matchmaker-WebSocket (lauscht auf vanity.settings.matchmakerPort). */
export function startXmppAndMatchmaker(): void {
  require("../lawinserver/structure/xmpp.js");
}
