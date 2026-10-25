import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ChevronDown, LogIn, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageHeader, PageShell, Panel, Reveal, SettingRow, ValueChip } from "@/components/common";
import { api, inTauri, type ClientPreferences, type ClientSettings } from "@/lib/api";
import { keyName, useApp, vkFromEvent } from "@/lib/store";
import { levelWord, parkours } from "@/lib/parkours";
import { cn } from "@/lib/utils";

const JOIN_IP_KEY = "vanity.joinIp";

export function IngameMenuPage() {
  const s = useApp((st) => st.clientSettings);
  const save = useApp((st) => st.saveClientSettings);
  const presets = useApp((st) => st.config.trickshotPresets);
  const savePresets = useApp((st) => st.saveTrickshotPresets);
  const [joinIp, setJoinIp] = useState(() => {
    try {
      return localStorage.getItem(JOIN_IP_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [presetName, setPresetName] = useState("");
  const [presetCmds, setPresetCmds] = useState("");

  const pref = (patch: Partial<ClientPreferences>) => save({ preferences: { ...s.preferences, ...patch } });

  const rememberIp = (ip: string) => {
    setJoinIp(ip);
    try {
      localStorage.setItem(JOIN_IP_KEY, ip);
    } catch {
      /* Vorschau ohne Speicher */
    }
  };

  const join = async (target: string) => {
    if (!inTauri) return toast("Beitreten (Vorschau)", { description: target });
    try {
      await api.joinIp(target);
    } catch (e) {
      toast.error("Beitreten fehlgeschlagen", { description: String(e) });
    }
  };

  const addPreset = () => {
    const commands = presetCmds.split(/\r?\n|;/).map((c) => c.trim()).filter(Boolean);
    if (!presetName.trim() || commands.length === 0) return;
    savePresets([...presets, { name: presetName.trim(), commands }]);
    setPresetName("");
    setPresetCmds("");
    toast.success("Preset gespeichert", { description: "Ausführen: Seite „Match-Steuerung“ → „Trickshot“ → „Deine Presets“." });
  };

  const removePreset = (i: number) => savePresets(presets.filter((_, idx) => idx !== i));

  return (
    <PageShell>
      <PageHeader
        title="Ingame-Menü"
        description={`Das Menü im Spiel öffnest du mit ${keyName(s.hotkey)}. Launcher und Menü teilen sich eine Einstellungsdatei – was du hier änderst, gilt beim nächsten Spielstart, und im Spiel kannst du alles jederzeit umstellen.`}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex flex-col gap-6">
          {/* Namen wie im F9-Menü (Reiter „Start“), damit man dieselben Wörter wiederfindet */}
          <Panel title="Editieren" description="Für schnelleres Editieren wie in Arena.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Edit beim Loslassen" hint="Dein Edit ist fertig, sobald du die Taste loslässt">
                <Switch checked={s.preferences.editOnRelease} onCheckedChange={(v) => pref({ editOnRelease: v })} />
              </SettingRow>
              <SettingRow label="Zurücksetzen beim Loslassen" hint="Zurücksetzen ist fertig, sobald du die Taste loslässt">
                <Switch checked={s.preferences.resetOnRelease} onCheckedChange={(v) => pref({ resetOnRelease: v })} />
              </SettingRow>
              <SettingRow label="Keine Vorschau-Edits" hint="Du editierst nie aus Versehen das durchsichtige Vorschau-Teil">
                <Switch checked={s.preferences.disablePreEdits} onCheckedChange={(v) => pref({ disablePreEdits: v })} />
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Spiel" description="Komfort-Schalter, die das Menü beim Start setzt.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Wieder einsteigen" hint="Nach dem Tod kommst du aus der Luft zurück – ideal zum Üben">
                <Switch checked={s.preferences.respawnsEnabled} onCheckedChange={(v) => pref({ respawnsEnabled: v })} />
              </SettingRow>
              <SettingRow label="Immer sprinten" hint="Du rennst, ohne die Sprint-Taste zu halten (nur Fortnite-Versionen vor 5.0)">
                <Switch checked={s.preferences.sprintByDefault} onCheckedChange={(v) => pref({ sprintByDefault: v })} />
              </SettingRow>
              <SettingRow label="Ich-Perspektive" hint="Du siehst aus den Augen deiner Figur">
                <Switch checked={s.preferences.firstPerson} onCheckedChange={(v) => pref({ firstPerson: v })} />
              </SettingRow>
              <SettingRow label="Nebel im Spiel" hint="Aus = klarere Sicht in die Ferne">
                <Switch checked={s.preferences.inGameFog} onCheckedChange={(v) => pref({ inGameFog: v })} />
              </SettingRow>
              <SettingRow label="Einfache Bauteile (wie am Handy)" hint="Bauteile und Umgebung werden einfacher gezeichnet">
                <Switch checked={s.preferences.mobileBuilds} onCheckedChange={(v) => pref({ mobileBuilds: v })} />
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Sichtfeld" description="Den Blickwinkel stellst du direkt im Spiel ein.">
            <SettingRow label="Blickwinkel (normal: 80)" hint={`Im Spiel: ${keyName(s.hotkey)} → Reiter „Start“ → „Sichtfeld“, oder in der Konsole „fov 110“ eingeben`}>
              <ValueChip>im Spiel</ValueChip>
            </SettingRow>
          </Panel>

          <Panel title="Tasten" description="Klick auf eine Taste und drück dann die neue. Esc bricht ab.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Menü öffnen" hint="Öffnet und schließt das Ingame-Menü">
                <VkCapture value={s.hotkey} onChange={(vk) => save({ hotkey: vk })} />
              </SettingRow>
              <SettingRow label="Beitreten-Taste" hint="Ist das Menü zu, trittst du damit dem Server aus „Start“ bei">
                <VkCapture value={s.joinHotkey} onChange={(vk) => save({ joinHotkey: vk })} />
              </SettingRow>
              <SettingRow label="Konsole" hint="Fest belegt: F8 öffnet die Konsole">
                <ValueChip>F8</ValueChip>
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Konsole" description="Hier tippst du im Spiel Befehle für deinen eigenen Server, z. B. „/god“.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Welche Konsole?" hint="Vanity-Konsole: kennt Kurzbefehle wie /god. Original: die normale Unreal-Konsole">
                <div className="flex rounded-md bg-white/[0.06] p-0.5">
                  {["Vanity", "Original"].map((label, i) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => save({ consoleMode: i })}
                      className={cn("rounded px-3 py-1 text-xs transition-colors", s.consoleMode === i ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </SettingRow>
              <SettingRow label="Konsole mit Taste # öffnen" hint="Die Taste # (deutsche Tastatur, bei US-Tastatur /) öffnet die Konsole mit „/“ schon drin – dann z. B. nur noch god tippen. Nur mit der Vanity-Konsole">
                <Switch checked={s.preferences.slashKey} onCheckedChange={(v) => pref({ slashKey: v })} />
              </SettingRow>
              <SettingRow label="Schalter merken" hint="Aus = beim nächsten Start sind alle Schalter wieder wie am Anfang">
                <Switch checked={s.preferences.saveTogglePreferences} onCheckedChange={(v) => pref({ saveTogglePreferences: v })} />
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Beitreten" description="Server wählen, dann im Spiel auf „Spielen“ drücken.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Server auf diesem PC" hint="Dein eigener Server (127.0.0.1)">
                <Button variant="secondary" size="sm" onClick={() => join("127.0.0.1")}>
                  <LogIn />
                  Beitreten
                </Button>
              </SettingRow>
              <SettingRow label="Server mit dieser IP" hint="IP vom anderen PC, z. B. über Tailscale">
                <Input value={joinIp} onChange={(e) => rememberIp(e.target.value)} placeholder="100.101.12.7" className="h-8 w-40 font-mono text-xs" />
                <Button variant="secondary" size="sm" disabled={!joinIp} onClick={() => join(joinIp)}>
                  Beitreten
                </Button>
              </SettingRow>
            </div>
          </Panel>

          <Panel
            title="Trickshot-Presets"
            description="Ein Preset ist eine Liste von Server-Befehlen. Ausführen: Seite „Match-Steuerung“ → Reiter „Trickshot“ → „Deine Presets“. Ein Klick schickt dort alle Befehle nacheinander an deinen Server (du musst im Match sein)."
          >
            <div className="flex flex-col gap-3">
              {presets.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {presets.map((p, i) => (
                    <li key={`${p.name}-${i}`} className="flex items-center gap-3 rounded-lg bg-white/[0.02] px-4 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{p.name}</p>
                        <p className="truncate font-mono text-xs text-muted-foreground">{p.commands.join(" ; ")}</p>
                      </div>
                      <Button variant="ghost" size="icon-sm" aria-label="Preset löschen" onClick={() => removePreset(i)}>
                        <Trash2 />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
                <Input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Name, z. B. Hochschießen" className="h-9" />
                <Input value={presetCmds} onChange={(e) => setPresetCmds(e.target.value)} placeholder="Befehle mit ; trennen, z. B. l 2500; giveammo" className="h-9 font-mono text-xs" />
                <Button size="sm" className="h-9" onClick={addPreset} disabled={!presetName.trim() || !presetCmds.trim()}>
                  <Plus />
                  Speichern
                </Button>
              </div>
              {/* Nur Befehle, die der Vanity-Server wirklich kennt (dieselben wie die Knöpfe auf der Seite Match-Steuerung) */}
              <p className="text-xs leading-relaxed text-muted-foreground">
                Beispiele: <span className="font-mono">l 2500</span> = hochschießen · <span className="font-mono">giveammo</span> = Munition ·{" "}
                <span className="font-mono">regen</span> = Leben voll · <span className="font-mono">givetraps</span> = Sprungpads und andere Fallen ·{" "}
                <span className="font-mono">god</span> = unverwundbar an/aus
              </p>
            </div>
          </Panel>
        </div>

        <Reveal className="xl:sticky xl:top-8 xl:self-start">
          <OverlayPreview s={s} />
        </Reveal>
      </div>
    </PageShell>
  );
}

/** Knopf, der auf die nächste Taste wartet und sie als Windows-Tastencode speichert. */
function VkCapture({ value, onChange }: { value: number; onChange: (vk: number) => void }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== "Escape") {
        const vk = vkFromEvent(e);
        if (vk) onChange(vk);
        else toast.error("Diese Taste kann nicht belegt werden");
      }
      setListening(false);
    };
    window.addEventListener("keydown", onKey, { capture: true, once: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [listening, onChange]);
  return (
    <button
      type="button"
      onClick={() => setListening(true)}
      className={cn(
        "h-9 min-w-24 rounded-md px-3 font-mono text-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        listening ? "bg-primary/20 text-primary-text ring-1 ring-primary/60" : "bg-white/[0.06] hover:bg-white/[0.1]",
      )}
    >
      {listening ? "Taste drücken …" : keyName(value)}
    </button>
  );
}

/**
 * Nachbau des F9-Menüs über einer angedeuteten Spielszene. Aufbau und Texte wie in
 * native/client/ATLAS/Private/GUI.cpp: oben Titelleiste, links die Reiter
 * Start / Befehle / Optionen / Trickshot / Credits, rechts der Inhalt mit den grauen Erklärungen.
 */
const F9_TABS = ["Start", "Befehle", "Optionen", "Trickshot", "Credits"] as const;
const F9_TRICKSHOT_TAB = 3;

interface SavedEntry {
  text: string;
  vk: number;
}

/** Gespeicherte Befehle aus client.json (schreibt die F9-DLL): Befehl bzw. Name der Befehlskette und Taste. */
function savedCommands(s: ClientSettings): SavedEntry[] {
  const entry = (item: unknown, key: "command" | "name"): SavedEntry | null => {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const text = record[key];
    if (typeof text !== "string" || !text.trim()) return null;
    const vk = typeof record.vk === "number" && record.vk > 0 && record.vk <= 254 ? record.vk : 0;
    return { text: text.trim(), vk };
  };
  const commands = Array.isArray(s.commands) ? s.commands.map((c) => entry(c, "command")) : [];
  const macros = Array.isArray(s.macros) ? s.macros.map((m) => entry(m, "name")) : [];
  return [...commands, ...macros].filter((e): e is SavedEntry => e !== null);
}

function OverlayPreview({ s }: { s: ClientSettings }) {
  const [tab, setTab] = useState(0);
  const p = s.preferences;
  const saved = savedCommands(s);
  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground">
        Nachbau vom F9-Menü (kein echtes Bild aus dem Spiel). Die Reiter sind anklickbar. Manche Schalter zeigt das Spiel nur bei älteren
        Fortnite-Versionen.
      </p>
      <div className="relative overflow-hidden rounded-xl bg-[linear-gradient(180deg,#5f8fd6_0%,#9db9e6_45%,#5e7f4a_46%,#3f5a33_100%)] p-6">
        <div className="absolute right-6 bottom-10 h-20 w-14 rounded-sm bg-[#8a6a45]/80" />
        <div className="absolute bottom-10 left-10 h-12 w-24 rounded-sm bg-[#6b6b6b]/70" />
        <div className="absolute inset-0 bg-black/25" />
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2 }}
          className="relative overflow-hidden rounded-xl bg-[#0f1115]/90 shadow-2xl ring-1 ring-white/[0.06] backdrop-blur-xl"
        >
          {/* Titelleiste: Logo, „Vanity | Menü“, Menü-Taste, Schließen */}
          <div className="flex items-center gap-2 border-b border-white/[0.06] bg-[#0e1118] px-3 py-2.5">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary/25 text-[11px] font-bold text-primary-text">V</span>
            <p className="text-xs">
              <span className="font-semibold text-primary-text">Vanity</span> <span className="text-muted-foreground">| Menü</span>
            </p>
            <span className="ml-auto font-mono text-[11px] text-muted-foreground/80">[{keyName(s.hotkey)}]</span>
            <X className="size-3.5 text-muted-foreground" aria-hidden />
          </div>
          <div className="grid grid-cols-[5.5rem_1fr]">
            {/* Seitenleiste mit den Reitern */}
            <div className="flex flex-col border-r border-white/[0.06] bg-[#0e1118] py-2">
              {F9_TABS.map((label, i) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setTab(i)}
                  className={cn(
                    "relative px-3 py-2.5 text-left text-[11px] transition-colors",
                    tab === i ? "bg-primary/10 text-primary-text" : "text-muted-foreground hover:bg-primary/5 hover:text-foreground",
                  )}
                >
                  {tab === i && <span className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />}
                  {label}
                </button>
              ))}
            </div>
            <div className="flex min-h-80 min-w-0 flex-col gap-2 p-3">
              {tab === 0 && (
                <>
                  <MiniSection label="Server beitreten" />
                  <MiniCombo label="Wo läuft der Server?" value="Auf diesem PC" />
                  <MiniButtons labels={["Server auf diesem PC beitreten"]} />
                  <MiniHint text={`Tipp: Ist das Menü zu, trittst du mit der Taste ${keyName(s.joinHotkey)} sofort bei.`} />
                  <MiniSection label="Editieren" />
                  <MiniToggle label="Edit beim Loslassen" on={p.editOnRelease} hint="Dein Edit ist fertig, sobald du die Taste loslässt." />
                  <MiniToggle label="Zurücksetzen beim Loslassen" on={p.resetOnRelease} hint="Zurücksetzen ist fertig, sobald du die Taste loslässt." />
                  <MiniToggle label="Keine Vorschau-Edits" on={p.disablePreEdits} hint="Du editierst nie aus Versehen das durchsichtige Vorschau-Teil." />
                  <MiniSection label="Grafik" />
                  <MiniToggle label="Einfache Bauteile (wie am Handy)" on={p.mobileBuilds} hint="Bauteile und Umgebung werden einfacher gezeichnet." />
                  <MiniToggle label="Nebel im Spiel" on={p.inGameFog} hint="Aus = klarere Sicht in die Ferne." />
                  <MiniSlider label="Texturen vereinfachen" value="0" fill="0%" />
                  <MiniHint text="0 = normal. Höher = unschärfer, läuft aber oft flüssiger." />
                  <MiniSection label="Laufen" />
                  <MiniToggle label="Immer sprinten" on={p.sprintByDefault} hint="Du rennst, ohne die Sprint-Taste zu halten." />
                  <MiniSection label="Sichtfeld" />
                  <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                    <MiniSlider label="Blickwinkel (normal: 80)" value="80" fill="45%" />
                    <span className="rounded-md bg-white/[0.07] px-2 py-1.5 text-[11px]">Zurück auf 80</span>
                  </div>
                  <MiniHint text="Größer = du siehst mehr vom Rand." />
                  <MiniSection label="Nach dem Tod" />
                  <MiniToggle
                    label="Wieder einsteigen"
                    on={p.respawnsEnabled}
                    hint="Du kommst nach dem Tod aus der Luft zurück. Gilt ab dem nächsten Spielstart."
                  />
                  <MiniSection label="Sonstiges" />
                  <MiniToggle label="Ich-Perspektive" on={p.firstPerson} hint="Du siehst aus den Augen deiner Figur." />
                  <MiniToggle label="Freie Kamera" on={false} hint="Die Kamera fliegt frei herum, deine Figur bleibt stehen." />
                  <MiniToggle label="Ziel-Infos" on={false} hint="Zeigt Infos zu dem, was du gerade anvisierst." />
                </>
              )}
              {tab === 1 && (
                <>
                  <MiniSection label="Neuer Befehl" />
                  <MiniHint text="Befehl eintippen, Taste wählen, „Speichern“ klicken. Mehrere Befehle hintereinander: vorher „+ Schritt“." />
                  <span className="truncate rounded-md bg-black/40 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">Befehl, z. B. cheat giveammo</span>
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <span className="truncate rounded-md bg-black/40 px-3 py-1.5 text-[11px] text-muted-foreground">Pause danach (ms)</span>
                    <span className="rounded-md bg-white/[0.07] px-3 py-1.5 text-[11px]">+ Schritt</span>
                  </div>
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <span className="truncate rounded-md bg-white/[0.07] px-3 py-1.5 text-center text-[11px]">Taste wählen [keine]</span>
                    <span className="rounded-md bg-white/[0.07] px-3 py-1.5 text-[11px]">Speichern</span>
                  </div>
                  <MiniSection label="Deine Befehle" />
                  {saved.length === 0 ? (
                    <MiniHint text="Noch keine gespeicherten Befehle." />
                  ) : (
                    <>
                      <MiniHint text="Doppelklick auf einen Befehl: Text ändern." />
                      {saved.slice(0, 3).map((entry, i) => (
                        <div key={`${entry.text}-${i}`} className="flex flex-col gap-1.5 border-b border-white/[0.06] pb-2">
                          <p className="truncate font-mono text-[11px]">{entry.text}</p>
                          <p className="text-[10px] text-muted-foreground">Taste: {entry.vk ? keyName(entry.vk) : "keine"}</p>
                          <MiniButtons labels={["Ausführen", entry.vk ? "Taste entfernen" : "Taste wählen", "Löschen"]} />
                        </div>
                      ))}
                      {saved.length > 3 && <MiniHint text={`… und ${saved.length - 3} weitere`} />}
                    </>
                  )}
                </>
              )}
              {tab === 2 && (
                <>
                  <MiniSection label="Allgemein" />
                  <MiniCombo label="Welche Konsole?" value={s.consoleMode === 0 ? "Vanity-Konsole" : "Original-Konsole (Unreal)"} />
                  <MiniHint text="Die Konsole öffnest du mit F8. Die Vanity-Konsole kennt Kurzbefehle wie /god." />
                  <MiniToggle
                    label="Konsole mit Taste # öffnen"
                    on={p.slashKey}
                    hint="Sie geht mit / schon drin auf – dann z. B. nur noch god tippen und Enter. Nur mit der Vanity-Konsole."
                  />
                  <MiniToggle label="Schalter merken" on={p.saveTogglePreferences} hint="Aus = beim nächsten Start sind alle Schalter wieder wie am Anfang." />
                  <MiniSection label="Tasten" />
                  <MiniButtons labels={[`Menü-Taste ändern [${keyName(s.hotkey)}]`]} />
                  <MiniButtons labels={[`Beitreten-Taste ändern [${keyName(s.joinHotkey)}]`]} />
                  <MiniButtons labels={["Alles zurücksetzen"]} />
                  <MiniHint text="Achtung: Stellt alle Schalter und Tasten zurück und löscht deine gespeicherten Befehle." />
                </>
              )}
              {tab === F9_TRICKSHOT_TAB && <MiniTrickshot />}
              {tab === 4 && (
                <div className="flex flex-col gap-1 pt-1 text-[11px]">
                  <p className="text-sm font-semibold text-primary-text">Vanity</p>
                  <p className="text-muted-foreground">Ingame-Menü</p>
                  <MiniSection label="Credits" />
                  <MiniHint text="Vanity baut auf diesen Projekten auf. Danke! Klick auf einen Namen öffnet seine Seite im Browser." />
                  {/* Nennungen bleiben im Original (Lizenz von ATLAS Console) */}
                  <p className="pt-1 font-medium text-primary-text">Erbium</p>
                  <p className="text-muted-foreground">- Base of the project</p>
                  <p className="pt-1 font-medium text-primary-text">ATLAS Console</p>
                  <p className="text-muted-foreground">- Base of this in-game menu (cipherfps, ralz and contributors)</p>
                  <p className="pt-3 text-muted-foreground/80">Vanity is based on ATLAS Console by cipherfps, ralz and contributors.</p>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function MiniCombo({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center justify-between rounded-md bg-white/[0.07] px-3 py-1.5">
        {value}
        <ChevronDown className="size-3 text-muted-foreground" aria-hidden />
      </span>
    </div>
  );
}

/** Reiter „Trickshot“ im F9-Menü (VanityTrickshotTab.cpp): Parkour laden, Ziel-Bot, Ausrüstung, Üben. */
function MiniTrickshot() {
  return (
    <div className="flex flex-col gap-2">
      <MiniSection label="Parkour laden" />
      <MiniHint text="Wähle eine Strecke. Du landest am Start und bekommst eine Sniper." />
      {parkours.map((p, i) => (
        <div key={p.id} className={cn("rounded-md bg-white/[0.04] px-3 py-2 text-xs ring-1", i === 0 ? "ring-primary/60" : "ring-white/[0.06]")}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate font-medium text-primary-text">{p.name}</span>
            <span className="flex shrink-0 gap-0.5">
              {[1, 2, 3].map((n) => <span key={n} className={cn("size-1.5 rounded-full", n <= p.level ? "bg-primary" : "ring-1 ring-white/25")} />)}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{levelWord(p.level)}</span>
            <span className="ml-auto shrink-0 rounded bg-primary px-2.5 py-0.5 text-[10px] text-primary-foreground">Laden</span>
          </div>
          {p.description && <p className="mt-1 text-[10px] leading-snug text-muted-foreground">{p.description}</p>}
        </div>
      ))}
      <MiniButtons labels={["Nochmal von vorne", "Alles wegräumen"]} />

      <MiniSection label="Ziel-Bot" />
      <MiniHint text="Ein Bot, der still vor dir steht – perfekt zum Zielen." />
      <div className="grid grid-cols-2 gap-2">
        <MiniSlider label="Leben" value="50" fill="25%" />
        <MiniSlider label="Abstand" value="30 m" fill="26%" />
      </div>
      <div className="rounded-md bg-primary px-3 py-1.5 text-center text-[11px] text-primary-foreground">Bot vor mich stellen</div>
      <MiniButtons labels={["Alle Bots weg", "Bots zu mir"]} />

      <MiniSection label="Ausrüstung" />
      <MiniButtons labels={["Sniper geben", "Sprungpads geben"]} />
      <MiniButtons labels={["Munition auffüllen", "Leben auffüllen"]} />

      <MiniSection label="Üben" />
      <MiniHint text="Merk dir eine Stelle und spring mit einem Klick dorthin zurück." />
      <MiniButtons labels={["Position merken", "Zurück zur Position"]} />
      <MiniButtons labels={["Hochschießen", "Zeitlupe: aus"]} />
      <MiniButtons labels={["Wenig Schwerkraft", "Normale Schwerkraft"]} />
      <MiniButtons labels={["Unverwundbar umschalten", "Sturm anhalten"]} />
      <MiniHint text="Zeitlupe und Sturm gelten für alle im Match." />
    </div>
  );
}

function MiniHint({ text }: { text: string }) {
  return <p className="text-[10px] leading-snug text-muted-foreground">{text}</p>;
}
function MiniSection({ label }: { label: string }) {
  return <p className="pt-1 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase first:pt-0">{label}</p>;
}
function MiniButtons({ labels }: { labels: string[] }) {
  return (
    <div className={cn("grid gap-2", labels.length > 2 ? "grid-cols-3" : labels.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
      {labels.map((l) => <span key={l} className="flex items-center justify-center rounded-md bg-white/[0.07] px-2 py-1.5 text-center text-[11px] leading-tight">{l}</span>)}
    </div>
  );
}
function MiniSlider({ label, value, fill }: { label: string; value: string; fill: string }) {
  return (
    <div className="rounded-md bg-white/[0.04] px-3 py-2 text-[11px]">
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="font-mono">{value}</span>
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-white/10">
        <div className="h-full rounded-full bg-primary" style={{ width: fill }} />
      </div>
    </div>
  );
}

/** Schalter wie im F9-Menü, darunter die graue Erklärung. */
function MiniToggle({ label, on, hint }: { label: string; on: boolean; hint?: string }) {
  return (
    <div className="rounded-md bg-white/[0.04] px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0">{label}</span>
        <span className={cn("flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors", on ? "bg-primary" : "bg-white/15")}>
          <motion.span layout className={cn("size-3 rounded-full bg-white", on && "ml-auto")} />
        </span>
      </div>
      {hint && <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}
