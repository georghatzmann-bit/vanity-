import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Eye, Hammer, Keyboard, LogIn, Plus, SquareTerminal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { PageHeader, PageShell, Panel, Reveal, SettingRow, ValueChip } from "@/components/common";
import { api, inTauri, type ClientSettings } from "@/lib/api";
import { keyName, useApp, vkFromEvent } from "@/lib/store";
import { cn } from "@/lib/utils";

export function IngameMenuPage() {
  const s = useApp((st) => st.clientSettings);
  const save = useApp((st) => st.saveClientSettings);
  const [joinIp, setJoinIp] = useState(s.joinIp);
  const [presetName, setPresetName] = useState("");
  const [presetCmds, setPresetCmds] = useState("");

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
    save({ presets: [...s.presets, { name: presetName.trim(), commands }] });
    setPresetName("");
    setPresetCmds("");
    toast.success("Preset gespeichert", { description: "Im Spiel unter F9 → Trickshot." });
  };

  const removePreset = (i: number) => save({ presets: s.presets.filter((_, idx) => idx !== i) });

  return (
    <PageShell>
      <PageHeader
        title="Ingame-Menü"
        description={`Das Menü im Spiel öffnest du mit ${keyName(s.menuKey)}. Was du hier einstellst, gilt sofort beim nächsten Öffnen – und lässt sich im Spiel jederzeit ändern.`}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex flex-col gap-6">
          <Panel title="Bauen & Editieren" description="Für schnelleres Editieren wie in Arena.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Edit on Release" hint="Der Edit wird fertig, sobald du die Edit-Taste loslässt"><Switch checked={s.editOnRelease} onCheckedChange={(v) => save({ editOnRelease: v })} /></SettingRow>
              <SettingRow label="Reset on Release" hint="Zurücksetzen passiert sofort beim Loslassen"><Switch checked={s.resetOnRelease} onCheckedChange={(v) => save({ resetOnRelease: v })} /></SettingRow>
              <SettingRow label="Disable Pre-Edits" hint="Verhindert, dass du aus Versehen das durchsichtige Vorschau-Bauteil editierst"><Switch checked={s.disablePreEdits} onCheckedChange={(v) => save({ disablePreEdits: v })} /></SettingRow>
            </div>
          </Panel>

          <Panel title="Sicht" description="Wie viel du vom Spielfeld siehst.">
            <SettingRow label="Sichtfeld (FOV)" hint="80 ist der Standard. Höher = mehr Überblick, aber kleinere Gegner">
              <Slider className="w-44" min={60} max={120} step={1} value={[s.fov]} onValueChange={([v]) => useApp.setState({ clientSettings: { ...s, fov: v } })} onValueCommit={([v]) => save({ fov: v })} />
              <ValueChip>{s.fov}°</ValueChip>
            </SettingRow>
          </Panel>

          <Panel title="Tasten" description="Klick auf eine Taste und drück dann die neue. Esc bricht ab.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Menü öffnen" hint="Öffnet und schließt das Ingame-Menü"><VkCapture value={s.menuKey} onChange={(vk) => save({ menuKey: vk })} /></SettingRow>
              <SettingRow label="Schnell beitreten" hint="Verbindet dich mit dem Server auf diesem PC"><VkCapture value={s.joinKey} onChange={(vk) => save({ joinKey: vk })} /></SettingRow>
              <SettingRow label="Konsole" hint="Öffnet die Unreal-Konsole für Befehle"><VkCapture value={s.consoleKey} onChange={(vk) => save({ consoleKey: vk })} /></SettingRow>
            </div>
          </Panel>

          <Panel title="Konsole" description="Für Befehle wie „cheat give“ auf deinem eigenen Server.">
            <SettingRow label="Konsole an" hint="Läuft bei Vanity im Takt des Spiels – dadurch kein Absturz wie bei alten Konsolen-DLLs"><Switch checked={s.console} onCheckedChange={(v) => save({ console: v })} /></SettingRow>
          </Panel>

          <Panel title="Beitreten" description="Direkt aus dem Spiel auf einen Server wechseln.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Join Local Host" hint="Server auf diesem PC (127.0.0.1)"><Button variant="secondary" size="sm" onClick={() => join("127.0.0.1")}><LogIn />Beitreten</Button></SettingRow>
              <SettingRow label="Join per IP" hint="IP vom Freund, z. B. über Tailscale">
                <Input value={joinIp} onChange={(e) => setJoinIp(e.target.value)} onBlur={() => save({ joinIp })} placeholder="100.101.12.7" className="h-8 w-40 font-mono text-xs" />
                <Button variant="secondary" size="sm" disabled={!joinIp} onClick={() => join(joinIp)}>Los</Button>
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Trickshot-Presets" description="Jedes Preset ist eine Liste von Server-Befehlen, die im Spiel mit einem Klick ausgeführt werden (F9 → Trickshot).">
            <div className="flex flex-col gap-3">
              {s.presets.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {s.presets.map((p, i) => (
                    <li key={i} className="flex items-center gap-3 rounded-lg bg-white/[0.02] px-4 py-2">
                      <div className="min-w-0 flex-1"><p className="text-sm font-medium">{p.name}</p><p className="truncate font-mono text-xs text-muted-foreground">{p.commands.join(" ; ")}</p></div>
                      <Button variant="ghost" size="icon-sm" aria-label="Preset löschen" onClick={() => removePreset(i)}><Trash2 /></Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
                <Input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Name, z. B. Hoch spawnen" className="h-9" />
                <Input value={presetCmds} onChange={(e) => setPresetCmds(e.target.value)} placeholder="Befehle, mit ; getrennt: launch 0 0 3000; skydive" className="h-9 font-mono text-xs" />
                <Button size="sm" className="h-9" onClick={addPreset} disabled={!presetName.trim() || !presetCmds.trim()}><Plus />Speichern</Button>
              </div>
              <p className="text-xs text-muted-foreground">Beispiele: <span className="font-mono">infiniteammo; infinitemats; giveall</span> · <span className="font-mono">god</span> · <span className="font-mono">launch 0 0 4000; skydive</span></p>
            </div>
          </Panel>
        </div>

        <Reveal className="xl:sticky xl:top-8 xl:self-start"><OverlayPreview s={s} /></Reveal>
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
    <button type="button" onClick={() => setListening(true)} className={cn("h-9 min-w-24 rounded-md px-3 font-mono text-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", listening ? "bg-primary/20 text-primary-text ring-1 ring-primary/60" : "bg-white/[0.06] hover:bg-white/[0.1]")}>
      {listening ? "Taste drücken …" : keyName(value)}
    </button>
  );
}

/** Nachbau des F9-Menüs über einer angedeuteten Spielszene. */
function OverlayPreview({ s }: { s: ClientSettings }) {
  const [tab, setTab] = useState(0);
  const tabs = [{ icon: Hammer, label: "Bauen" }, { icon: Eye, label: "Sicht" }, { icon: Keyboard, label: "Tasten" }, { icon: SquareTerminal, label: "Konsole" }];
  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground">So sieht das Menü im Spiel aus</p>
      <div className="relative overflow-hidden rounded-xl bg-[linear-gradient(180deg,#5f8fd6_0%,#9db9e6_45%,#5e7f4a_46%,#3f5a33_100%)] p-6">
        <div className="absolute right-6 bottom-10 h-20 w-14 rounded-sm bg-[#8a6a45]/80" />
        <div className="absolute bottom-10 left-10 h-12 w-24 rounded-sm bg-[#6b6b6b]/70" />
        <div className="absolute inset-0 bg-black/25" />
        <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.2 }} className="relative rounded-xl bg-[#0f1115]/85 p-4 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between"><p className="text-xs font-semibold tracking-widest">VANITY</p><span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px]">{keyName(s.menuKey)}</span></div>
          <div className="mt-3 grid grid-cols-4 gap-1 rounded-lg bg-white/[0.04] p-1">
            {tabs.map((t, i) => (
              <button key={t.label} type="button" onClick={() => setTab(i)} className={cn("flex flex-col items-center gap-1 rounded-md py-2 text-[11px] transition-colors", tab === i ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}><t.icon className="size-4" />{t.label}</button>
            ))}
          </div>
          <div className="mt-3 flex min-h-36 flex-col gap-2">
            {tab === 0 && <><MiniToggle label="Edit on Release" on={s.editOnRelease} /><MiniToggle label="Reset on Release" on={s.resetOnRelease} /><MiniToggle label="Disable Pre-Edits" on={s.disablePreEdits} /></>}
            {tab === 1 && <div className="rounded-md bg-white/[0.04] px-3 py-2 text-xs"><div className="flex justify-between"><span>FOV</span><span className="font-mono">{s.fov}°</span></div><div className="mt-2 h-1.5 rounded-full bg-white/10"><div className="h-full rounded-full bg-primary" style={{ width: `${((s.fov - 60) / 60) * 100}%` }} /></div></div>}
            {tab === 2 && <><MiniKey label="Menü" k={keyName(s.menuKey)} /><MiniKey label="Schnell beitreten" k={keyName(s.joinKey)} /><MiniKey label="Konsole" k={keyName(s.consoleKey)} /></>}
            {tab === 3 && <><MiniToggle label="Konsole" on={s.console} /><div className="rounded-md bg-black/40 px-3 py-2 font-mono text-[11px] text-muted-foreground">&gt; cheat giveall</div></>}
          </div>
        </motion.div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Die Reiter in der Vorschau sind anklickbar.</p>
    </div>
  );
}

function MiniToggle({ label, on }: { label: string; on: boolean }) {
  return <div className="flex items-center justify-between rounded-md bg-white/[0.04] px-3 py-2 text-xs"><span>{label}</span><span className={cn("flex h-4 w-7 items-center rounded-full px-0.5 transition-colors", on ? "bg-primary" : "bg-white/15")}><motion.span layout className={cn("size-3 rounded-full bg-white", on && "ml-auto")} /></span></div>;
}
function MiniKey({ label, k }: { label: string; k: string }) {
  return <div className="flex items-center justify-between rounded-md bg-white/[0.04] px-3 py-2 text-xs"><span>{label}</span><span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px]">{k}</span></div>;
}
