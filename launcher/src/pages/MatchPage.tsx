import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { create } from "zustand";
import { toast } from "sonner";
import {
  ArrowUpFromLine,
  Bot,
  Box as BoxIcon,
  Crosshair,
  FastForward,
  Flag,
  Gift,
  Heart,
  ListChecks,
  MapPin,
  Package,
  Pause,
  Play,
  Plane,
  Plus,
  RotateCcw,
  Shield,
  Trash2,
  Undo2,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, PageShell, Reveal, SettingRow, ValueChip } from "@/components/common";
import { playlists } from "@/lib/demo-data";
import { api, inTauri, onEvent, type TrickshotPreset } from "@/lib/api";
import { activeProfile, useApp } from "@/lib/store";
import { parkourFile, parkours, kindLabel, levelWord, TILE_METERS, type Parkour } from "@/lib/parkours";
import { cn } from "@/lib/utils";

/*
 * Match-Steuerung. Jeder Knopf schickt genau einen echten Befehl an deinen Server
 * (über die Steuer-Pipe: „exec“ = Server-Befehl als erster Spieler, „config“ = Einstellung).
 */

// ---- Items zum Geben (Kurznamen aus native/server/Erbium/Private/Misc.cpp → ItemNames) ----------

const itemGroups: { label: string; items: { id: string; label: string }[] }[] = [
  {
    label: "Sniper",
    items: [
      { id: "heavy_sr", label: "Heavy Sniper" },
      { id: "bolt_sr", label: "Bolt-Sniper" },
      { id: "hunterbolt_sr", label: "Hunter-Bolt-Sniper" },
      { id: "reaper_sr", label: "Reaper-Sniper" },
    ],
  },
  {
    label: "Waffen",
    items: [
      { id: "pump_sr", label: "Pump-Shotgun" },
      { id: "tac", label: "Taktische Shotgun" },
      { id: "rocket", label: "Raketenwerfer" },
    ],
  },
  {
    label: "Fliegen & Springen",
    items: [
      { id: "grappler", label: "Enterhaken" },
      { id: "launchpad", label: "Startrampe" },
      { id: "bouncer", label: "Bouncer (Sprungfeld)" },
      { id: "crashpad", label: "Crash-Pad" },
    ],
  },
  {
    label: "Heilen",
    items: [{ id: "mini", label: "Kleiner Schildtrank" }],
  },
];

// ---- Zustand der Seite (bleibt beim Seitenwechsel erhalten, wird beim Server-Stopp zurückgesetzt) ---

interface MatchState {
  tab: string;
  /** Server meldet: Match ist gestartet (danach nimmt er keinen anderen Modus mehr an) */
  started: boolean;
  /** null = Wert aus dem aktiven Profil */
  playlist: string | null;
  lateGame: boolean | null;
  stormPaused: boolean;
  respawn: boolean;
  respawnTime: number;
  infiniteAmmo: boolean;
  infiniteMats: boolean;
  item: string;
  activeParkour: string | null;
  targetHp: number;
  targetDistance: number;
  detection: boolean;
  autoReload: boolean;
  noJumpFatigue: boolean;
  slowMotion: boolean;
  botCount: number;
  botHealth: number;
  botShield: number;
}

/**
 * Startwerte = Standardwerte des Servers (Configuration.h), damit Schalter und Server zusammenpassen.
 * Ausnahme Bot-Leben/-Schild (Server: 21/21): „Bots hinstellen“ schickt die angezeigten Werte immer mit.
 */
const matchDefaults: Omit<MatchState, "tab"> = {
  started: false,
  playlist: null,
  lateGame: null,
  stormPaused: false,
  respawn: false,
  respawnTime: 3,
  infiniteAmmo: true,
  infiniteMats: true,
  item: "heavy_sr",
  activeParkour: null,
  targetHp: 50,
  targetDistance: 30,
  detection: true,
  autoReload: false,
  noJumpFatigue: false,
  slowMotion: false,
  botCount: 5,
  botHealth: 100,
  botShield: 0,
};

const useMatch = create<MatchState>()(() => ({ tab: "spiel", ...matchDefaults }));
const setMatch = (patch: Partial<MatchState>) => useMatch.setState(patch);

// Server aus → beim nächsten Start gelten wieder die Standardwerte
useApp.subscribe((s, prev) => {
  if (prev.services.server !== "stopped" && s.services.server === "stopped") setMatch({ ...matchDefaults });
});

/** Zeitpunkt der letzten Modus-/Lategame-Änderung hier – kurz danach kann der Server-Stand noch veraltet sein. */
let lastModePick = 0;

// Der Server meldet alle 2 Sekunden seinen Stand (VanityControl.cpp, StatusJson). Modus und Lategame zeigen,
// was der Server wirklich benutzt – auch wenn er eine Auswahl abgelehnt hat.
onEvent<{ event: string; data?: { ready?: boolean; playlist?: string; lategame?: boolean } }>("server:event", ({ event, data }) => {
  if (event !== "status" || !data || useApp.getState().services.server === "stopped") return;
  const patch: Partial<MatchState> = { started: data.ready === true };
  if (Date.now() - lastModePick > 4000) {
    const id = data.playlist?.split(".").pop(); // „/Game/…/Playlist_DefaultSolo.Playlist_DefaultSolo“ → „Playlist_DefaultSolo“
    if (id && playlists.some((p) => p.id === id)) patch.playlist = id;
    if (typeof data.lategame === "boolean") patch.lateGame = data.lategame;
  }
  setMatch(patch);
});

// ---- Befehle schicken ------------------------------------------------------------------------

type Action = () => Promise<void>;

/**
 * Schickt einen Befehl. Gibt true zurück, wenn er an den Server geschickt wurde.
 * Ob er im Spiel geklappt hat (z. B. nicht in der Lobby), sieht man nur im Spiel –
 * darum sagen die Meldungen „geschickt“ und nie „fertig“.
 */
async function run(fn: Action, what: string, done?: string): Promise<boolean> {
  if (inTauri && useApp.getState().services.server === "stopped") {
    toast.warning("Noch kein Server", { description: "Starte zuerst „Host & Play“. Sobald du im Match bist, klappt das." });
    return false;
  }
  try {
    await fn();
    if (done) toast.success(done);
    return true;
  } catch (e) {
    const text = String(e);
    toast.error(`${what} hat nicht geklappt`, {
      description: text.includes("Kein Server verbunden") ? "Der Server ist noch nicht verbunden. Warte, bis er fertig geladen hat." : text,
    });
    return false;
  }
}

const exec = (text: string, what: string, done?: string) => run(() => api.serverExec(text), what, done);
const config = (key: string, value: unknown, what: string, done?: string) => run(() => api.serverConfig(key, value), what, done);

/** Meldung nach dem Schicken: „„Knopf“ geschickt – schau ins Spiel“. */
const sent = (label: string, look = "schau ins Spiel") => `„${label}“ geschickt – ${look}`;

/** Schalter: sofort umlegen, bei Fehler zurück. */
async function flip<K extends keyof MatchState>(key: K, value: MatchState[K], send: () => Promise<boolean>) {
  const before = useMatch.getState()[key];
  setMatch({ [key]: value } as Partial<MatchState>);
  if (!(await send())) setMatch({ [key]: before } as Partial<MatchState>);
}

// ---- Seite -------------------------------------------------------------------------------------

export function MatchPage() {
  const tab = useMatch((s) => s.tab);
  const serverStopped = useApp((s) => s.services.server === "stopped");

  return (
    <PageShell>
      <PageHeader
        title="Match-Steuerung"
        description="Jeder Knopf schickt einen Befehl an deinen Server. Die meisten klappen, sobald du im Match bist. „Du“ heißt hier: du an diesem PC. Bist du nicht im Match, gilt es für den ersten Mitspieler. Die Trickshot-Knöpfe gibt es auch im Spiel: F9 → „Trickshot“."
      />

      {inTauri && serverStopped && (
        <Reveal className="flex items-center gap-3 rounded-lg bg-warning/10 px-4 py-3 text-xs text-warning">
          <span className="rounded-md bg-warning/20 px-2 py-0.5 font-medium">Kein Server</span>
          <span className="text-muted-foreground">Starte zuerst „Host &amp; Play“. Dann klappt hier alles.</span>
        </Reveal>
      )}

      <Reveal>
        <Tabs value={tab} onValueChange={(v) => setMatch({ tab: v })} className="gap-6">
          <TabsList className="h-10 bg-white/[0.04] p-1">
            <TabsTrigger value="spiel" className="px-4"><Flag />Spiel</TabsTrigger>
            <TabsTrigger value="trickshot" className="px-4"><Crosshair />Trickshot</TabsTrigger>
            <TabsTrigger value="bots" className="px-4"><Bot />Bots</TabsTrigger>
          </TabsList>
          <TabsContent value="spiel"><GameTab /></TabsContent>
          <TabsContent value="trickshot"><TrickshotTab /></TabsContent>
          <TabsContent value="bots"><BotsTab /></TabsContent>
        </Tabs>
      </Reveal>
    </PageShell>
  );
}

// ---- Bausteine -------------------------------------------------------------------------------

function TabBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} className={cn("flex flex-col gap-6", className)}>
      {children}
    </motion.div>
  );
}

function Box({ title, description, icon: Icon, children, className }: { title: string; description: string; icon?: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <section className={cn("glass rounded-xl px-6 py-5", className)}>
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        {Icon && <Icon className="size-4 text-primary-text" />}
        {title}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      <div className="mt-4 flex flex-col divide-y divide-white/[0.05]">{children}</div>
    </section>
  );
}

/** Großer Knopf mit Erklärung darunter – man sieht vorher, was passiert. */
function ActionTile({ icon: Icon, label, hint, onClick, primary, active, disabled }: { icon: LucideIcon; label: string; hint: string; onClick: () => void; primary?: boolean; active?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl px-4 py-3.5 text-left transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60",
        primary ? "bg-primary text-primary-foreground hover:bg-primary/90 disabled:hover:bg-primary" : "glass hover:bg-white/[0.07] disabled:hover:bg-transparent",
        active && !primary && "ring-1 ring-primary/60",
      )}
    >
      <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg", primary ? "bg-white/15" : "bg-white/[0.06] text-primary-text")}>
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{label}</span>
        <span className={cn("mt-0.5 block text-xs", primary ? "text-primary-foreground/80" : "text-muted-foreground")}>{hint}</span>
      </span>
    </button>
  );
}

/** Kleiner Knopf mit einer Zeile Erklärung (für Kästen mit mehreren Knöpfen). */
function SmallAction({ icon: Icon, label, hint, onClick }: { icon: LucideIcon; label: string; hint: string; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <p className="min-w-0 text-xs text-muted-foreground">{hint}</p>
      <Button variant="secondary" size="sm" className="shrink-0" onClick={onClick}>
        <Icon />
        {label}
      </Button>
    </div>
  );
}

const fmtSeconds = (n: number) => `${n} s`;

// ---- Reiter „Spiel“ ------------------------------------------------------------------------------

function GameTab() {
  const m = useMatch();
  const profile = useApp((s) => activeProfile(s.config));
  const playlist = m.playlist ?? profile?.playlist ?? playlists[0].id;
  const lateGame = m.lateGame ?? profile?.lategame ?? false;
  const allItems = itemGroups.flatMap((g) => g.items);
  const itemName = allItems.find((i) => i.id === m.item)?.label ?? m.item;

  return (
    <TabBody>
      <div className="grid gap-3 sm:grid-cols-2">
        <ActionTile
          primary
          icon={Play}
          label={m.started ? "Match läuft" : "Match starten"}
          hint={m.started ? "Schon gestartet. Im Spiel auf „Spielen“ drücken." : "Der Server lädt die Karte. Danach im Spiel auf „Spielen“ drücken."}
          disabled={m.started}
          onClick={async () => {
            if (await run(() => api.serverStartMatch(), "Match starten", sent("Match starten"))) setMatch({ started: true });
          }}
        />
        <ActionTile icon={Plane} label="Bus starten" hint="Der Battle-Bus fliegt los. Bei älteren Versionen nach 10 Sekunden." onClick={() => exec("startaircraft", "Bus starten", sent("Bus starten"))} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Box
          title="Spielmodus"
          description={m.started ? "Das Match läuft schon. Den Modus stellst du vor dem nächsten Start ein." : "Nur vor „Match starten“ möglich."}
          icon={Flag}
        >
          <SettingRow label="Modus" hint="Solo, Duos, Squads, Arena und mehr" disabled={m.started}>
            <Select
              value={playlist}
              disabled={m.started}
              onValueChange={(v) => {
                lastModePick = Date.now();
                flip("playlist", v, () => config("playlist", v, "Modus"));
              }}
            >
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>{playlists.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
            </Select>
          </SettingRow>
          <SettingRow label="Lategame" hint="Start direkt in einer kleinen Zone, mit voller Ausrüstung" disabled={m.started}>
            <Switch
              checked={lateGame}
              disabled={m.started}
              onCheckedChange={(v) => {
                lastModePick = Date.now();
                flip("lateGame", v, () => config("bLateGame", v, "Lategame"));
              }}
            />
          </SettingRow>
        </Box>

        <Box title="Sturm" description="Wirkt sofort, für alle im Match." icon={Pause}>
          <SmallAction
            icon={m.stormPaused ? Play : Pause}
            label={m.stormPaused ? "Sturm weiterlaufen lassen" : "Sturm anhalten"}
            hint={m.stormPaused ? "Der Sturm steht gerade still." : "Der Sturm bleibt stehen, bis du ihn weiterlaufen lässt."}
            onClick={() => flip("stormPaused", !m.stormPaused, () => exec(m.stormPaused ? "resumesafezone" : "pausesafezone", "Sturm"))}
          />
          <SmallAction icon={FastForward} label="Nächste Zone sofort" hint="Die Zone springt sofort auf den nächsten Kreis." onClick={() => exec("skipsafezone", "Nächste Zone", sent("Nächste Zone sofort"))} />
        </Box>

        <Box title="Respawn" description="Nach dem Ausscheiden wieder einsteigen." icon={RotateCcw}>
          <SettingRow label="Respawn an" hint="Du kommst nach der Wartezeit zurück ins Match">
            <Switch checked={m.respawn} onCheckedChange={(v) => flip("respawn", v, () => config("bForceRespawns", v, "Respawn"))} />
          </SettingRow>
          <SettingRow label="Wartezeit" hint="So viele Sekunden bis zum Zurückkommen" disabled={!m.respawn}>
            <Slider
              className="w-36"
              min={1}
              max={10}
              step={1}
              value={[m.respawnTime]}
              disabled={!m.respawn}
              onValueChange={([v]) => setMatch({ respawnTime: v })}
              onValueCommit={([v]) => config("RespawnTime", v, "Wartezeit")}
            />
            <ValueChip>{fmtSeconds(m.respawnTime)}</ValueChip>
          </SettingRow>
        </Box>

        <Box title="Unendlich" description="Gilt für alle im Match." icon={Package}>
          <SettingRow label="Unendlich Munition" hint="Die Munition geht nie aus">
            <Switch checked={m.infiniteAmmo} onCheckedChange={(v) => flip("infiniteAmmo", v, () => config("bInfiniteAmmo", v, "Unendlich Munition"))} />
          </SettingRow>
          <SettingRow label="Unendlich Material" hint="Holz, Stein und Metall gehen nie aus">
            <Switch checked={m.infiniteMats} onCheckedChange={(v) => flip("infiniteMats", v, () => config("bInfiniteMats", v, "Unendlich Material"))} />
          </SettingRow>
        </Box>

        <Box title="Items geben" description="Das Item landet direkt im Inventar. Nicht jede Fortnite-Version hat jedes Item." icon={Gift} className="lg:col-span-2">
          <SettingRow label="Item" hint="Wähl aus, was du haben willst">
            <Select value={m.item} onValueChange={(v) => setMatch({ item: v })}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                {itemGroups.map((g) => (
                  <SelectGroup key={g.label}>
                    <SelectLabel>{g.label}</SelectLabel>
                    {g.items.map((i) => <SelectItem key={i.id} value={i.id}>{i.label}</SelectItem>)}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow label="Geben" hint="„Mir geben“ = nur du. „Allen geben“ = jeder Spieler im Match">
            <Button size="sm" onClick={() => exec(`give ${m.item}`, "Item geben", `„${itemName}“ geschickt – schau ins Inventar`)}><Gift />Mir geben</Button>
            <Button size="sm" variant="secondary" onClick={() => exec(`givetoall ${m.item}`, "Allen geben", `„${itemName}“ an alle geschickt – schau ins Spiel`)}><Users />Allen geben</Button>
          </SettingRow>
        </Box>
      </div>
    </TabBody>
  );
}

// ---- Reiter „Trickshot“ --------------------------------------------------------------------------

function TrickshotTab() {
  const m = useMatch();

  const load = async (p: Parkour) => {
    if (await exec(`parkour ${p.id}`, `„${p.name}“ laden`, sent(p.name))) setMatch({ activeParkour: p.id });
  };

  return (
    <TabBody>
      <div className="grid gap-3 md:grid-cols-3">
        <ActionTile icon={RotateCcw} label="Nochmal von vorne" hint="Zurück an den Start. Leben voll, Waffen geladen, Ziel-Bots wieder da." onClick={() => exec("parkour retry", "Nochmal von vorne", sent("Nochmal von vorne"))} />
        <ActionTile icon={Trash2} label="Alles wegräumen" hint="Entfernt alle Parkour-Teile und Ziel-Bots." onClick={async () => { if (await exec("parkour clear", "Alles wegräumen", sent("Alles wegräumen"))) setMatch({ activeParkour: null }); }} />
        <ActionTile icon={Crosshair} label="Sniper geben" hint="Legt dir eine Sniper ins Inventar." onClick={() => exec("parkour sniper", "Sniper geben", sent("Sniper geben", "schau ins Inventar"))} />
      </div>

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Parkour laden</h2>
            <p className="mt-1 text-xs text-muted-foreground">Wähl eine Strecke. Sie wird um dich herum aufgebaut, du landest am Start und bekommst eine Sniper.</p>
          </div>
          <MapLegend />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {parkours.map((p) => <ParkourCard key={p.id} parkour={p} active={m.activeParkour === p.id} onLoad={() => load(p)} />)}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Box title="Ziel-Bot" description="Ein Bot, der still vor dir steht – perfekt zum Zielen." icon={Crosshair}>
          <SettingRow label="Leben" hint="So viel Leben hat der Bot (kein Schild)">
            <Slider className="w-36" min={1} max={200} step={1} value={[m.targetHp]} onValueChange={([v]) => setMatch({ targetHp: v })} />
            <ValueChip>{m.targetHp}</ValueChip>
          </SettingRow>
          <SettingRow label="Abstand" hint="So weit vor dir steht er, auf deiner Höhe">
            <Slider className="w-36" min={5} max={100} step={5} value={[m.targetDistance]} onValueChange={([v]) => setMatch({ targetDistance: v })} />
            <ValueChip>{m.targetDistance} m</ValueChip>
          </SettingRow>
          <div className="flex flex-wrap gap-2 pt-4">
            <Button onClick={() => exec(`targetbot ${m.targetHp} ${m.targetDistance}`, "Bot hinstellen", sent("Bot hinstellen"))}><Crosshair />Bot hinstellen</Button>
            <Button variant="secondary" onClick={() => exec("delbot", "Alle Bots weg", sent("Alle Bots weg"))}><Trash2 />Alle Bots weg</Button>
          </div>
        </Box>

        <Box title="Trickshot-Anzeige" description="Erledigst du jemanden, während du in der Luft bist, sehen alle ein großes Banner mit Name und Entfernung." icon={Zap}>
          <SettingRow label="Anzeige an" hint="Gilt für alle im Match">
            <Switch checked={m.detection} onCheckedChange={(v) => flip("detection", v, () => config("bTrickshotDetection", v, "Trickshot-Anzeige"))} />
          </SettingRow>
          <AnimatePresence initial={false}>
            {m.detection && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="pt-4">
                  <p className="mb-2 text-xs text-muted-foreground">So sieht das Banner im Spiel aus:</p>
                  <TrickshotBannerPreview />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </Box>

        <Box title="Üben" description="Hilft beim Trainieren. Wirkt sofort." icon={Heart}>
          <SettingRow label="Zeitlupe" hint="Das ganze Match läuft halb so schnell – für alle">
            <Switch checked={m.slowMotion} onCheckedChange={(v) => flip("slowMotion", v, () => exec(v ? "demospeed 0.5" : "demospeed 1", "Zeitlupe"))} />
          </SettingRow>
          <SettingRow label="Schwerkraft" hint="„Wenig“: du springst höher und fällst langsamer. Nur für dich. Nach dem Sterben ist sie wieder normal">
            <Button size="sm" variant="secondary" onClick={() => exec("gravity 0.4", "Wenig Schwerkraft", sent("Wenig Schwerkraft"))}>Wenig</Button>
            <Button size="sm" variant="secondary" onClick={() => exec("gravity 1", "Normale Schwerkraft", sent("Normale Schwerkraft"))}>Normal</Button>
          </SettingRow>
          <SettingRow label="Unverwundbar an/aus" hint="Einmal klicken: kein Schaden. Nochmal klicken: wieder normal">
            <Button size="sm" variant="secondary" onClick={() => exec("god", "Unverwundbar", sent("Unverwundbar an/aus"))}><Shield />Umschalten</Button>
          </SettingRow>
          <SettingRow label="Keine Sprung-Müdigkeit" hint="Springen, so oft du willst – ohne langsamer zu werden">
            <Switch checked={m.noJumpFatigue} onCheckedChange={(v) => flip("noJumpFatigue", v, () => config("bDisableJumpFatigue", v, "Sprung-Müdigkeit"))} />
          </SettingRow>
          <SettingRow label="Auto-Nachladen beim Zurückspringen" hint="Nach „Zurück zur Position“ sind deine Waffen sofort voll">
            <Switch checked={m.autoReload} onCheckedChange={(v) => flip("autoReload", v, () => config("bAutoReloadOnWaypointTP", v, "Auto-Nachladen"))} />
          </SettingRow>
        </Box>

        <Box title="Position & Ausrüstung" description="Stelle merken, zurückspringen, auffüllen." icon={MapPin}>
          <SmallAction icon={MapPin} label="Position merken" hint="Merkt sich, wo du gerade stehst." onClick={() => exec("s vanity o", "Position merken", sent("Position merken"))} />
          <SmallAction icon={Undo2} label="Zurück zur Position" hint="Bringt dich sofort zur gemerkten Stelle." onClick={() => exec("w vanity", "Zurück zur Position", sent("Zurück zur Position"))} />
          <SmallAction icon={ArrowUpFromLine} label="Hochschießen" hint="Schießt dich senkrecht in die Luft." onClick={() => exec("l 2500", "Hochschießen", sent("Hochschießen"))} />
          <SmallAction icon={BoxIcon} label="Sprungpads geben" hint="Je 6 Sprungpads, Bouncer und andere Fallen." onClick={() => exec("givetraps", "Sprungpads geben", sent("Sprungpads geben", "schau ins Inventar"))} />
          <SmallAction icon={Package} label="Munition auffüllen" hint="Füllt deine Munition auf." onClick={() => exec("giveammo", "Munition auffüllen", sent("Munition auffüllen"))} />
          <SmallAction icon={Heart} label="Leben auffüllen" hint="Leben und Schild wieder voll." onClick={() => exec("regen", "Leben auffüllen", sent("Leben auffüllen"))} />
        </Box>

        <PresetsBox />
      </div>
    </TabBody>
  );
}

/** Eigene Presets (angelegt unter „Ingame-Menü“): ein Klick schickt alle Befehle der Reihe nach. */
function PresetsBox() {
  const presets = useApp((s) => s.config.trickshotPresets);
  const setPage = useApp((s) => s.setPage);

  const runPreset = async (preset: TrickshotPreset) => {
    const commands = preset.commands.map((c) => c.trim().replace(/^\//, "").replace(/^cheat\s+/i, "").trim()).filter(Boolean);
    for (const [i, command] of commands.entries()) {
      const last = i === commands.length - 1;
      if (!(await exec(command, `„${preset.name}“`, last ? sent(preset.name) : undefined))) return;
    }
  };

  return (
    <Box title="Deine Presets" description="Ein Klick schickt alle Befehle eines Presets nacheinander an den Server." icon={ListChecks} className="lg:col-span-2">
      {presets.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Noch keine Presets. Du legst sie auf der Seite „Ingame-Menü“ an.</p>
          <Button variant="secondary" size="sm" onClick={() => setPage("ingame")}><Plus />Preset anlegen</Button>
        </div>
      ) : (
        presets.map((preset, i) => (
          <div key={`${preset.name}-${i}`} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{preset.name}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{preset.commands.join(" ; ")}</p>
            </div>
            <Button size="sm" className="shrink-0" onClick={() => runPreset(preset)}><Play className="fill-current" />Ausführen</Button>
          </div>
        ))
      )}
    </Box>
  );
}

function TrickshotBannerPreview() {
  return (
    <div className="relative overflow-hidden rounded-lg bg-[linear-gradient(180deg,#5f8fd6_0%,#9db9e6_55%,#5e7f4a_56%,#3f5a33_100%)] px-6 py-7">
      <div className="absolute inset-0 bg-black/25" />
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 300, damping: 18, delay: 0.1 }}
        className="relative mx-auto w-fit rounded-xl bg-[#0f1115]/80 px-7 py-3 text-center shadow-2xl ring-1 ring-primary/50 backdrop-blur"
      >
        <p className="text-xl font-bold tracking-[0.18em] text-primary-text">TRICKSHOT!</p>
        <p className="mt-0.5 text-sm font-medium">georg – 128 m</p>
      </motion.div>
    </div>
  );
}

// ---- Parkour-Karten mit Mini-Karte -----------------------------------------------------------------

function LevelDots({ level }: { level: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground" aria-label={`Stufe ${level} von 3 (${levelWord(level)})`}>
      <span className="flex gap-1">
        {[1, 2, 3].map((n) => <span key={n} className={cn("size-1.5 rounded-full", n <= level ? "bg-primary-text" : "bg-white/15")} />)}
      </span>
      {levelWord(level)}
    </span>
  );
}

function ParkourCard({ parkour: p, active, onLoad }: { parkour: Parkour; active: boolean; onLoad: () => void }) {
  const bots = p.bots.length;
  const parts = p.elements.length;
  return (
    <div className={cn("glass flex flex-col rounded-xl p-4 transition-shadow", active && "ring-1 ring-primary/70")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{p.name}</h3>
          <div className="mt-1"><LevelDots level={p.level} /></div>
        </div>
        {active && <span className="shrink-0 rounded-md bg-primary/20 px-2 py-0.5 text-[11px] font-medium text-primary-text">Zuletzt geschickt</span>}
      </div>
      <p className="mt-2 line-clamp-2 min-h-8 text-xs text-muted-foreground">{p.description}</p>
      <ParkourMap parkour={p} className="mt-3" />
      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-md bg-white/[0.05] px-2 py-0.5">{p.height > 0 ? `${p.height} m hoch` : "am Boden"}</span>
        <span className="rounded-md bg-white/[0.05] px-2 py-0.5">{parts} {parts === 1 ? "Sprung-Teil" : "Sprung-Teile"}</span>
        <span className="rounded-md bg-white/[0.05] px-2 py-0.5">{bots} {bots === 1 ? "Ziel-Bot" : "Ziel-Bots"}</span>
      </div>
      <Button className="mt-4 w-full" onClick={onLoad}>
        <Play className="fill-current" />
        {active ? "Nochmal laden" : "Laden"}
      </Button>
    </div>
  );
}

// Mini-Karte von oben: du startest links und schaust nach rechts (= vorne). Unten = rechts von dir.
const MAP_W = 260;
const MAP_H = 112;
const MAP_PAD = 14;

function KindIcon({ kind, x, y }: { kind: string; x: number; y: number }) {
  const c = "var(--primary-text)";
  switch (kind) {
    case "trampoline":
      return (
        <g>
          <circle cx={x} cy={y} r={5.2} fill="none" stroke={c} strokeWidth={1.6} />
          <circle cx={x} cy={y} r={1.7} fill={c} />
        </g>
      );
    case "launcher":
      return <path d={`M ${x} ${y - 6} L ${x + 5.5} ${y + 4} L ${x - 5.5} ${y + 4} Z`} fill={c} />;
    case "sideLauncher":
      return <path d={`M ${x - 5} ${y - 5} L ${x} ${y} L ${x - 5} ${y + 5} M ${x} ${y - 5} L ${x + 5} ${y} L ${x} ${y + 5}`} fill="none" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />;
    default:
      return <path d={`M ${x} ${y - 5} L ${x + 5} ${y} L ${x} ${y + 5} L ${x - 5} ${y} Z`} fill={c} />;
  }
}

function ParkourMap({ parkour: p, className }: { parkour: Parkour; className?: string }) {
  // Welt: f = vorne (→ x), r = rechts (→ y nach unten). Platten [breite (rechts), tiefe (vorne)].
  type Rect = { f: number; r: number; w: number; d: number };
  const rects: { rect: Rect; start?: boolean }[] = [];
  const addTiles = (f: number, r: number, tiles: [number, number] | undefined, start?: boolean) => {
    if (!tiles || tiles[0] <= 0 || tiles[1] <= 0) return;
    rects.push({ rect: { f, r, w: tiles[0] * TILE_METERS, d: tiles[1] * TILE_METERS }, start });
  };
  addTiles(0, 0, p.platform, true);
  p.elements.forEach((e) => addTiles(e.at[0], e.at[1], e.platform));
  p.bots.forEach((b) => addTiles(b.at[0], b.at[1], b.platform ?? [1, 1]));

  let minF = 0, maxF = 0, minR = 0, maxR = 0;
  const grow = (f: number, r: number) => {
    minF = Math.min(minF, f); maxF = Math.max(maxF, f);
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
  };
  rects.forEach(({ rect }) => { grow(rect.f - rect.d / 2, rect.r - rect.w / 2); grow(rect.f + rect.d / 2, rect.r + rect.w / 2); });
  [...p.elements, ...p.bots].forEach((o) => grow(o.at[0], o.at[1]));

  // Mindestgröße, damit kurze Strecken nicht riesig wirken
  const padSpan = (lo: number, hi: number, min: number): [number, number] => {
    const span = hi - lo;
    if (span >= min) return [lo, hi];
    const extra = (min - span) / 2;
    return [lo - extra, hi + extra];
  };
  [minF, maxF] = padSpan(minF, maxF, 40);
  [minR, maxR] = padSpan(minR, maxR, 18);
  const scale = Math.min((MAP_W - 2 * MAP_PAD) / (maxF - minF), (MAP_H - 2 * MAP_PAD) / (maxR - minR));
  const offX = MAP_PAD + ((MAP_W - 2 * MAP_PAD) - (maxF - minF) * scale) / 2;
  const offY = MAP_PAD + ((MAP_H - 2 * MAP_PAD) - (maxR - minR) * scale) / 2;
  const X = (f: number) => offX + (f - minF) * scale;
  const Y = (r: number) => offY + (r - minR) * scale;

  const route = [[0, 0], ...p.elements.map((e) => [e.at[0], e.at[1]])].map(([f, r]) => `${X(f).toFixed(1)},${Y(r).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className={cn("block h-32 w-full rounded-lg bg-black/25", className)} role="img" aria-label={`Karte von oben: ${p.elements.map((e) => kindLabel(e.kind)).join(", ")}; ${p.bots.length} Ziel-Bots`}>
      {rects.map(({ rect, start }, i) => {
        const w = Math.max(rect.d * scale, 5);
        const h = Math.max(rect.w * scale, 5);
        return (
          <rect
            key={i}
            x={X(rect.f) - w / 2}
            y={Y(rect.r) - h / 2}
            width={w}
            height={h}
            rx={2}
            fill={start ? "rgb(116 87 245 / 0.18)" : "rgb(255 255 255 / 0.06)"}
            stroke={start ? "rgb(167 139 250 / 0.55)" : "rgb(255 255 255 / 0.14)"}
            strokeWidth={1}
          />
        );
      })}
      {p.elements.length > 0 && <polyline points={route} fill="none" stroke="var(--primary-text)" strokeOpacity={0.35} strokeWidth={1.2} strokeDasharray="3 3" />}
      {p.elements.map((e, i) => <KindIcon key={i} kind={e.kind} x={X(e.at[0])} y={Y(e.at[1])} />)}
      {p.bots.map((b, i) => {
        const x = X(b.at[0]);
        const y = Y(b.at[1]);
        const up = Math.round(b.at[2]);
        // Beschriftung im Bild halten (nicht über den Rand schreiben)
        const labelX = Math.min(Math.max(x, 26), MAP_W - 26);
        const labelY = y - 9 < 9 ? y + 15 : y - 9;
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={6.5} fill="var(--destructive)" fillOpacity={0.18} />
            <circle cx={x} cy={y} r={3.6} fill="var(--destructive)" />
            {Math.abs(up) >= 3 && (
              <text x={labelX} y={labelY} textAnchor="middle" fontSize={8} fill="rgb(232 234 240 / 0.7)">
                {up > 0 ? `${up} m höher` : `${-up} m tiefer`}
              </text>
            )}
          </g>
        );
      })}
      {/* du am Start, Blick nach vorne (rechts) */}
      <circle cx={X(0)} cy={Y(0)} r={3.6} fill="#ffffff" />
      <path d={`M ${X(0) + 5.5} ${Y(0) - 3.2} L ${X(0) + 9.5} ${Y(0)} L ${X(0) + 5.5} ${Y(0) + 3.2} Z`} fill="#ffffff" fillOpacity={0.8} />
    </svg>
  );
}

function MapLegend() {
  const kinds = Object.keys(parkourFile.kinds);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <svg viewBox="0 0 20 12" className="h-3 w-5"><circle cx={5} cy={6} r={3.4} fill="#fff" /><path d="M 10 3 L 14 6 L 10 9 Z" fill="#fff" fillOpacity={0.8} /></svg>
        Du (Blick nach rechts)
      </span>
      {kinds.map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <svg viewBox="0 0 14 14" className="size-3.5"><KindIcon kind={k} x={7} y={7.5} /></svg>
          {kindLabel(k)}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <svg viewBox="0 0 14 14" className="size-3.5"><circle cx={7} cy={7} r={3.6} fill="var(--destructive)" /></svg>
        Ziel-Bot
      </span>
    </div>
  );
}

// ---- Reiter „Bots“ -------------------------------------------------------------------------------

function BotsTab() {
  const m = useMatch();

  const place = async () => {
    // Werte zuerst schicken, damit die neuen Bots sie sicher bekommen
    if (!(await config("BotHealth", m.botHealth, "Bot-Leben"))) return;
    if (!(await config("BotShield", m.botShield, "Bot-Schild"))) return;
    await exec(`bot ${m.botCount}`, "Bots hinstellen", sent("Bots hinstellen"));
  };

  return (
    <TabBody>
      <div className="flex items-start gap-3 rounded-lg bg-white/[0.03] px-4 py-3 text-xs text-muted-foreground">
        <Bot className="mt-0.5 size-4 shrink-0 text-primary-text" />
        <p>
          Ehrlich gesagt: Diese Bots <span className="font-medium text-foreground">stehen still</span> – sie laufen, bauen und schießen nicht. Sie sind Ziel-Bots zum Üben.
          Einen einzelnen Bot in fester Entfernung stellst du im Reiter „Trickshot“ hin.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Box title="Bots hinstellen" description="Die Bots erscheinen da, wo du stehst." icon={Bot}>
          <SettingRow label="Anzahl" hint="Wie viele Bots auf einmal">
            <Slider className="w-36" min={1} max={20} step={1} value={[m.botCount]} onValueChange={([v]) => setMatch({ botCount: v })} />
            <ValueChip>{m.botCount}</ValueChip>
          </SettingRow>
          <div className="flex flex-wrap gap-2 pt-4">
            <Button onClick={place}><Bot />Bots hinstellen</Button>
            <Button variant="secondary" onClick={() => exec("tpbot", "Zu mir holen", sent("Zu mir holen"))}><Users />Zu mir holen</Button>
            <Button variant="secondary" onClick={() => exec("delbot", "Alle weg", sent("Alle weg"))}><Trash2 />Alle weg</Button>
          </div>
        </Box>

        <Box title="Bot-Werte" description="Gilt für Bots, die du hier ab jetzt hinstellst. Ziel-Bots aus „Trickshot“ haben eigene Leben." icon={Heart}>
          <SettingRow label="Leben" hint="100 ist normal">
            <Slider className="w-36" min={1} max={100} step={1} value={[m.botHealth]} onValueChange={([v]) => setMatch({ botHealth: v })} onValueCommit={([v]) => config("BotHealth", v, "Bot-Leben")} />
            <ValueChip>{m.botHealth}</ValueChip>
          </SettingRow>
          <SettingRow label="Schild" hint="0 = kein Schild, 100 = voll">
            <Slider className="w-36" min={0} max={100} step={5} value={[m.botShield]} onValueChange={([v]) => setMatch({ botShield: v })} onValueCommit={([v]) => config("BotShield", v, "Bot-Schild")} />
            <ValueChip>{m.botShield}</ValueChip>
          </SettingRow>
        </Box>
      </div>
    </TabBody>
  );
}
