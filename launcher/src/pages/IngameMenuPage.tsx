import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Eye, Hammer, Keyboard, LogIn, Plus, SquareTerminal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageHeader, PageShell, Panel, Reveal, SettingRow, ValueChip } from "@/components/common";
import { api, inTauri, type ClientPreferences, type ClientSettings } from "@/lib/api";
import { keyName, useApp, vkFromEvent } from "@/lib/store";
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
    toast.success("Preset gespeichert", { description: "Wird an den Server geschickt, sobald die Match-Steuerung verbunden ist." });
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
          <Panel title="Bauen & Editieren" description="Für schnelleres Editieren wie in Arena.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Edit on Release" hint="Der Edit wird fertig, sobald du die Edit-Taste loslässt">
                <Switch checked={s.preferences.editOnRelease} onCheckedChange={(v) => pref({ editOnRelease: v })} />
              </SettingRow>
              <SettingRow label="Reset on Release" hint="Zurücksetzen passiert sofort beim Loslassen">
                <Switch checked={s.preferences.resetOnRelease} onCheckedChange={(v) => pref({ resetOnRelease: v })} />
              </SettingRow>
              <SettingRow label="Pre-Edits aus" hint="Verhindert, dass du aus Versehen das durchsichtige Vorschau-Bauteil editierst">
                <Switch checked={s.preferences.disablePreEdits} onCheckedChange={(v) => pref({ disablePreEdits: v })} />
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Spiel" description="Komfort-Schalter, die das Menü beim Start setzt.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Immer wieder einsteigen" hint="Respawns in jeder Playlist – ideal zum Üben">
                <Switch checked={s.preferences.respawnsEnabled} onCheckedChange={(v) => pref({ respawnsEnabled: v })} />
              </SettingRow>
              <SettingRow label="Sprinten als Standard" hint="Du rennst, ohne die Sprint-Taste zu halten">
                <Switch checked={s.preferences.sprintByDefault} onCheckedChange={(v) => pref({ sprintByDefault: v })} />
              </SettingRow>
              <SettingRow label="First Person" hint="Kamera aus der Ich-Perspektive (Arme und Waffe bleiben sichtbar)">
                <Switch checked={s.preferences.firstPerson} onCheckedChange={(v) => pref({ firstPerson: v })} />
              </SettingRow>
              <SettingRow label="Nebel im Spiel" hint="Aus = klarere Sicht in die Ferne">
                <Switch checked={s.preferences.inGameFog} onCheckedChange={(v) => pref({ inGameFog: v })} />
              </SettingRow>
              <SettingRow label="Mobile Builds" hint="Bauteile werden erst sehr spät detailliert gezeichnet – wie auf dem Handy">
                <Switch checked={s.preferences.mobileBuilds} onCheckedChange={(v) => pref({ mobileBuilds: v })} />
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Sicht" description="Das Sichtfeld stellst du direkt im Spiel ein.">
            <SettingRow label="Sichtfeld (FOV)" hint={`Im Spiel: ${keyName(s.hotkey)} → Graphics → FOV-Regler, oder in der Konsole „fov 110“ eingeben`}>
              <ValueChip>im Spiel</ValueChip>
            </SettingRow>
          </Panel>

          <Panel title="Tasten" description="Klick auf eine Taste und drück dann die neue. Esc bricht ab.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Menü öffnen" hint="Öffnet und schließt das Ingame-Menü">
                <VkCapture value={s.hotkey} onChange={(vk) => save({ hotkey: vk })} />
              </SettingRow>
              <SettingRow label="Schnell beitreten" hint="Verbindet dich mit dem Server, der im Menü eingetragen ist">
                <VkCapture value={s.joinHotkey} onChange={(vk) => save({ joinHotkey: vk })} />
              </SettingRow>
              <SettingRow label="Konsole" hint="Fest belegt: F8 oder ^ (wie in Unreal)">
                <ValueChip>F8 · ^</ValueChip>
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Konsole" description="Für Befehle wie „cheat give“ auf deinem eigenen Server. Läuft im Takt des Spiels – kein Absturz wie bei alten Konsolen-DLLs.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Stil" hint="Vanity-Konsole: Verlauf, Tab-Vervollständigung, /-Befehle. Original: die normale Unreal-Konsole">
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
              <SettingRow label="Schrägstrich-Taste" hint="„/“ öffnet die Konsole mit einem Befehl, z. B. /give">
                <Switch checked={s.preferences.slashKey} onCheckedChange={(v) => pref({ slashKey: v })} />
              </SettingRow>
              <SettingRow label="Schalter merken" hint="Aus = jedes Mal mit den Standardwerten starten">
                <Switch checked={s.preferences.saveTogglePreferences} onCheckedChange={(v) => pref({ saveTogglePreferences: v })} />
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Beitreten" description="Direkt aus dem Launcher auf einen Server wechseln.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Join Local Host" hint="Server auf diesem PC (127.0.0.1)">
                <Button variant="secondary" size="sm" onClick={() => join("127.0.0.1")}>
                  <LogIn />
                  Beitreten
                </Button>
              </SettingRow>
              <SettingRow label="Join per IP" hint="IP vom Freund, z. B. über Tailscale">
                <Input value={joinIp} onChange={(e) => rememberIp(e.target.value)} placeholder="100.101.12.7" className="h-8 w-40 font-mono text-xs" />
                <Button variant="secondary" size="sm" disabled={!joinIp} onClick={() => join(joinIp)}>
                  Los
                </Button>
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Trickshot-Presets" description="Jedes Preset ist eine Liste von Server-Befehlen. Sie werden über die Match-Steuerung an deinen Server geschickt.">
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
                <Input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Name, z. B. Hoch spawnen" className="h-9" />
                <Input value={presetCmds} onChange={(e) => setPresetCmds(e.target.value)} placeholder="Befehle, mit ; getrennt: launch 0 0 3000; skydive" className="h-9 font-mono text-xs" />
                <Button size="sm" className="h-9" onClick={addPreset} disabled={!presetName.trim() || !presetCmds.trim()}>
                  <Plus />
                  Speichern
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Beispiele: <span className="font-mono">infiniteammo; infinitemats; giveall</span> · <span className="font-mono">god</span> ·{" "}
                <span className="font-mono">launch 0 0 4000; skydive</span>
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

/** Nachbau des F9-Menüs über einer angedeuteten Spielszene. */
function OverlayPreview({ s }: { s: ClientSettings }) {
  const [tab, setTab] = useState(0);
  const tabs = [
    { icon: Hammer, label: "Editing" },
    { icon: Eye, label: "Graphics" },
    { icon: Keyboard, label: "Hotkeys" },
    { icon: SquareTerminal, label: "Console" },
  ];
  const p = s.preferences;
  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground">So sieht das Menü im Spiel aus</p>
      <div className="relative overflow-hidden rounded-xl bg-[linear-gradient(180deg,#5f8fd6_0%,#9db9e6_45%,#5e7f4a_46%,#3f5a33_100%)] p-6">
        <div className="absolute right-6 bottom-10 h-20 w-14 rounded-sm bg-[#8a6a45]/80" />
        <div className="absolute bottom-10 left-10 h-12 w-24 rounded-sm bg-[#6b6b6b]/70" />
        <div className="absolute inset-0 bg-black/25" />
        <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.2 }} className="relative rounded-xl bg-[#0f1115]/85 p-4 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold tracking-widest">
              VANITY <span className="font-normal text-muted-foreground">| Console</span>
            </p>
            <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px]">{keyName(s.hotkey)}</span>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1 rounded-lg bg-white/[0.04] p-1">
            {tabs.map((t, i) => (
              <button
                key={t.label}
                type="button"
                onClick={() => setTab(i)}
                className={cn("flex flex-col items-center gap-1 rounded-md py-2 text-[11px] transition-colors", tab === i ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                <t.icon className="size-4" />
                {t.label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex min-h-36 flex-col gap-2">
            {tab === 0 && (
              <>
                <MiniToggle label="Edit on Release" on={p.editOnRelease} />
                <MiniToggle label="Reset on Release" on={p.resetOnRelease} />
                <MiniToggle label="Disable Pre-Edits" on={p.disablePreEdits} />
                <MiniToggle label="Force Respawns" on={p.respawnsEnabled} />
              </>
            )}
            {tab === 1 && (
              <>
                <div className="rounded-md bg-white/[0.04] px-3 py-2 text-xs">
                  <div className="flex justify-between">
                    <span>FOV</span>
                    <span className="font-mono">80°</span>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-white/10">
                    <div className="h-full w-[45%] rounded-full bg-primary" />
                  </div>
                </div>
                <MiniToggle label="Gameplay Fog" on={p.inGameFog} />
                <MiniToggle label="First Person" on={p.firstPerson} />
              </>
            )}
            {tab === 2 && (
              <>
                <MiniKey label="Menu" k={keyName(s.hotkey)} />
                <MiniKey label="Join" k={keyName(s.joinHotkey)} />
                <MiniKey label="Console" k="F8" />
              </>
            )}
            {tab === 3 && (
              <>
                <MiniToggle label={s.consoleMode === 0 ? "Vanity Console" : "Original UE Console"} on />
                <div className="rounded-md bg-black/40 px-3 py-2 font-mono text-[11px] text-muted-foreground">&gt; /give</div>
              </>
            )}
          </div>
        </motion.div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Die Reiter in der Vorschau sind anklickbar.</p>
    </div>
  );
}

function MiniToggle({ label, on }: { label: string; on: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-white/[0.04] px-3 py-2 text-xs">
      <span>{label}</span>
      <span className={cn("flex h-4 w-7 items-center rounded-full px-0.5 transition-colors", on ? "bg-primary" : "bg-white/15")}>
        <motion.span layout className={cn("size-3 rounded-full bg-white", on && "ml-auto")} />
      </span>
    </div>
  );
}
function MiniKey({ label, k }: { label: string; k: string }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-white/[0.04] px-3 py-2 text-xs">
      <span>{label}</span>
      <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px]">{k}</span>
    </div>
  );
}
