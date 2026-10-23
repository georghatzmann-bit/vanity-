import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bot, Crosshair, Flag, Gift, MapPin, Play, Plane, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  EmptyState,
  PageHeader,
  PageShell,
  PhaseNote,
  Reveal,
  SettingRow,
  ValueChip,
} from "@/components/common";
import { giveableItems, playlists } from "@/lib/demo-data";
import { previewToast } from "@/lib/preview";

export function MatchPage() {
  return (
    <PageShell>
      <PageHeader
        title="Match-Steuerung"
        description="Alles, was du als Host auf deinem Server einstellen kannst. Dieselben Optionen gibt es später auch im Ingame-Menü (F9) – nur für den Host."
        actions={
          <>
            <Button variant="secondary" onClick={() => previewToast("Bus starten", 7)}>
              <Plane />
              Bus starten
            </Button>
            <Button onClick={() => previewToast("Match starten", 7)}>
              <Play className="fill-current" />
              Match starten
            </Button>
          </>
        }
      />
      <PhaseNote phase={7}>Bots ab Phase 6, alles andere ab Phase 7. Die Regler kannst du schon ausprobieren.</PhaseNote>

      <Reveal>
        <Tabs defaultValue="match" className="gap-6">
          <TabsList className="h-10 bg-white/[0.04] p-1">
            <TabsTrigger value="match" className="px-4">
              <Flag />
              Match
            </TabsTrigger>
            <TabsTrigger value="bots" className="px-4">
              <Bot />
              Bots
            </TabsTrigger>
            <TabsTrigger value="trickshot" className="px-4">
              <Crosshair />
              Trickshot
            </TabsTrigger>
          </TabsList>
          <TabsContent value="match">
            <MatchTab />
          </TabsContent>
          <TabsContent value="bots">
            <BotsTab />
          </TabsContent>
          <TabsContent value="trickshot">
            <TrickshotTab />
          </TabsContent>
        </Tabs>
      </Reveal>
    </PageShell>
  );
}

function TabBody({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="grid gap-6 lg:grid-cols-2"
    >
      {children}
    </motion.div>
  );
}

/** Panel ohne eigenes Einblenden (Tabs blenden schon selbst ein). */
function Box({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="glass rounded-xl px-6 py-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      <div className="mt-4 flex flex-col divide-y divide-white/[0.05]">{children}</div>
    </section>
  );
}

function MatchTab() {
  const [playlist, setPlaylist] = useState(playlists[0].id);
  const [lategame, setLategame] = useState(false);
  const [storm, setStorm] = useState(true);
  const [stormSpeed, setStormSpeed] = useState(1);
  const [respawn, setRespawn] = useState(false);
  const [respawnTime, setRespawnTime] = useState(5);
  const [item, setItem] = useState(giveableItems[0]);
  const [target, setTarget] = useState("all");

  return (
    <TabBody>
      <Box title="Spielmodus" description="Gilt für das nächste Match.">
        <SettingRow label="Playlist" hint="Solo, Duos, Squads, Team Rumble oder Arena">
          <Select value={playlist} onValueChange={setPlaylist}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {playlists.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label="Lategame" hint="Startet direkt in einer späten Zone mit voller Ausrüstung">
          <Switch checked={lategame} onCheckedChange={setLategame} />
        </SettingRow>
      </Box>

      <Box title="Sturm" description="Ändert sich sofort, auch während des Matches.">
        <SettingRow label="Sturm aktiv" hint="Aus = der Sturm bleibt stehen und macht keinen Schaden">
          <Switch checked={storm} onCheckedChange={setStorm} />
        </SettingRow>
        <SettingRow label="Sturm-Tempo" hint="1,0× ist normal. Kleiner = langsamer" disabled={!storm}>
          <Slider
            className="w-40"
            min={0.25}
            max={3}
            step={0.25}
            value={[stormSpeed]}
            onValueChange={([v]) => setStormSpeed(v)}
            disabled={!storm}
          />
          <ValueChip>{stormSpeed.toFixed(2).replace(".", ",")}×</ValueChip>
        </SettingRow>
      </Box>

      <Box title="Respawn" description="Nach einer Eliminierung wieder einsteigen.">
        <SettingRow label="Respawn an" hint="Spieler kommen nach der Wartezeit in der Luft zurück">
          <Switch checked={respawn} onCheckedChange={setRespawn} />
        </SettingRow>
        <SettingRow label="Wartezeit" hint="Sekunden bis zum Wiedereinstieg" disabled={!respawn}>
          <Slider
            className="w-40"
            min={1}
            max={30}
            step={1}
            value={[respawnTime]}
            onValueChange={([v]) => setRespawnTime(v)}
            disabled={!respawn}
          />
          <ValueChip>{respawnTime} s</ValueChip>
        </SettingRow>
      </Box>

      <Box title="Items geben" description="Legt das Item direkt ins Inventar.">
        <SettingRow label="Item" hint="Waffe, Heilung oder Material">
          <Select value={item} onValueChange={setItem}>
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {giveableItems.map((i) => (
                <SelectItem key={i} value={i}>
                  {i}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label="An wen" hint="Nur du oder alle Spieler auf dem Server">
          <ToggleGroup
            type="single"
            value={target}
            onValueChange={(v) => v && setTarget(v)}
            className="bg-white/[0.04]"
          >
            <ToggleGroupItem value="me" className="px-3">
              Mich
            </ToggleGroupItem>
            <ToggleGroupItem value="all" className="px-3">
              Alle
            </ToggleGroupItem>
          </ToggleGroup>
          <Button size="sm" onClick={() => previewToast(`${item} geben`, 7)}>
            <Gift />
            Geben
          </Button>
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

function BotsTab() {
  const [count, setCount] = useState(10);
  const [mode, setMode] = useState("targets");
  const [difficulty, setDifficulty] = useState("normal");
  const [health, setHealth] = useState(100);
  const [shield, setShield] = useState(0);
  const enemies = mode === "enemies";

  return (
    <TabBody>
      <Box title="Bots spawnen" description="Bots erscheinen nur auf deinem eigenen Server.">
        <SettingRow label="Anzahl" hint="Wie viele Bots auf einmal erscheinen">
          <Slider className="w-40" min={1} max={99} step={1} value={[count]} onValueChange={([v]) => setCount(v)} />
          <ValueChip>{count}</ValueChip>
        </SettingRow>
        <SettingRow label="Verhalten" hint="Ziele stehen still. Gegner laufen und schießen (experimentell)">
          <ToggleGroup type="single" value={mode} onValueChange={(v) => v && setMode(v)} className="bg-white/[0.04]">
            <ToggleGroupItem value="targets" className="px-3">
              Ziele
            </ToggleGroupItem>
            <ToggleGroupItem value="enemies" className="px-3">
              Gegner
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingRow>
        <SettingRow
          label="Schwierigkeit"
          hint={difficulties.find((d) => d.id === difficulty)?.hint ?? ""}
          disabled={!enemies}
        >
          <Select value={difficulty} onValueChange={setDifficulty} disabled={!enemies}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {difficulties.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <div className="flex gap-2 pt-4">
          <Button onClick={() => previewToast(`${count} Bots spawnen`, 6)}>
            <Bot />
            {count} Bots spawnen
          </Button>
          <Button variant="secondary" onClick={() => previewToast("Alle Bots entfernen", 6)}>
            <Trash2 />
            Alle entfernen
          </Button>
        </div>
      </Box>

      <Box title="Bot-Werte" description="Gilt für neu gespawnte Bots.">
        <SettingRow label="Leben" hint="100 ist normal">
          <Slider className="w-40" min={1} max={100} step={1} value={[health]} onValueChange={([v]) => setHealth(v)} />
          <ValueChip>{health}</ValueChip>
        </SettingRow>
        <SettingRow label="Schild" hint="0 = ohne Schild, 100 = voll">
          <Slider className="w-40" min={0} max={100} step={5} value={[shield]} onValueChange={([v]) => setShield(v)} />
          <ValueChip>{shield}</ValueChip>
        </SettingRow>
        <AnimatePresence>
          {enemies && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden pt-4 text-xs text-warning"
            >
              Echte Gegner-Bots sind der schwierigste Teil des Plans. Sie kommen als „experimentell“
              und können am Anfang noch komisch laufen.
            </motion.p>
          )}
        </AnimatePresence>
      </Box>
    </TabBody>
  );
}

function TrickshotTab() {
  const [opts, setOpts] = useState({
    noFallDamage: true,
    infiniteAmmo: true,
    infiniteMats: true,
    instantReload: false,
    detection: true,
  });
  const [spawnHeight, setSpawnHeight] = useState(150);
  const set = (key: keyof typeof opts) => (v: boolean) => setOpts((o) => ({ ...o, [key]: v }));

  return (
    <TabBody>
      <Box title="Regeln" description="Gelten für alle Spieler auf deinem Server.">
        <SettingRow label="Kein Fallschaden" hint="Aus jeder Höhe springen, ohne Leben zu verlieren">
          <Switch checked={opts.noFallDamage} onCheckedChange={set("noFallDamage")} />
        </SettingRow>
        <SettingRow label="Unendlich Munition" hint="Das Magazin wird nie leer">
          <Switch checked={opts.infiniteAmmo} onCheckedChange={set("infiniteAmmo")} />
        </SettingRow>
        <SettingRow label="Unendlich Material" hint="Holz, Stein und Metall gehen nicht aus">
          <Switch checked={opts.infiniteMats} onCheckedChange={set("infiniteMats")} />
        </SettingRow>
        <SettingRow label="Instant Reload" hint="Nachladen ohne Wartezeit">
          <Switch checked={opts.instantReload} onCheckedChange={set("instantReload")} />
        </SettingRow>
        <SettingRow label="Spawn-Höhe" hint="So hoch über dem Boden startest du">
          <Slider
            className="w-40"
            min={0}
            max={500}
            step={10}
            value={[spawnHeight]}
            onValueChange={([v]) => setSpawnHeight(v)}
          />
          <ValueChip>{spawnHeight} m</ValueChip>
        </SettingRow>
      </Box>

      <div className="flex flex-col gap-6">
        <Box title="Teleport-Punkte" description="Lieblingsstellen speichern und mit einem Klick hin.">
          <div className="pt-1">
            <EmptyState
              icon={MapPin}
              title="Noch keine Punkte gespeichert"
              hint="Im Spiel F9 drücken und „Punkt speichern“ wählen. Der Punkt erscheint dann hier."
            />
          </div>
        </Box>

        <Box title="Trickshot-Erkennung" description="Erkennt besondere Kills und zeigt sie groß an.">
          <SettingRow label="Erkennung an" hint="Zum Beispiel: Kill in der Luft, nach einer Drehung, aus großer Entfernung">
            <Switch checked={opts.detection} onCheckedChange={set("detection")} />
          </SettingRow>
          <AnimatePresence>
            {opts.detection && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <TrickshotPreview />
              </motion.div>
            )}
          </AnimatePresence>
        </Box>
      </div>
    </TabBody>
  );
}

/** So soll die Anzeige im Spiel aussehen. */
function TrickshotPreview() {
  return (
    <div className="pt-4">
      <p className="mb-2 text-xs text-muted-foreground">Vorschau der Anzeige im Spiel:</p>
      <div className="relative overflow-hidden rounded-lg bg-gradient-to-br from-[#1a2b4a] via-[#2a1f4e] to-[#3a1d3f] p-6">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 18, delay: 0.1 }}
          className="mx-auto flex w-fit items-center gap-3 rounded-lg bg-black/50 px-5 py-3 backdrop-blur"
        >
          <Zap className="size-5 text-primary-text" />
          <div>
            <p className="text-sm font-semibold tracking-wide">360° IN DER LUFT</p>
            <p className="text-xs text-muted-foreground">Scharfschütze · 128 m Entfernung</p>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
