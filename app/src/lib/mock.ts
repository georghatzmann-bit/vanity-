/**
 * Demo-Backend für den Browser (Vorschau, Screenshots, Tests).
 * Bildet die Rust-Befehle mit Beispieldaten nach. In der echten App wird es nie geladen.
 */
import type {
  AdapterInfo, ApplyReport, BoostProfile, BoostState, DnsConfig, DnsResult, Game, GameImages, ImageKind, LaunchConfig, MonitorUpdate, PingSample, PingStats,
  PingTarget, PlayStats, PowerPlan, Region, RegionPing, ScannedEntry, Session, SessionReport, SpeedProgress, SpeedResult, TraceHop, TraceResult, Tweak, WifiInfo,
} from "./types";
import { DEMO_ART } from "./demo-art";
import { bufferbloatGrade, compressTimeline, countSpikes, pingGrade, summarize } from "./grade";

type Handler = (p: unknown) => void;
const listeners = new Map<string, Set<Handler>>();
const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((h) => h(payload));

export function mockListen(event: string, handler: Handler): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler);
  return () => listeners.get(event)?.delete(handler);
}

const DAY = 86400000;
const now = Date.now();
let seed = 1337;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Spiele
// ---------------------------------------------------------------------------------------------

const demo: Array<[string, "game" | "app", Game["source"], string?, string?]> = [
  ["Counter-Strike 2", "game", "steam", "730", "cs2"],
  ["Elden Ring", "game", "steam", "1245620"],
  ["Hades II", "game", "steam", "1145350"],
  ["Rocket League", "game", "epic", "sugar"],
  ["Dota 2", "game", "steam", "570", "dota2"],
  ["Stardew Valley", "game", "steam", "413150"],
  ["Forza Horizon 5", "game", "steam", "1551360"],
  ["Baldur's Gate 3", "game", "steam", "1086940"],
  ["Hollow Knight: Silksong", "game", "steam", "1030300"],
  ["Alan Wake 2", "game", "epic", "alan-wake-2"],
  ["Cyberpunk 2077", "game", "gog", "1423049311"],
  ["Sea of Thieves", "game", "steam", "1172620"],
  ["Balatro", "game", "steam", "2379780"],
  ["It Takes Two", "game", "steam", "1426210"],
  ["Satisfactory", "game", "epic", "satisfactory"],
  ["Portal 2", "game", "steam", "620"],
  ["Red Dead Redemption 2", "game", "steam", "1174180"],
  ["Lethal Company", "game", "steam", "1966720"],
  ["Death Stranding", "game", "epic", "death-stranding"],
  ["Factorio", "game", "steam", "427520"],
  ["OBS Studio", "app", "startmenu"],
  ["Blender", "app", "startmenu"],
  ["Wallpaper Engine", "app", "startmenu"],
  ["Krita", "app", "startmenu"],
];

function demoImages(name: string, kind: "game" | "app", kinds: ImageKind[] = ["cover", "hero", "logo", "icon"]): GameImages {
  const art = DEMO_ART[name] ?? {};
  const allowed = kind === "app" ? kinds.filter((k) => k === "icon") : kinds;
  return Object.fromEntries(allowed.filter((k) => art[k]).map((k) => [k, art[k]]));
}

function makeGames(): Game[] {
  return demo.map(([name, kind, source, sourceId, serverGame], i) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const launch: LaunchConfig = source === "steam" && sourceId ? { type: "url", target: `steam://rungameid/${sourceId}` } : { type: "exe", target: `C:\\Games\\${name}\\${slug}.exe` };
    return {
      id: `demo-${slug}`,
      name,
      kind,
      source,
      sourceId,
      launch,
      installDir: `C:\\Games\\${name}`,
      exePath: launch.type === "exe" ? launch.target : undefined,
      images: demoImages(name, kind),
      imagesCheckedAt: now,
      favorite: [0, 1, 3, 4].includes(i),
      hidden: false,
      addedAt: now - (40 - i) * DAY * 2.2,
      updatedAt: now - i * DAY,
      serverGame,
      region: i === 1 ? "aws-eu-west-3" : undefined,
    } satisfies Game;
  });
}

function makeSessions(games: Game[]): Session[] {
  const out: Session[] = [];
  let id = 1;
  const playable = games.filter((g) => g.kind === "game");
  const weights = playable.map((_, i) => 1 / (1 + i * 0.35));
  const total = weights.reduce((a, b) => a + b, 0);
  for (let d = 120; d >= 0; d--) {
    const dayStart = new Date(now - d * DAY);
    dayStart.setHours(0, 0, 0, 0);
    const weekend = [0, 6].includes(dayStart.getDay());
    if (rand() < (weekend ? 0.18 : 0.38) && d > 1) continue;
    const count = 1 + Math.floor(rand() * (weekend ? 3 : 2));
    for (let k = 0; k < count; k++) {
      let r = rand() * total;
      let gi = 0;
      while (r > weights[gi] && gi < weights.length - 1) r -= weights[gi++];
      const hour = weekend ? 11 + Math.floor(rand() * 13) : 17 + Math.floor(rand() * 7);
      const start = dayStart.getTime() + hour * 3600000 + Math.floor(rand() * 3600000);
      const seconds = Math.floor((weekend ? 3600 : 1800) * (0.4 + rand() * 2.4));
      if (start + seconds * 1000 > now) continue;
      out.push({ id: id++, gameId: playable[gi].id, start, end: start + seconds * 1000, seconds });
    }
  }
  return out;
}

/** Ping-Verlauf einer Beispielsitzung */
function makeTimeline(start: number, seconds: number, base: number, noisy: boolean): PingSample[] {
  const n = Math.min(seconds, 1800);
  const out: PingSample[] = [];
  for (let i = 0; i < n; i++) {
    let rtt: number | null = base + (rand() - 0.5) * (noisy ? 14 : 4) + Math.sin(i / 40) * (noisy ? 6 : 2);
    if (noisy && rand() < 0.03) rtt = base * 2 + rand() * 80;
    if (noisy && rand() < 0.012) rtt = null;
    out.push({ targetId: "monitor", t: start + i * 1000, rtt: rtt === null ? null : Math.round(rtt * 10) / 10 });
  }
  return out;
}

function makeReports(games: Game[], sessions: Session[]): SessionReport[] {
  const targets = ["Frankfurt (AWS)", "Paris (AWS)", "Frankfurt (Valve)", "Stockholm (Valve)"];
  return sessions
    .filter((s) => s.seconds > 600)
    .slice(-28)
    .map((s, i) => {
      const game = games.find((g) => g.id === s.gameId)!;
      const base = 14 + rand() * 30;
      const noisy = rand() < 0.35;
      const samples = makeTimeline(s.start, s.seconds, base, noisy);
      const st = summarize("monitor", samples);
      return {
        id: `rep-${i}`,
        gameId: game.id,
        gameName: game.name,
        start: s.start,
        end: s.end,
        targetLabel: targets[i % targets.length],
        avgPing: st.avg,
        minPing: st.min,
        maxPing: st.max,
        jitter: st.jitter,
        loss: st.loss,
        spikes: countSpikes(samples.map((x) => x.rtt)),
        timeline: compressTimeline(samples.map((x) => [x.t, x.rtt] as [number, number | null])),
        boosted: i % 3 !== 1,
        grade: pingGrade(st.avg, st.jitter, st.loss) ?? "F",
      };
    });
}

interface MockDb {
  games: Game[];
  reports: SessionReport[];
  sessions: Session[];
  kv: Record<string, unknown>;
}

const STORE_KEY = "pulsar-mock-db-v1";

function freshDb(): MockDb {
  const games = makeGames();
  const sessions = makeSessions(games);
  return { games, sessions, reports: makeReports(games, sessions), kv: {} };
}

function loadDb(): MockDb {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw) as MockDb;
  } catch {
    /* Demo: neu erzeugen */
  }
  return freshDb();
}

const db: MockDb = typeof window !== "undefined" ? loadDb() : freshDb();
let saveTimer: number | undefined;
const persist = () => {
  if (typeof window === "undefined") return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
    } catch {
      /* Speicher voll – egal in der Demo */
    }
  }, 300);
};

const running = new Map<string, { startedAt: number }>();

function stats(): PlayStats[] {
  const map = new Map<string, PlayStats>();
  const sorted = [...db.sessions].sort((a, b) => a.start - b.start);
  for (const s of sorted) {
    const st = map.get(s.gameId) ?? { gameId: s.gameId, totalSeconds: 0, sessions: 0, lastPlayedAt: null, lastSessionSeconds: null, firstPlayedAt: null };
    st.totalSeconds += s.seconds;
    st.sessions += 1;
    st.lastPlayedAt = s.end;
    st.lastSessionSeconds = s.seconds;
    st.firstPlayedAt ??= s.start;
    map.set(s.gameId, st);
  }
  return [...map.values()];
}

function table(name: string): { id: string }[] {
  if (name === "games") return db.games;
  if (name === "reports") return db.reports;
  throw new Error(`Unbekannte Tabelle: ${name}`);
}

const fakeScan: ScannedEntry[] = [
  { name: "Cities: Skylines II", kind: "game", source: "steam", sourceId: "949230", launch: { type: "url", target: "steam://rungameid/949230" } },
  { name: "Apex Legends", kind: "game", source: "steam", sourceId: "1172470", launch: { type: "url", target: "steam://rungameid/1172470" } },
  { name: "Fortnite", kind: "game", source: "epic", sourceId: "Fortnite", launch: { type: "url", target: "com.epicgames.launcher://apps/Fortnite?action=launch" } },
  { name: "Elden Ring", kind: "game", source: "steam", sourceId: "1245620", launch: { type: "url", target: "steam://rungameid/1245620" } },
  { name: "Discord", kind: "app", source: "startmenu", launch: { type: "shell", target: "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Discord.lnk" } },
];

// ---------------------------------------------------------------------------------------------
// Netzwerk
// ---------------------------------------------------------------------------------------------

const tcp = (host: string): PingTarget => ({ id: host, label: host, host, port: 443, method: "tcp" });
const REGIONS: (Region & { base: number })[] = [
  { id: "aws-eu-central-1", name: "Frankfurt", country: "DE", area: "eu", provider: "AWS", target: tcp("dynamodb.eu-central-1.amazonaws.com"), base: 9 },
  { id: "aws-eu-west-3", name: "Paris", country: "FR", area: "eu", provider: "AWS", target: tcp("dynamodb.eu-west-3.amazonaws.com"), base: 16 },
  { id: "aws-eu-west-2", name: "London", country: "GB", area: "eu", provider: "AWS", target: tcp("dynamodb.eu-west-2.amazonaws.com"), base: 19 },
  { id: "aws-eu-north-1", name: "Stockholm", country: "SE", area: "eu", provider: "AWS", target: tcp("dynamodb.eu-north-1.amazonaws.com"), base: 27 },
  { id: "aws-eu-south-1", name: "Mailand", country: "IT", area: "eu", provider: "AWS", target: tcp("dynamodb.eu-south-1.amazonaws.com"), base: 21 },
  { id: "aws-eu-west-1", name: "Irland", country: "IE", area: "eu", provider: "AWS", target: tcp("dynamodb.eu-west-1.amazonaws.com"), base: 28 },
  { id: "aws-eu-south-2", name: "Spanien", country: "ES", area: "eu", provider: "AWS", target: tcp("dynamodb.eu-south-2.amazonaws.com"), base: 31 },
  { id: "aws-eu-central-2", name: "Zürich", country: "CH", area: "eu", provider: "AWS", target: tcp("dynamodb.eu-central-2.amazonaws.com"), base: 13 },
  { id: "aws-us-east-1", name: "US-Ost (Virginia)", country: "US", area: "na", provider: "AWS", target: tcp("dynamodb.us-east-1.amazonaws.com"), base: 92 },
  { id: "aws-us-east-2", name: "US-Ost (Ohio)", country: "US", area: "na", provider: "AWS", target: tcp("dynamodb.us-east-2.amazonaws.com"), base: 104 },
  { id: "aws-us-west-2", name: "US-West (Oregon)", country: "US", area: "na", provider: "AWS", target: tcp("dynamodb.us-west-2.amazonaws.com"), base: 152 },
  { id: "aws-ca-central-1", name: "Kanada", country: "CA", area: "na", provider: "AWS", target: tcp("dynamodb.ca-central-1.amazonaws.com"), base: 101 },
  { id: "aws-sa-east-1", name: "São Paulo", country: "BR", area: "sa", provider: "AWS", target: tcp("dynamodb.sa-east-1.amazonaws.com"), base: 206 },
  { id: "aws-ap-southeast-1", name: "Singapur", country: "SG", area: "asia", provider: "AWS", target: tcp("dynamodb.ap-southeast-1.amazonaws.com"), base: 168 },
  { id: "aws-ap-northeast-1", name: "Tokio", country: "JP", area: "asia", provider: "AWS", target: tcp("dynamodb.ap-northeast-1.amazonaws.com"), base: 232 },
  { id: "aws-ap-northeast-2", name: "Seoul", country: "KR", area: "asia", provider: "AWS", target: tcp("dynamodb.ap-northeast-2.amazonaws.com"), base: 244 },
  { id: "aws-ap-south-1", name: "Mumbai", country: "IN", area: "asia", provider: "AWS", target: tcp("dynamodb.ap-south-1.amazonaws.com"), base: 128 },
  { id: "aws-ap-southeast-2", name: "Sydney", country: "AU", area: "oce", provider: "AWS", target: tcp("dynamodb.ap-southeast-2.amazonaws.com"), base: 278 },
  { id: "aws-me-south-1", name: "Bahrain", country: "BH", area: "me", provider: "AWS", target: tcp("dynamodb.me-south-1.amazonaws.com"), base: 96 },
  { id: "aws-af-south-1", name: "Kapstadt", country: "ZA", area: "af", provider: "AWS", target: tcp("dynamodb.af-south-1.amazonaws.com"), base: 172 },
];
const GAME_SERVERS: Record<string, (Region & { base: number })[]> = {
  cs2: [
    { id: "valve-fra", name: "Frankfurt", country: "DE", area: "eu", provider: "Valve", target: { id: "valve-fra", label: "Frankfurt", host: "155.133.248.34", method: "icmp" }, base: 8 },
    { id: "valve-ams", name: "Amsterdam", country: "NL", area: "eu", provider: "Valve", target: { id: "valve-ams", label: "Amsterdam", host: "155.133.248.36", method: "icmp" }, base: 15 },
    { id: "valve-sto", name: "Stockholm", country: "SE", area: "eu", provider: "Valve", target: { id: "valve-sto", label: "Stockholm", host: "155.133.252.5", method: "icmp" }, base: 29 },
    { id: "valve-vie", name: "Wien", country: "AT", area: "eu", provider: "Valve", target: { id: "valve-vie", label: "Wien", host: "185.25.182.10", method: "icmp" }, base: 17 },
    { id: "valve-lhr", name: "London", country: "GB", area: "eu", provider: "Valve", target: { id: "valve-lhr", label: "London", host: "155.133.248.50", method: "icmp" }, base: 20 },
    { id: "valve-iad", name: "Virginia", country: "US", area: "na", provider: "Valve", target: { id: "valve-iad", label: "Virginia", host: "162.254.192.72", method: "icmp" }, base: 94 },
  ],
  lol: [
    { id: "riot-euw", name: "EUW", country: "DE", area: "eu", provider: "Riot", target: { id: "riot-euw", label: "EUW", host: "104.160.141.3", method: "icmp" }, base: 12 },
    { id: "riot-eune", name: "EUNE", country: "DE", area: "eu", provider: "Riot", target: { id: "riot-eune", label: "EUNE", host: "104.160.142.3", method: "icmp" }, base: 18 },
    { id: "riot-na", name: "NA", country: "US", area: "na", provider: "Riot", target: { id: "riot-na", label: "NA", host: "104.160.131.3", method: "icmp" }, base: 118 },
  ],
};
GAME_SERVERS.dota2 = GAME_SERVERS.cs2;
GAME_SERVERS.deadlock = GAME_SERVERS.cs2;

function baseFor(target: PingTarget): number {
  const r = [...REGIONS, ...Object.values(GAME_SERVERS).flat()].find((x) => x.target.id === target.id || x.target.host === target.host);
  return r?.base ?? 24;
}

/** Simulierte Messung mit leichtem Rauschen, gelegentlichen Spitzen und Verlust */
function sample(targetId: string, base: number): PingSample {
  let rtt: number | null = base + (rand() - 0.5) * 5 + Math.sin(Date.now() / 9000) * 2.5;
  if (rand() < 0.02) rtt = base * 2.4 + rand() * 60;
  if (rand() < 0.006) rtt = null;
  return { targetId, t: Date.now(), rtt: rtt === null ? null : Math.max(1, Math.round(rtt * 10) / 10) };
}

function pingOnce(target: PingTarget, count: number): PingStats {
  const base = baseFor(target);
  return summarize(target.id, Array.from({ length: count }, () => sample(target.id, base)));
}

let monitor: { timer: number; targets: PingTarget[]; history: Map<string, PingSample[]> } | null = null;
function stopMonitor() {
  if (monitor) window.clearInterval(monitor.timer);
  monitor = null;
}
function startMonitor(targets: PingTarget[], interval: number) {
  stopMonitor();
  const history = new Map<string, PingSample[]>();
  const tick = () => {
    const samples = targets.map((tg) => sample(tg.id, baseFor(tg)));
    const statsOut: PingStats[] = [];
    for (const s of samples) {
      const h = [...(history.get(s.targetId) ?? []), s].slice(-60);
      history.set(s.targetId, h);
      statsOut.push(summarize(s.targetId, h));
    }
    emit("net://ping", { samples, stats: statsOut } satisfies MonitorUpdate);
  };
  monitor = { timer: window.setInterval(tick, Math.max(250, interval)), targets, history };
  tick();
}

async function traceroute(host: string): Promise<TraceResult> {
  const hops: TraceHop[] = [
    { hop: 1, address: "192.168.178.1", hostname: "fritz.box", rtts: [0.6, 0.5, 0.7], zone: "lan" },
    { hop: 2, address: "100.64.12.1", hostname: null, rtts: [6.2, 5.9, 6.4], zone: "isp" },
    { hop: 3, address: "62.155.240.129", hostname: "f-ed10-i.F.DE.NET.DTAG.DE", rtts: [7.1, 7.4, 7.0], zone: "isp" },
    { hop: 4, address: "80.157.204.182", hostname: null, rtts: [8.3, 8.1, 8.9], zone: "internet" },
    { hop: 5, address: null, hostname: null, rtts: [null, null, null], zone: "internet" },
    { hop: 6, address: "52.93.35.126", hostname: null, rtts: [9.8, 10.4, 9.6], zone: "internet" },
    { hop: 7, address: "3.123.1.77", hostname: "dynamodb.eu-central-1.amazonaws.com", rtts: [10.1, 9.9, 10.6], zone: "target" },
  ];
  for (const h of hops) {
    await sleep(380);
    emit("net://trace", h);
  }
  return { target: host, address: "3.123.1.77", hops, reached: true };
}

async function dnsBenchmark(rounds: number): Promise<DnsResult[]> {
  const providers: [string, string, string, string | null, number, number][] = [
    ["cloudflare", "Cloudflare", "1.1.1.1", "1.0.0.1", 8, 19],
    ["google", "Google", "8.8.8.8", "8.8.4.4", 10, 24],
    ["quad9", "Quad9", "9.9.9.9", "149.112.112.112", 12, 31],
    ["opendns", "OpenDNS", "208.67.222.222", "208.67.220.220", 16, 38],
    ["adguard", "AdGuard", "94.140.14.14", "94.140.15.15", 14, 33],
    ["controld", "Control D", "76.76.2.0", "76.76.10.0", 11, 27],
    ["dnswatch", "DNS.WATCH", "84.200.69.80", "84.200.70.40", 15, 36],
    ["current", "Router (192.168.178.1)", "192.168.178.1", null, 4, 44],
  ];
  const out: DnsResult[] = [];
  for (let i = 0; i < providers.length; i++) {
    await sleep(260);
    const [id, name, primary, secondary, c, u] = providers[i];
    out.push({ id, name, primary, secondary, cachedMs: c + rand() * 3, uncachedMs: u + rand() * 8, failed: id === "dnswatch" ? 1 : 0, current: id === "current" });
    emit("net://dns", { done: i + 1, total: providers.length });
    void rounds;
  }
  return out.sort((a, b) => (a.uncachedMs ?? 999) - (b.uncachedMs ?? 999));
}

let speedCancel = false;
async function speedtest(): Promise<SpeedResult> {
  speedCancel = false;
  const prog = (p: SpeedProgress) => emit("net://speed", p);
  for (let i = 0; i < 10; i++) {
    await sleep(90);
    if (speedCancel) throw new Error("Der Speedtest wurde abgebrochen.");
    prog({ phase: "latency", progress: (i + 1) / 10, mbps: null, latencyMs: 9 + rand() * 2 });
  }
  const down = 412 + rand() * 60;
  for (let i = 0; i < 30; i++) {
    await sleep(140);
    if (speedCancel) throw new Error("Der Speedtest wurde abgebrochen.");
    prog({ phase: "download", progress: (i + 1) / 30, mbps: down * Math.min(1, (i + 3) / 12) * (0.9 + rand() * 0.15), latencyMs: 12 + i * 0.8 + rand() * 4 });
  }
  const up = 41 + rand() * 8;
  for (let i = 0; i < 22; i++) {
    await sleep(140);
    if (speedCancel) throw new Error("Der Speedtest wurde abgebrochen.");
    prog({ phase: "upload", progress: (i + 1) / 22, mbps: up * Math.min(1, (i + 3) / 8) * (0.9 + rand() * 0.15), latencyMs: 14 + i * 1.6 + rand() * 6 });
  }
  const idle = 9.6;
  const loadedDown = 31.5;
  const loadedUp = 44.2;
  const bloat = Math.max(loadedDown, loadedUp) - idle;
  const res: SpeedResult = { downloadMbps: down, uploadMbps: up, idleLatencyMs: idle, idleJitterMs: 1.1, loadedLatencyDownMs: loadedDown, loadedLatencyUpMs: loadedUp, bufferbloatMs: bloat, grade: bufferbloatGrade(bloat), server: "FRA", at: Date.now() };
  prog({ phase: "done", progress: 1, mbps: null, latencyMs: null });
  return res;
}

const adapters: AdapterInfo[] = [
  { id: "{3F2504E0-4F89-11D3-9A0C-0305E82C3301}", name: "Ethernet", description: "Intel(R) Ethernet Controller I225-V", kind: "ethernet", up: true, speedMbps: 2500, ipv4: ["192.168.178.42"], gateway: "192.168.178.1", dns: ["192.168.178.1"], primary: true },
  { id: "{8B5C7A10-2C3D-4E5F-9A0B-1C2D3E4F5A6B}", name: "WLAN", description: "Intel(R) Wi-Fi 6E AX211 160MHz", kind: "wifi", up: true, speedMbps: 1201, ipv4: ["192.168.178.57"], gateway: "192.168.178.1", dns: ["192.168.178.1"], primary: false },
];
const wifi: WifiInfo = { ssid: "FRITZ!Box 7590 XK", signal: 86, rssi: -51, band: "5", channel: 44, phy: "Wi-Fi 6 (802.11ax)", rxMbps: 1201, txMbps: 1201 };

// ---------------------------------------------------------------------------------------------
// Optimieren & Boost
// ---------------------------------------------------------------------------------------------

const tweakState: Record<string, "on" | "off"> = { powerPlan: "off", gameMode: "on", gameDvr: "off", mouseAccel: "off" };
const snapshots = new Set<string>();
function tweaks(): Tweak[] {
  const meta: Record<string, [Tweak["category"], Tweak["impact"]]> = { powerPlan: ["power", "medium"], gameMode: ["windows", "low"], gameDvr: ["windows", "medium"], mouseAccel: ["input", "medium"] };
  return Object.entries(meta).map(([id, [category, impact]]) => ({ id: id as Tweak["id"], category, impact, state: tweakState[id], detail: id === "powerPlan" ? (tweakState[id] === "on" ? "Höchstleistung" : "Ausbalanciert") : null, canRevert: snapshots.has(id) }));
}
let plans: PowerPlan[] = [
  { guid: "381b4222-f694-41f0-9685-ff5bb260df2e", name: "Ausbalanciert", active: true },
  { guid: "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c", name: "Höchstleistung", active: false },
  { guid: "a1841308-3541-4fab-bc81-f71556f20b4a", name: "Energiesparmodus", active: false },
];
let boost: BoostState = { active: false, since: null, gameId: null, actions: [] };

// ---------------------------------------------------------------------------------------------

export async function mockInvoke<T>(cmd: string, a: Record<string, unknown>): Promise<T> {
  await sleep(cmd === "scan_library" ? 1400 : cmd === "net_regions_ping" ? 900 : 25);
  const r = (v: unknown) => v as T;
  switch (cmd) {
    case "app_info":
      return r({ version: "1.0.0", dataDir: "C:\\Users\\Demo\\AppData\\Roaming\\com.pulsar.booster", cacheDir: "", platform: "windows", startedMinimized: false, isAdmin: false });
    case "quit_app":
      return r(undefined);
    case "db_list":
      return r(structuredClone(table(String(a.table))));
    case "db_put": {
      const tb = table(String(a.table));
      const i = tb.findIndex((x) => x.id === a.id);
      if (i >= 0) tb[i] = a.value as { id: string };
      else tb.push(a.value as { id: string });
      persist();
      return r(undefined);
    }
    case "db_put_many": {
      const tb = table(String(a.table));
      for (const it of a.items as { id: string; value: { id: string } }[]) {
        const i = tb.findIndex((x) => x.id === it.id);
        if (i >= 0) tb[i] = it.value;
        else tb.push(it.value);
      }
      persist();
      return r(undefined);
    }
    case "db_delete": {
      const name = String(a.table);
      if (name === "games") {
        db.games = db.games.filter((x) => x.id !== a.id);
        db.sessions = db.sessions.filter((s) => s.gameId !== a.id);
      } else if (name === "reports") db.reports = db.reports.filter((x) => x.id !== a.id);
      persist();
      return r(undefined);
    }
    case "kv_get":
      return r(db.kv[String(a.key)] ?? null);
    case "kv_set":
      db.kv[String(a.key)] = a.value;
      persist();
      return r(undefined);
    case "playtime_stats":
      return r(stats());
    case "sessions_range":
      return r(db.sessions.filter((s) => s.end >= Number(a.from) && s.start <= Number(a.to)));
    case "sessions_for_game":
      return r(db.sessions.filter((s) => s.gameId === a.gameId).sort((x, y) => y.start - x.start).slice(0, Number(a.limit ?? 50)));
    case "session_delete":
      db.sessions = db.sessions.filter((s) => s.id !== Number(a.id));
      persist();
      return r(undefined);
    case "scan_library": {
      const o = a.options as { steam: boolean; epic: boolean; gog: boolean; startMenu: boolean };
      return r({ entries: fakeScan.filter((e) => (e.source === "steam" && o.steam) || (e.source === "epic" && o.epic) || (e.source === "gog" && o.gog) || (e.source === "startmenu" && o.startMenu)), messages: o.gog ? ["GOG Galaxy wurde nicht gefunden."] : [] });
    }
    case "inspect_paths":
      return r(
        (a.paths as string[]).map((p) => {
          const name = p.split(/[\\/]/).pop()?.replace(/\.(exe|lnk|url)$/i, "") ?? "Neu";
          return { name, kind: "game", source: "manual", launch: { type: "exe", target: p }, exePath: p } satisfies ScannedEntry;
        }),
      );
    case "paths_exist":
      return r((a.paths as string[]).map((p) => !/satisfactory/i.test(p)));
    case "set_tracked_games":
      return r(undefined);
    case "launch_game": {
      const id = String(a.gameId);
      window.setTimeout(() => {
        running.set(id, { startedAt: Date.now() });
        emit("game://started", { gameId: id, startedAt: Date.now() });
      }, 2600);
      return r(undefined);
    }
    case "stop_game": {
      const id = String(a.gameId);
      const run = running.get(id);
      running.delete(id);
      if (run) {
        const end = Date.now();
        const seconds = Math.max(1, Math.round((end - run.startedAt) / 1000));
        const session: Session = { id: Date.now(), gameId: id, start: run.startedAt, end, seconds };
        db.sessions.push(session);
        persist();
        emit("game://stopped", { gameId: id, session });
      }
      return r(run ? 1 : 0);
    }
    case "running_games":
      return r([...running.entries()].map(([gameId, v]) => ({ gameId, startedAt: v.startedAt, pids: [4242] })));
    case "open_path":
    case "reveal_path":
    case "open_url":
      console.info("Demo:", cmd, a);
      return r(undefined);
    case "images_fetch": {
      const req = a.request as { name: string; kinds: ImageKind[] };
      const images = demoImages(req.name, "game", req.kinds);
      return Object.keys(images).length ? r({ images, source: "steam", messages: [] }) : r({ images: {}, source: "none", messages: ["Demo-Modus: für dieses Spiel gibt es keine Beispielbilder."] });
    }
    case "image_set_custom":
      return r({ path: "" });
    case "exe_icon":
      return r(null);
    case "cache_size":
      return r(48_300_000);
    case "cache_clear":
      return r(48_300_000);
    case "system_stats": {
      const t = Date.now() / 1000;
      return r({ cpu: 18 + 14 * Math.sin(t / 3) + rand() * 6, ramUsed: 11.2e9 + Math.sin(t / 7) * 0.6e9, ramTotal: 32e9, gpu: 32 + 20 * Math.sin(t / 4) + rand() * 5, cpuName: "AMD Ryzen 7 7800X3D", gpuName: "NVIDIA GeForce RTX 4070", uptimeSeconds: 12345 });
    }

    // Netzwerk
    case "net_ping_once":
      return r(pingOnce(a.target as PingTarget, Number(a.count ?? 4)));
    case "net_monitor_start":
      startMonitor(a.targets as PingTarget[], Number(a.intervalMs ?? 1000));
      return r(undefined);
    case "net_monitor_stop":
      stopMonitor();
      return r(undefined);
    case "net_regions":
      return r(REGIONS.map(({ base: _b, ...x }) => x));
    case "net_regions_ping": {
      const ids = (a.ids as string[] | undefined) ?? REGIONS.map((x) => x.id);
      return r(REGIONS.filter((x) => ids.includes(x.id)).map((x) => ({ id: x.id, stats: pingOnce(x.target, Number(a.count ?? 4)) }) satisfies RegionPing));
    }
    case "net_game_servers":
      return r((GAME_SERVERS[String(a.game)] ?? []).map(({ base: _b, ...x }) => x));
    case "net_traceroute":
      return r(await traceroute(String(a.host)));
    case "net_dns_benchmark":
      return r(await dnsBenchmark(Number(a.rounds ?? 5)));
    case "net_dns_current":
      return r({ adapterId: adapters[0].id, adapter: adapters[0].name, servers: adapters[0].dns, dhcp: true, changedByPulsar: false } satisfies DnsConfig);
    case "net_dns_apply":
    case "net_dns_restore":
      throw new Error("Pulsar ändert den DNS nicht selbst. Die Anleitung zeigt dir, wie es in den Windows-Einstellungen geht.");
    case "net_adapters":
      return r(adapters);
    case "net_wifi":
      return r(wifi);
    case "net_speedtest":
      return r(await speedtest());
    case "net_speedtest_cancel":
      speedCancel = true;
      return r(undefined);

    // Optimieren & Boost
    case "opt_tweaks":
      return r(tweaks());
    case "opt_apply": {
      const ids = a.ids as string[];
      for (const id of ids) {
        if (!(id in tweakState)) continue;
        if (a.enable) snapshots.add(id);
        else snapshots.delete(id);
        tweakState[id] = a.enable ? "on" : "off";
      }
      return r({ applied: ids.filter((i) => i in tweakState), failed: [] } satisfies ApplyReport);
    }
    case "opt_revert_all":
      for (const id of snapshots) tweakState[id] = "off";
      snapshots.clear();
      return r({ applied: [], failed: [] } satisfies ApplyReport);
    case "opt_power_plans":
      return r(plans);
    case "opt_power_set":
      plans = plans.map((p) => ({ ...p, active: p.guid === a.guid }));
      tweakState.powerPlan = plans.find((p) => p.active)?.name === "Höchstleistung" ? "on" : "off";
      return r(undefined);
    case "opt_flush_dns":
      return r(undefined);
    case "boost_start": {
      const profile = a.profile as BoostProfile;
      await sleep(700);
      boost = {
        active: true,
        since: Date.now(),
        gameId: (a.gameId as string | null) ?? null,
        actions: [
          { id: "powerPlan", ok: profile.powerPlan, detail: profile.powerPlan ? "Höchstleistung aktiv (vorher: Ausbalanciert)" : "Übersprungen" },
          { id: "priority", ok: true, detail: a.gameId ? `Priorität „${profile.gamePriority}“ gesetzt` : "Kein Spiel läuft – wird beim Start gesetzt" },
          { id: "flushDns", ok: profile.flushDns, detail: profile.flushDns ? "DNS-Zwischenspeicher geleert" : "Übersprungen" },
        ],
      };
      if (profile.powerPlan) {
        plans = plans.map((p) => ({ ...p, active: p.name === "Höchstleistung" }));
        tweakState.powerPlan = "on";
      }
      emit("boost://state", boost);
      return r(boost);
    }
    case "boost_stop":
      await sleep(400);
      boost = { active: false, since: null, gameId: null, actions: [] };
      plans = plans.map((p) => ({ ...p, active: p.name === "Ausbalanciert" }));
      tweakState.powerPlan = "off";
      emit("boost://state", boost);
      return r(boost);
    case "boost_state":
      return r(boost);

    // Sicherungen & Sonstiges
    case "backups_list":
      return r([
        { file: "pulsar-20261012-063321.db", path: "", createdAt: now - DAY, size: 1_200_000 },
        { file: "pulsar-20261011-063302.db", path: "", createdAt: now - 2 * DAY, size: 1_150_000 },
      ]);
    case "backup_now":
      return r({ file: "pulsar-neu.db", path: "", createdAt: Date.now(), size: 1_210_000 });
    case "backup_restore":
    case "apply_native_settings":
    case "tray_set_recent":
    case "update_install":
      return r(undefined);
    case "overlay_toggle":
      window.open("/overlay.html", "pulsar-overlay", "width=320,height=140");
      return r(true);
    case "update_check":
      return r({ available: false, current: "1.0.0", latest: "1.0.0", notes: null, setupUrl: null, setupSha256: null });
    default:
      throw new Error(`Demo: unbekannter Befehl „${cmd}“`);
  }
}
