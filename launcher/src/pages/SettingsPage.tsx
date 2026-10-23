import { useState } from "react";
import { FolderOpen, Import, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageHeader, PageShell, Panel, SettingRow } from "@/components/common";
import { previewToast } from "@/lib/preview";
import { useUi } from "@/lib/store";

function PortInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const n = Number(value);
  const ok = /^\d+$/.test(value) && n >= 1024 && n <= 65535;
  return (
    <div className="flex flex-col items-end gap-1">
      <Input
        id={id}
        value={value}
        inputMode="numeric"
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 5))}
        aria-invalid={!ok}
        className="h-8 w-24 text-right font-mono text-xs"
      />
      {!ok && <span className="text-xs text-destructive">1024–65535</span>}
    </div>
  );
}

export function SettingsPage() {
  const appearance = useUi((s) => s.appearance);
  const setAppearance = useUi((s) => s.setAppearance);

  const [playerName, setPlayerName] = useState("georg");
  const [args, setArgs] = useState("-d3d11");
  const [headless, setHeadless] = useState(true);
  const [autoRestart, setAutoRestart] = useState(false);
  const [askAftermath, setAskAftermath] = useState(true);
  const [backendPort, setBackendPort] = useState("3551");
  const [serverPort, setServerPort] = useState("7777");
  const [lanBackend, setLanBackend] = useState(false);

  return (
    <PageShell>
      <PageHeader
        title="Einstellungen"
        description="Grundeinstellungen für Vanity. Was pro Profil anders sein soll, stellst du unter „Profile“ ein."
      />

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Panel title="Allgemein" description="Gilt für alle Profile, wenn dort nichts anderes steht.">
          <div className="flex flex-col divide-y divide-white/[0.05]">
            <SettingRow label="Spielername" hint="So heißt du in der Lobby und im Match" htmlFor="set-player">
              <Input id="set-player" value={playerName} onChange={(e) => setPlayerName(e.target.value)} className="h-8 w-40" />
            </SettingRow>
            <SettingRow label="Sprache" hint="Weitere Sprachen sind nicht geplant">
              <span className="text-sm text-muted-foreground">Deutsch</span>
            </SettingRow>
          </div>
        </Panel>

        <Panel title="Darstellung" description="Diese drei Schalter funktionieren schon jetzt.">
          <div className="flex flex-col divide-y divide-white/[0.05]">
            <SettingRow label="Animationen reduzieren" hint="Weniger Bewegung – Übergänge passieren sofort">
              <Switch
                checked={appearance.reduceMotion}
                onCheckedChange={(v) => setAppearance({ reduceMotion: v })}
              />
            </SettingRow>
            <SettingRow label="Glas-Effekt" hint="Halbdurchsichtige Flächen. Aus = schlichter und etwas schneller">
              <Switch checked={appearance.glass} onCheckedChange={(v) => setAppearance({ glass: v })} />
            </SettingRow>
            <SettingRow label="Bewegter Hintergrund" hint="Die Farbflächen hinter dem Glas treiben langsam">
              <Switch
                checked={appearance.animatedBackground}
                onCheckedChange={(v) => setAppearance({ animatedBackground: v })}
              />
            </SettingRow>
          </div>
        </Panel>

        <Panel title="Spiel" description="Wie Fortnite gestartet wird.">
          <div className="flex flex-col divide-y divide-white/[0.05]">
            <SettingRow label="Startargumente" hint="Werden an jeden Start angehängt. -d3d11 ist für 19.10 empfohlen" htmlFor="set-args">
              <Input id="set-args" value={args} onChange={(e) => setArgs(e.target.value)} className="h-8 w-40 font-mono text-xs" />
            </SettingRow>
            <SettingRow label="Server ohne Grafik" hint="Der Server-Fortnite läuft ohne Fenster und spart Leistung">
              <Switch checked={headless} onCheckedChange={setHeadless} />
            </SettingRow>
            <SettingRow label="Server nach Match neu starten" hint="Nach dem Sieg startet automatisch ein neues Match">
              <Switch checked={autoRestart} onCheckedChange={setAutoRestart} />
            </SettingRow>
            <SettingRow
              label="Vor Änderungen im Build-Ordner fragen"
              hint="Z. B. bevor GFSDK_Aftermath_Lib.dll umbenannt wird (verhindert Abstürze mit NVIDIA). Bleibt immer an"
            >
              <Switch checked={askAftermath} onCheckedChange={setAskAftermath} disabled />
            </SettingRow>
          </div>
        </Panel>

        <Panel title="Netzwerk" description="Nur ändern, wenn ein Port schon belegt ist.">
          <div className="flex flex-col divide-y divide-white/[0.05]">
            <SettingRow label="Backend-Port" hint="Hierhin leitet die Umleitungs-DLL alle Anfragen. Standard: 3551" htmlFor="set-bport">
              <PortInput id="set-bport" value={backendPort} onChange={setBackendPort} />
            </SettingRow>
            <SettingRow label="Game-Server-Port" hint="Darüber verbinden sich Spieler mit deinem Match. Standard: 7777" htmlFor="set-sport">
              <PortInput id="set-sport" value={serverPort} onChange={setServerPort} />
            </SettingRow>
            <SettingRow label="Backend im Netzwerk teilen" hint="Nur nötig, wenn Freunde dein Backend statt ihres eigenen nutzen sollen">
              <Switch checked={lanBackend} onCheckedChange={setLanBackend} />
            </SettingRow>
          </div>
        </Panel>

        <Panel title="Daten" description="Wo Vanity seine eigenen Sachen speichert.">
          <div className="flex flex-col divide-y divide-white/[0.05]">
            <SettingRow label="Speicherort" hint="Einstellungen, Profile und Logs von Vanity">
              <span className="font-mono text-xs text-muted-foreground">%APPDATA%\Vanity</span>
              <Button variant="secondary" size="sm" onClick={() => previewToast("Ordner öffnen", 2)}>
                <FolderOpen />
                Öffnen
              </Button>
            </SettingRow>
            <SettingRow label="Aus Reboot übernehmen" hint="Liest Build-Pfade aus dem Reboot Launcher. Dort wird nichts verändert">
              <Button variant="secondary" size="sm" onClick={() => previewToast("Aus Reboot übernehmen", 2)}>
                <Import />
                Übernehmen
              </Button>
            </SettingRow>
          </div>
        </Panel>

        <Panel title="Sicherheit" description="Diese Grenzen sind fest eingebaut und lassen sich nicht ausschalten.">
          <ul className="flex flex-col gap-3">
            {[
              "Nur alte Builds, die Vanity sicher erkennt – am Anfang nur 19.10.",
              "Alle Anfragen gehen an dein eigenes Backend, nie an Epics echte Server.",
              "Nichts außerhalb von Vanity wird ohne Rückfrage verändert.",
            ].map((text) => (
              <li key={text} className="flex gap-3 text-sm">
                <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="text-foreground/90">{text}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </PageShell>
  );
}
