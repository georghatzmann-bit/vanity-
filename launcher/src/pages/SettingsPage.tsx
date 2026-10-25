import { useEffect, useState } from "react";
import { FolderOpen, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageHeader, PageShell, Panel, SettingRow } from "@/components/common";
import { api, openFolder, type Settings } from "@/lib/api";
import { useApp } from "@/lib/store";

function PortInput({ id, value, onChange, min }: { id: string; value: number; onChange: (v: number) => void; min: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const n = Number(text);
  const ok = /^\d+$/.test(text) && n >= min && n <= 65535;
  return (
    <div className="flex flex-col items-end gap-1">
      <Input id={id} value={text} inputMode="numeric" onChange={(e) => { const t = e.target.value.replace(/\D/g, "").slice(0, 5); setText(t); const v = Number(t); if (v >= min && v <= 65535) onChange(v); }} aria-invalid={!ok} className="h-8 w-24 text-right font-mono text-xs" />
      {!ok && <span className="text-xs text-destructive">{min}–65535</span>}
    </div>
  );
}

export function SettingsPage() {
  const settings = useApp((s) => s.config.settings);
  const [paths, setPaths] = useState<{ config: string } | null>(null);

  useEffect(() => {
    api.paths().then(setPaths).catch(() => {});
  }, []);

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    useApp.setState((s) => ({ config: { ...s.config, settings: next } }));
    api.updateSettings(next);
  };

  return (
    <PageShell>
      <PageHeader title="Einstellungen" description="Grundeinstellungen für Vanity. Was pro Profil anders sein soll, stellst du unter „Profile“ ein." />

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Panel title="Allgemein" description="Gilt für alle Profile, wenn dort nichts anderes steht.">
          <div className="flex flex-col divide-y divide-white/[0.05]">
            <SettingRow label="Spielername" hint="So heißt du in der Lobby und im Match" htmlFor="set-player">
              <Input id="set-player" defaultValue={settings.playerName} onBlur={(e) => update({ playerName: e.target.value })} className="h-8 w-40" />
            </SettingRow>
            <SettingRow label="Sprache" hint="Weitere Sprachen sind nicht geplant"><span className="text-sm text-muted-foreground">Deutsch</span></SettingRow>
          </div>
        </Panel>

        <Panel title="Darstellung" description="Diese drei Schalter wirken sofort.">
          <div className="flex flex-col divide-y divide-white/[0.05]">
            <SettingRow label="Animationen reduzieren" hint="Weniger Bewegung – Übergänge passieren sofort"><Switch checked={settings.reduceMotion} onCheckedChange={(v) => update({ reduceMotion: v })} /></SettingRow>
            <SettingRow label="Glas-Effekt" hint="Halbdurchsichtige Flächen. Aus = schlichter und etwas schneller"><Switch checked={settings.glass} onCheckedChange={(v) => update({ glass: v })} /></SettingRow>
            <SettingRow label="Bewegter Hintergrund" hint="Die Farbflächen hinter dem Glas treiben langsam"><Switch checked={settings.animatedBackground} onCheckedChange={(v) => update({ animatedBackground: v })} /></SettingRow>
          </div>
        </Panel>

        <Panel title="Spiel" description="Wie Fortnite gestartet wird.">
          <div className="flex flex-col divide-y divide-white/[0.05]">
            <SettingRow label="Startargumente" hint="Werden an jeden Start angehängt. -d3d11 ist bis Chapter 5 empfohlen; ab 33.00 lässt Vanity es automatisch weg" htmlFor="set-args">
              <Input id="set-args" defaultValue={settings.launchArgs} onBlur={(e) => update({ launchArgs: e.target.value })} className="h-8 w-40 font-mono text-xs" />
            </SettingRow>
            <SettingRow label="Server ohne Grafik" hint="Der Server-Fortnite läuft ohne Fenster und spart Leistung"><Switch checked={settings.headlessServer} onCheckedChange={(v) => update({ headlessServer: v })} /></SettingRow>
            <SettingRow label="Server nach Match neu starten" hint="Nach dem Sieg startet automatisch ein neues Match"><Switch checked={settings.autoRestart} onCheckedChange={(v) => update({ autoRestart: v })} /></SettingRow>
          </div>
        </Panel>

        <Panel title="Netzwerk" description="Nur ändern, wenn ein Port schon belegt ist.">
          <div className="flex flex-col divide-y divide-white/[0.05]">
            <SettingRow label="Backend-Port" hint="Hierhin leitet die Umleitung alle Anfragen. Standard: 3551" htmlFor="set-bport"><PortInput id="set-bport" value={settings.backendPort} onChange={(v) => update({ backendPort: v })} min={1024} /></SettingRow>
            <SettingRow label="Matchmaker-Port" hint="Für Match-Start und Freunde. Standard: 80" htmlFor="set-mport"><PortInput id="set-mport" value={settings.matchmakerPort} onChange={(v) => update({ matchmakerPort: v })} min={1} /></SettingRow>
            <SettingRow label="Game-Server-Port" hint="Darüber verbinden sich Spieler mit deinem Match. Standard: 7777" htmlFor="set-sport"><PortInput id="set-sport" value={settings.gameServerPort} onChange={(v) => update({ gameServerPort: v })} min={1024} /></SettingRow>
            <SettingRow label="Backend im Netzwerk teilen" hint="Nur nötig, wenn Freunde dein Backend statt ihres eigenen nutzen sollen"><Switch checked={settings.shareBackendLan} onCheckedChange={(v) => update({ shareBackendLan: v })} /></SettingRow>
          </div>
        </Panel>

        <Panel title="Daten" description="Wo Vanity seine eigenen Sachen speichert.">
          <SettingRow label="Speicherort" hint="Einstellungen, Profile und Logs von Vanity">
            <span className="font-mono text-xs text-muted-foreground">%APPDATA%\Vanity</span>
            <Button variant="secondary" size="sm" onClick={() => paths && openFolder(paths.config)}><FolderOpen />Öffnen</Button>
          </SettingRow>
        </Panel>

        <Panel title="Sicherheit" description="Diese Grenzen sind fest eingebaut.">
          <ul className="flex flex-col gap-3">
            {["Nur Builds, die du selbst hast: Vanity startet alle Versionen von 1.7 bis 30.x, getestet ist 19.10.", "Alle Anfragen gehen an dein eigenes Backend, nie an Epics echte Server.", "Nichts außerhalb von Vanity wird ohne Rückfrage verändert."].map((text) => (
              <li key={text} className="flex gap-3 text-sm"><Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="text-foreground/90">{text}</span></li>
            ))}
          </ul>
        </Panel>
      </div>
    </PageShell>
  );
}
