import { useState } from "react";
import { motion } from "motion/react";
import { Hammer, Eye, Keyboard, LogIn, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  KeyCaptureButton,
  PageHeader,
  PageShell,
  Panel,
  PhaseNote,
  Reveal,
  SettingRow,
  ValueChip,
} from "@/components/common";
import { previewToast } from "@/lib/preview";
import { cn } from "@/lib/utils";

interface MenuSettings {
  editOnRelease: boolean;
  resetOnRelease: boolean;
  disablePreEdits: boolean;
  fov: number;
  console: boolean;
  menuKey: string;
  joinKey: string;
  consoleKey: string;
}

export function IngameMenuPage() {
  const [s, setS] = useState<MenuSettings>({
    editOnRelease: true,
    resetOnRelease: true,
    disablePreEdits: false,
    fov: 80,
    console: true,
    menuKey: "F9",
    joinKey: "F5",
    consoleKey: "F8",
  });
  const [joinIp, setJoinIp] = useState("");
  const set = <K extends keyof MenuSettings>(key: K) => (value: MenuSettings[K]) =>
    setS((prev) => ({ ...prev, [key]: value }));

  return (
    <PageShell>
      <PageHeader
        title="Ingame-Menü"
        description={`Das Menü im Spiel öffnest du mit ${s.menuKey}. Was du hier einstellst, gilt beim nächsten Start – und lässt sich im Spiel jederzeit ändern.`}
      />
      <PhaseNote phase={5}>Das Menü im Spiel kommt in Phase 5. Rechts siehst du schon, wie es aussehen wird.</PhaseNote>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex flex-col gap-6">
          <Panel title="Bauen & Editieren" description="Für schnelleres Editieren wie in Arena.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Edit on Release" hint="Der Edit wird fertig, sobald du die Edit-Taste loslässt">
                <Switch checked={s.editOnRelease} onCheckedChange={set("editOnRelease")} />
              </SettingRow>
              <SettingRow label="Reset on Release" hint="Zurücksetzen passiert sofort beim Loslassen">
                <Switch checked={s.resetOnRelease} onCheckedChange={set("resetOnRelease")} />
              </SettingRow>
              <SettingRow label="Disable Pre-Edits" hint="Verhindert, dass du aus Versehen das durchsichtige Vorschau-Bauteil editierst">
                <Switch checked={s.disablePreEdits} onCheckedChange={set("disablePreEdits")} />
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Sicht" description="Wie viel du vom Spielfeld siehst.">
            <SettingRow label="Sichtfeld (FOV)" hint="80 ist der Standard. Höher = mehr Überblick, aber kleinere Gegner">
              <Slider className="w-44" min={60} max={120} step={1} value={[s.fov]} onValueChange={([v]) => set("fov")(v)} />
              <ValueChip>{s.fov}°</ValueChip>
            </SettingRow>
          </Panel>

          <Panel title="Tasten" description="Klick auf eine Taste und drück dann die neue. Esc bricht ab.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Menü öffnen" hint="Öffnet und schließt das Ingame-Menü">
                <KeyCaptureButton value={s.menuKey} onChange={set("menuKey")} />
              </SettingRow>
              <SettingRow label="Schnell beitreten" hint="Verbindet dich mit dem Server auf diesem PC">
                <KeyCaptureButton value={s.joinKey} onChange={set("joinKey")} />
              </SettingRow>
              <SettingRow label="Konsole" hint="Öffnet die Unreal-Konsole für Befehle">
                <KeyCaptureButton value={s.consoleKey} onChange={set("consoleKey")} />
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Konsole" description="Für Befehle wie „cheat give“ auf deinem eigenen Server.">
            <SettingRow
              label="Konsole an"
              hint="Läuft bei Vanity im Takt des Spiels – dadurch kein Absturz wie bei Reboots console.dll mit 19.40"
            >
              <Switch checked={s.console} onCheckedChange={set("console")} />
            </SettingRow>
          </Panel>

          <Panel title="Beitreten" description="Direkt aus dem Spiel auf einen Server wechseln.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Join Local Host" hint="Server auf diesem PC (127.0.0.1)">
                <Button variant="secondary" size="sm" onClick={() => previewToast("Join Local Host", 5)}>
                  <LogIn />
                  Beitreten
                </Button>
              </SettingRow>
              <SettingRow label="Join per IP" hint="IP vom Freund, z. B. über Tailscale">
                <Input
                  value={joinIp}
                  onChange={(e) => setJoinIp(e.target.value)}
                  placeholder="100.101.12.7"
                  className="h-8 w-40 font-mono text-xs"
                />
                <Button variant="secondary" size="sm" disabled={!joinIp} onClick={() => previewToast("Join per IP", 5)}>
                  Los
                </Button>
              </SettingRow>
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

/** Nachbau des künftigen F9-Menüs über einer angedeuteten Spielszene. */
function OverlayPreview({ s }: { s: MenuSettings }) {
  const [tab, setTab] = useState(0);
  const tabs = [
    { icon: Hammer, label: "Bauen" },
    { icon: Eye, label: "Sicht" },
    { icon: Keyboard, label: "Tasten" },
    { icon: SquareTerminal, label: "Konsole" },
  ];

  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground">Vorschau im Spiel</p>
      <div className="relative overflow-hidden rounded-xl bg-[linear-gradient(180deg,#5f8fd6_0%,#9db9e6_45%,#5e7f4a_46%,#3f5a33_100%)] p-6">
        {/* angedeutete Spielszene */}
        <div className="absolute right-6 bottom-10 h-20 w-14 rounded-sm bg-[#8a6a45]/80" />
        <div className="absolute bottom-10 left-10 h-12 w-24 rounded-sm bg-[#6b6b6b]/70" />
        <div className="absolute inset-0 bg-black/25" />

        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2 }}
          className="relative rounded-xl bg-[#0f1115]/85 p-4 shadow-2xl backdrop-blur-xl"
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold tracking-widest">VANITY</p>
            <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px]">{s.menuKey}</span>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1 rounded-lg bg-white/[0.04] p-1">
            {tabs.map((t, i) => (
              <button
                key={t.label}
                type="button"
                onClick={() => setTab(i)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-md py-2 text-[11px] transition-colors",
                  tab === i ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <t.icon className="size-4" />
                {t.label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex min-h-36 flex-col gap-2">
            {tab === 0 && (
              <>
                <MiniToggle label="Edit on Release" on={s.editOnRelease} />
                <MiniToggle label="Reset on Release" on={s.resetOnRelease} />
                <MiniToggle label="Disable Pre-Edits" on={s.disablePreEdits} />
              </>
            )}
            {tab === 1 && (
              <div className="rounded-md bg-white/[0.04] px-3 py-2 text-xs">
                <div className="flex justify-between">
                  <span>FOV</span>
                  <span className="font-mono">{s.fov}°</span>
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${((s.fov - 60) / 60) * 100}%` }} />
                </div>
              </div>
            )}
            {tab === 2 && (
              <>
                <MiniKey label="Menü" k={s.menuKey} />
                <MiniKey label="Schnell beitreten" k={s.joinKey} />
                <MiniKey label="Konsole" k={s.consoleKey} />
              </>
            )}
            {tab === 3 && (
              <>
                <MiniToggle label="Konsole" on={s.console} />
                <div className="rounded-md bg-black/40 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                  &gt; cheat give pump
                </div>
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
