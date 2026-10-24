import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bot, Crosshair, Flag, Gift, Plane, Play, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PageHeader, PageShell, Reveal, SettingRow, ValueChip } from "@/components/common";
import { playlists } from "@/lib/demo-data";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";

/** Items, die der Server per „giveitem“ geben kann (Kurzname → Anzeige). */
const items = [
  { id: "pump", label: "Pump-Shotgun" },
  { id: "ar", label: "Sturmgewehr" },
  { id: "sniper", label: "Scharfschützengewehr" },
  { id: "smg", label: "Maschinenpistole" },
  { id: "shield", label: "Schildtrank" },
  { id: "medkit", label: "Medikit" },
];

export function MatchPage() {
  const serverRunning = useApp((s) => s.services.server === "running");

  const send = async (fn: () => Promise<void>, label: string) => {
    try {
      await fn();
    } catch (e) {
      toast.error(`${label} ging nicht`, { description: String(e) });
    }
  };

  return (
    <PageShell>
      <PageHeader
        title="Match-Steuerung"
        description="Alles, was du als Host auf deinem Server einstellen kannst. Dieselben Knöpfe gibt es auch im Ingame-Menü (F9)."
        actions={<>
          <Button variant="secondary" onClick={() => send(() => api.serverExec("startaircraft"), "Bus starten")} disabled={!serverRunning}><Plane />Bus starten</Button>
          <Button onClick={() => send(() => api.serverStartMatch(), "Match starten")} disabled={!serverRunning}><Play className="fill-current" />Match starten</Button>
        </>}
      />

      {!serverRunning && (
        <Reveal className="flex items-center gap-3 rounded-lg bg-warning/10 px-4 py-3 text-xs text-warning">
          <span className="rounded-md bg-warning/20 px-2 py-0.5 font-medium">Kein Server</span>
          <span className="text-muted-foreground">Starte zuerst über „Host &amp; Play“ (oder „Nur hosten“). Die Regler kannst du schon einstellen – sie wirken, sobald der Server läuft.</span>
        </Reveal>
      )}

      <Reveal>
        <Tabs defaultValue="match" className="gap-6">
          <TabsList className="h-10 bg-white/[0.04] p-1">
            <TabsTrigger value="match" className="px-4"><Flag />Match</TabsTrigger>
            <TabsTrigger value="bots" className="px-4"><Bot />Bots</TabsTrigger>
            <TabsTrigger value="trickshot" className="px-4"><Crosshair />Trickshot</TabsTrigger>
          </TabsList>
          <TabsContent value="match"><MatchTab send={send} /></TabsContent>
          <TabsContent value="bots"><BotsTab send={send} /></TabsContent>
          <TabsContent value="trickshot"><TrickshotTab send={send} /></TabsContent>
        </Tabs>
      </Reveal>
    </PageShell>
  );
}

type Send = (fn: () => Promise<void>, label: string) => Promise<void>;

function TabBody({ children }: { children: React.ReactNode }) {
  return <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} className="grid gap-6 lg:grid-cols-2">{children}</motion.div>;
}
function Box({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="glass rounded-xl px-6 py-5"><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 text-xs text-muted-foreground">{description}</p><div className="mt-4 flex flex-col divide-y divide-white/[0.05]">{children}</div></section>;
}

function MatchTab({ send }: { send: Send }) {
  const [playlist, setPlaylist] = useState(playlists[0].id);
  const [storm, setStorm] = useState(true);
  const [stormSpeed, setStormSpeed] = useState(1);
  const [respawn, setRespawn] = useState(false);
  const [item, setItem] = useState(items[0].id);
  const [target, setTarget] = useState("me");

  return (
    <TabBody>
      <Box title="Spielmodus" description="Gilt für das nächste Match.">
        <SettingRow label="Playlist" hint="Solo, Duos, Squads, Team Rumble oder Arena">
          <Select value={playlist} onValueChange={(v) => { setPlaylist(v); send(() => api.serverConfig("playlist", v), "Playlist"); }}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>{playlists.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label="Lategame" hint="Startet direkt in einer späten Zone mit voller Ausrüstung">
          <Switch onCheckedChange={(v) => send(() => api.serverConfig("bLateGame", v), "Lategame")} />
        </SettingRow>
      </Box>

      <Box title="Sturm" description="Ändert sich sofort, auch während des Matches.">
        <SettingRow label="Sturm aktiv" hint="Aus = der Sturm bleibt stehen und macht keinen Schaden">
          <Switch checked={storm} onCheckedChange={(v) => { setStorm(v); send(() => api.serverExec(v ? "resumesafezone" : "pausesafezone"), "Sturm"); }} />
        </SettingRow>
        <SettingRow label="Sturm-Tempo" hint="1,0× ist normal. Kleiner = langsamer" disabled={!storm}>
          <Slider className="w-40" min={0.25} max={3} step={0.25} value={[stormSpeed]} onValueChange={([v]) => setStormSpeed(v)} onValueCommit={([v]) => send(() => api.serverExec(`demospeed ${v}`), "Tempo")} disabled={!storm} />
          <ValueChip>{stormSpeed.toFixed(2).replace(".", ",")}×</ValueChip>
        </SettingRow>
      </Box>

      <Box title="Respawn" description="Nach einer Eliminierung wieder einsteigen.">
        <SettingRow label="Respawn an" hint="Spieler kommen nach der Wartezeit in der Luft zurück">
          <Switch checked={respawn} onCheckedChange={(v) => { setRespawn(v); send(() => api.serverConfig("bForceRespawns", v), "Respawn"); }} />
        </SettingRow>
      </Box>

      <Box title="Items geben" description="Legt das Item direkt ins Inventar.">
        <SettingRow label="Item" hint="Waffe oder Heilung">
          <Select value={item} onValueChange={setItem}><SelectTrigger className="w-52"><SelectValue /></SelectTrigger><SelectContent>{items.map((i) => <SelectItem key={i.id} value={i.id}>{i.label}</SelectItem>)}</SelectContent></Select>
        </SettingRow>
        <SettingRow label="An wen" hint="Nur du oder alle Spieler auf dem Server">
          <ToggleGroup type="single" value={target} onValueChange={(v) => v && setTarget(v)} className="bg-white/[0.04]">
            <ToggleGroupItem value="me" className="px-3">Mich</ToggleGroupItem>
            <ToggleGroupItem value="all" className="px-3">Alle</ToggleGroupItem>
          </ToggleGroup>
          <Button size="sm" onClick={() => send(() => api.serverExec(target === "all" ? `givetoall ${item}` : `giveitem ${item}`), "Item geben")}><Gift />Geben</Button>
        </SettingRow>
      </Box>
    </TabBody>
  );
}

const difficulties = [
  { id: "easy", label: "Leicht", hint: "zielen langsam, bauen kaum" },
  { id: "normal", label: "Mittel", hint: "wie ein durchschnittlicher Spieler" },
  { id: "hard", label: "Schwer", hint: "treffen oft, bauen zurück" },
];

function BotsTab({ send }: { send: Send }) {
  const [count, setCount] = useState(10);
  const [difficulty, setDifficulty] = useState("normal");
  const [health, setHealth] = useState(100);
  const [shield, setShield] = useState(0);

  return (
    <TabBody>
      <Box title="Bots spawnen" description="Bots erscheinen auf deinem eigenen Server und sehen aus wie echte Spieler (zufälliger Skin + Name).">
        <SettingRow label="Anzahl" hint="Wie viele Bots auf einmal erscheinen">
          <Slider className="w-40" min={1} max={99} step={1} value={[count]} onValueChange={([v]) => setCount(v)} />
          <ValueChip>{count}</ValueChip>
        </SettingRow>
        <SettingRow label="Schwierigkeit" hint={difficulties.find((d) => d.id === difficulty)?.hint ?? ""}>
          <Select value={difficulty} onValueChange={(v) => { setDifficulty(v); send(() => api.serverConfig("botDifficulty", v), "Schwierigkeit"); }}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>{difficulties.map((d) => <SelectItem key={d.id} value={d.id}>{d.label}</SelectItem>)}</SelectContent>
          </Select>
        </SettingRow>
        <div className="flex gap-2 pt-4">
          <Button onClick={() => send(() => api.spawnBots(count), "Bots spawnen")}><Bot />{count} Bots spawnen</Button>
          <Button variant="secondary" onClick={() => send(() => api.removeBots(), "Bots entfernen")}><Trash2 />Alle entfernen</Button>
        </div>
      </Box>

      <Box title="Bot-Werte" description="Gilt für neu gespawnte Bots.">
        <SettingRow label="Leben" hint="100 ist normal">
          <Slider className="w-40" min={1} max={100} step={1} value={[health]} onValueChange={([v]) => setHealth(v)} onValueCommit={([v]) => send(() => api.serverConfig("BotHealth", v), "Bot-Leben")} />
          <ValueChip>{health}</ValueChip>
        </SettingRow>
        <SettingRow label="Schild" hint="0 = ohne Schild, 100 = voll">
          <Slider className="w-40" min={0} max={100} step={5} value={[shield]} onValueChange={([v]) => setShield(v)} onValueCommit={([v]) => send(() => api.serverConfig("BotShield", v), "Bot-Schild")} />
          <ValueChip>{shield}</ValueChip>
        </SettingRow>
        <p className="pt-4 text-xs text-muted-foreground">Ehrlich: Die Bots laufen und reagieren, aber bauen und zielen nicht wie ein Mensch. Das ist der schwierigste Teil – hier wird noch verbessert.</p>
      </Box>
    </TabBody>
  );
}

function TrickshotTab({ send }: { send: Send }) {
  const [opts, setOpts] = useState({ noFallDamage: true, infiniteAmmo: true, infiniteMats: true, instantReload: false, detection: true });
  const [spawnHeight, setSpawnHeight] = useState(3000);
  const set = (key: keyof typeof opts, serverKey: string) => (v: boolean) => { setOpts((o) => ({ ...o, [key]: v })); send(() => api.serverConfig(serverKey, v), "Trickshot"); };

  return (
    <TabBody>
      <Box title="Regeln" description="Gelten für alle Spieler auf deinem Server.">
        <SettingRow label="Kein Fallschaden" hint="Aus jeder Höhe springen, ohne Leben zu verlieren"><Switch checked={opts.noFallDamage} onCheckedChange={set("noFallDamage", "bNoFallDamage")} /></SettingRow>
        <SettingRow label="Unendlich Munition" hint="Das Magazin wird nie leer"><Switch checked={opts.infiniteAmmo} onCheckedChange={set("infiniteAmmo", "bInfiniteAmmo")} /></SettingRow>
        <SettingRow label="Unendlich Material" hint="Holz, Stein und Metall gehen nicht aus"><Switch checked={opts.infiniteMats} onCheckedChange={set("infiniteMats", "bInfiniteMats")} /></SettingRow>
        <SettingRow label="Instant Reload" hint="Nachladen ohne Wartezeit"><Switch checked={opts.instantReload} onCheckedChange={set("instantReload", "bInstantReload")} /></SettingRow>
        <SettingRow label="Spawn-Höhe" hint="So hoch wirst du beim Hochspringen geschossen">
          <Slider className="w-40" min={0} max={6000} step={250} value={[spawnHeight]} onValueChange={([v]) => setSpawnHeight(v)} />
          <ValueChip>{spawnHeight}</ValueChip>
        </SettingRow>
        <div className="pt-4">
          <Button variant="secondary" size="sm" onClick={() => send(() => api.serverExec(`launch 0 0 ${spawnHeight}`), "Hochspringen")}>Jetzt hochspringen</Button>
        </div>
      </Box>

      <Box title="Trickshot-Erkennung" description="Erkennt Kills in der Luft und zeigt sie groß an.">
        <SettingRow label="Erkennung an" hint="Zeigt bei einem Kill in der Luft ein Banner mit Entfernung"><Switch checked={opts.detection} onCheckedChange={set("detection", "bTrickshotDetection")} /></SettingRow>
        <AnimatePresence>
          {opts.detection && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="pt-4">
                <p className="mb-2 text-xs text-muted-foreground">So sieht die Anzeige im Spiel aus:</p>
                <div className="relative overflow-hidden rounded-lg bg-gradient-to-br from-[#1a2b4a] via-[#2a1f4e] to-[#3a1d3f] p-6">
                  <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 300, damping: 18, delay: 0.1 }} className="mx-auto flex w-fit items-center gap-3 rounded-lg bg-black/50 px-5 py-3 backdrop-blur">
                    <Zap className="size-5 text-primary-text" />
                    <div><p className="text-sm font-semibold tracking-wide">TRICKSHOT</p><p className="text-xs text-muted-foreground">georg · in der Luft · 128 m</p></div>
                  </motion.div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Box>
    </TabBody>
  );
}
