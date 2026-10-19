import { useState } from 'react';
import {
  Button,
  Card as SurfaceCard,
  ComingSoon,
  CountUp,
  Dialog,
  Divider,
  EmptyState,
  IconButton,
  IconCheck,
  IconClose,
  IconExternal,
  IconLab,
  IconMaximize,
  IconMinimize,
  IconMoon,
  IconNetwork,
  IconQuarantine,
  IconRefresh,
  IconRestore,
  IconScan,
  IconSettings,
  IconShield,
  IconSoundOff,
  IconSoundOn,
  IconSun,
  IconTrash,
  Kbd,
  PageTransition,
  Panel,
  PhaseBadge,
  RiskBadge,
  ScoreGauge,
  SegmentedControl,
  Skeleton,
  SkeletonText,
  StatusRing,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Toggle,
  Tooltip,
  icons,
  moduleStates,
  riskLevels,
  useToast,
  type IconName,
} from '../src/index.ts';
import { Card, DemoTag, Label, Section } from './primitives.tsx';

/* ------------------------------------------------------------------ Buttons */

export function ButtonsSection() {
  const [loading, setLoading] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [muted, setMuted] = useState(false);
  return (
    <Section
      id="buttons"
      eyebrow="Komponenten"
      title="Buttons"
      description="Primär sparsam (eine Hauptaktion je Fläche), Rot nur für zerstörerische Bestätigungen. Drücken federt per transform: scale, das Leuchten beim Hover liegt auf einer eigenen Ebene."
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card className="flex flex-col gap-6 p-5">
          <Label>Varianten</Label>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" iconStart={<IconScan />}>
              Jetzt prüfen
            </Button>
            <Button variant="secondary">Details</Button>
            <Button variant="ghost">Ignorieren</Button>
            <Button variant="danger" iconStart={<IconTrash />}>
              Endgültig löschen
            </Button>
          </div>
          <Divider />
          <Label>Größen &amp; Zustände</Label>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Klein</Button>
            <Button size="md">Mittel</Button>
            <Button size="lg" iconEnd={<IconExternal />}>
              Groß
            </Button>
            <Button disabled>Gesperrt</Button>
            <Button
              variant="primary"
              loading={loading}
              onClick={() => {
                setLoading(true);
                window.setTimeout(() => setLoading(false), 1800);
              }}
            >
              {loading ? 'Prüft …' : 'Laden zeigen'}
            </Button>
          </div>
        </Card>
        <Card className="flex flex-col gap-6 p-5">
          <Label>Icon-Buttons (mit Tooltip)</Label>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-surface-2 p-1 self-start">
            <Tooltip content="Minimieren">
              <IconButton label="Minimieren" icon={<IconMinimize />} />
            </Tooltip>
            <Tooltip content={maximized ? 'Wiederherstellen' : 'Maximieren'}>
              <IconButton
                label={maximized ? 'Wiederherstellen' : 'Maximieren'}
                icon={maximized ? <IconRestore /> : <IconMaximize />}
                onClick={() => setMaximized((value) => !value)}
              />
            </Tooltip>
            <Tooltip content="Schließen">
              <IconButton label="Schließen" icon={<IconClose />} />
            </Tooltip>
          </div>
          <div className="flex items-center gap-3">
            <Tooltip
              content={muted ? 'Klänge einschalten' : 'Klänge ausschalten'}
              placement="right"
            >
              <IconButton
                variant="secondary"
                label="Klänge stumm"
                pressed={muted}
                icon={muted ? <IconSoundOff /> : <IconSoundOn />}
                onClick={() => setMuted((value) => !value)}
              />
            </Tooltip>
            <span className="text-xs text-text-muted">
              Umschalter mit <code className="font-mono text-text-subtle">aria-pressed</code>
            </span>
          </div>
          <p className="text-xs text-text-subtle">
            Icon-Buttons verlangen einen Namen (<code className="font-mono">label</code>). Tooltips
            ergänzen nur – nichts Wesentliches steht ausschließlich im Tooltip.
          </p>
        </Card>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ Flächen */

export function SurfacesSection() {
  return (
    <Section
      id="flaechen"
      eyebrow="Komponenten"
      title="Flächen, Trenner, Tasten"
      description="Drei Flächen-Ebenen mit 1-px-Rahmen und feiner Lichtkante. Glas nur für Überlagerungen, Leuchten nur für Aktives oder die Hero-Position."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {([1, 2, 3] as const).map((level) => (
          <SurfaceCard key={level} level={level} padding="md">
            <p className="font-mono text-2xs tracking-caps text-text-subtle uppercase">
              Ebene {level}
            </p>
            <p className="mt-2 text-sm text-text">surface-{level}</p>
            <p className="mt-1 text-xs text-text-muted">
              {level === 1
                ? 'Karten auf dem Hintergrund'
                : level === 2
                  ? 'Verschachtelt, Listen'
                  : 'Hervorgehoben, Auswahl'}
            </p>
          </SurfaceCard>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          eyebrow="Modul"
          title="Quarantäne"
          description="Panel mit Kopfzeile, Aktionen und Fußzeile."
          actions={
            <Button size="sm" variant="ghost" iconStart={<IconSettings />}>
              Optionen
            </Button>
          }
          footer={<p className="text-xs text-text-subtle">Fußzeile – z. B. Stand oder Hinweise</p>}
        >
          <p className="text-sm text-text-muted">
            Inhalt des Panels. Mit Überschrift ist es eine benannte Region für Screenreader.
          </p>
        </Panel>
        <div className="relative overflow-hidden rounded-xl border border-border">
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              backgroundImage:
                'radial-gradient(circle at 20% 30%, var(--aegis-accent-glow), transparent 45%), radial-gradient(circle at 80% 70%, var(--aegis-surface-3), transparent 55%)',
            }}
          />
          <div className="relative grid gap-4 p-5 sm:grid-cols-2">
            <SurfaceCard glass padding="md">
              <p className="text-sm font-medium text-text">Glas</p>
              <p className="mt-1 text-xs text-text-muted">Nur für Overlays (Palette, Menüs).</p>
            </SurfaceCard>
            <SurfaceCard glow padding="md">
              <p className="text-sm font-medium text-text">Leuchten</p>
              <p className="mt-1 text-xs text-text-muted">Nur Fokus, Aktives, Hero.</p>
            </SurfaceCard>
          </div>
        </div>
      </div>
      <Card className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
        <div className="flex items-center gap-3 text-sm text-text-muted">
          <Kbd keys={['Strg', 'K']} /> Befehlspalette
        </div>
        <div className="flex items-center gap-3 text-sm text-text-muted">
          <Kbd keys={['⌘', 'K']} /> unter macOS
        </div>
        <div className="flex items-center gap-3 text-sm text-text-muted">
          <Kbd>Esc</Kbd> Schließen
        </div>
        <Divider orientation="vertical" className="hidden h-6 sm:block" />
        <div className="min-w-48 flex-1">
          <Divider label="oder" />
        </div>
      </Card>
    </Section>
  );
}

/* ------------------------------------------------------------------- Status */

export function StatusSection() {
  const [count, setCount] = useState({ key: 0, value: 3880 });
  return (
    <Section
      id="status"
      eyebrow="Komponenten"
      title="Status, Score, Einstufung"
      description="Zustände stehen immer als Text neben Farbe und Form. „Nicht verfügbar“ ist neutral gestrichelt, „Prüft …“ rotiert per transform. Der Score zeigt ohne Messwerte bewusst „–“."
    >
      <Card className="p-5">
        <div className="flex items-center justify-between gap-4">
          <Label>Status-Ringe – alle Zustände</Label>
          <DemoTag>Beispiel</DemoTag>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-6">
          {moduleStates.map((state) => (
            <StatusRing
              key={state}
              state={state}
              label={
                {
                  ok: 'Echtzeit-Wächter',
                  warn: 'Signaturen',
                  danger: 'Härtung',
                  off: 'Sandbox',
                  unavailable: 'Web-Schutz',
                  scanning: 'Schnell-Scan',
                }[state]
              }
              sublabel={
                {
                  ok: 'Aktiv',
                  warn: 'Älter als 3 Tage',
                  danger: '2 Punkte offen',
                  off: 'Ausgeschaltet',
                  unavailable: 'Folgt in P7',
                  scanning: 'Läuft',
                }[state]
              }
            />
          ))}
        </div>
      </Card>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="flex flex-col items-center gap-3 p-5">
          <div className="flex w-full items-center justify-between">
            <Label>Score mit Wert</Label>
            <DemoTag>Beispiel</DemoTag>
          </div>
          <ScoreGauge value={72} size={180} />
        </Card>
        <Card className="flex flex-col items-center gap-3 p-5">
          <div className="flex w-full items-center justify-between">
            <Label>Score ohne Daten</Label>
            <span className="text-2xs text-text-subtle">ehrlicher Zustand</span>
          </div>
          <ScoreGauge
            value={null}
            size={180}
            unavailableHint="Bis echte Prüfergebnisse vorliegen (ab P6), zeigt AEGIS keinen Score."
          />
        </Card>
        <Card className="flex flex-col gap-4 p-5">
          <Label>Hochzählen</Label>
          <p className="text-3xl font-semibold tracking-tight text-text">
            <CountUp key={count.key} value={count.value} />
            <span className="ml-2 text-sm font-normal text-text-muted">Dateien</span>
          </p>
          <p className="text-xs text-text-muted">
            requestAnimationFrame, tabellarische Ziffern; bei „Bewegung reduzieren“ sofort der
            Endwert. Screenreader hören nur den Endwert.
          </p>
          <Button
            size="sm"
            iconStart={<IconRefresh />}
            className="self-start"
            onClick={() =>
              setCount((current) => ({
                key: current.key + 1,
                value: 1000 + ((current.value * 7) % 9000),
              }))
            }
          >
            Neu zählen
          </Button>
        </Card>
      </div>
      <Card className="mt-4 p-5">
        <Label>Risikostufen</Label>
        <div className="mt-4 flex flex-wrap gap-2">
          {riskLevels.map((level) => (
            <RiskBadge key={level} level={level} />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {riskLevels.map((level) => (
            <RiskBadge key={level} level={level} size="sm" />
          ))}
        </div>
      </Card>
    </Section>
  );
}

/* ----------------------------------------------------------------- Eingaben */

export function InputsSection() {
  const [view, setView] = useState<'list' | 'grid' | 'timeline'>('list');
  return (
    <Section
      id="eingaben"
      eyebrow="Komponenten"
      title="Schalter, Umschalter, Reiter"
      description="Nach WAI-ARIA: Schalter (switch), Radiogruppe mit Pfeiltasten, Reiter mit einem Tab-Stopp. Markierungen gleiten per transform."
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-5 p-5">
          <Label>Schalter</Label>
          <Toggle
            defaultChecked
            label="Benachrichtigungen"
            description="Hinweise bei Funden und abgeschlossenen Scans."
          />
          <Toggle label="Bewegung reduzieren" description="Folgt sonst der Systemeinstellung." />
          <Toggle label="Telemetrie" description="Gibt es in AEGIS nicht." disabled />
          <Toggle size="sm" label="Kompakte Liste" />
        </Card>
        <Card className="flex flex-col gap-5 p-5">
          <Label>Umschalter</Label>
          <SegmentedControl
            label="Ansicht"
            value={view}
            onValueChange={setView}
            options={[
              { value: 'list', label: 'Liste' },
              { value: 'grid', label: 'Kacheln' },
              { value: 'timeline', label: 'Zeitleiste' },
            ]}
          />
          <SegmentedControl
            label="Farbschema (Beispiel)"
            size="sm"
            defaultValue="dark"
            options={[
              { value: 'dark', label: 'Dunkel', icon: <IconMoon /> },
              { value: 'light', label: 'Hell', icon: <IconSun /> },
              { value: 'system', label: 'System', disabled: true },
            ]}
          />
          <p className="text-xs text-text-subtle">
            Ein Tab-Stopp, dann <Kbd size="sm">←</Kbd> <Kbd size="sm">→</Kbd> – die Auswahl folgt
            dem Fokus.
          </p>
        </Card>
      </div>
      <Card className="mt-4 p-5">
        <Label>Reiter</Label>
        <Tabs defaultValue="funde" className="mt-3">
          <TabList aria-label="Quarantäne-Bereiche">
            <Tab value="funde" icon={<IconQuarantine />}>
              Funde
            </Tab>
            <Tab value="verlauf" icon={<IconRefresh />}>
              Verlauf
            </Tab>
            <Tab value="regeln" icon={<IconSettings />}>
              Regeln
            </Tab>
            <Tab value="netz" icon={<IconNetwork />} disabled>
              Netzwerk
            </Tab>
          </TabList>
          <TabPanel value="funde">
            <p className="text-sm text-text-muted">
              Inhalt „Funde“. Pfeiltasten wechseln den Reiter, Pos1/Ende springen.
            </p>
          </TabPanel>
          <TabPanel value="verlauf">
            <p className="text-sm text-text-muted">Inhalt „Verlauf“.</p>
          </TabPanel>
          <TabPanel value="regeln">
            <p className="text-sm text-text-muted">Inhalt „Regeln“.</p>
          </TabPanel>
        </Tabs>
      </Card>
    </Section>
  );
}

/* ----------------------------------------------------------------- Overlays */

export function OverlaysSection() {
  const toast = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <Section
      id="overlays"
      eyebrow="Komponenten"
      title="Tooltip, Meldungen, Dialog"
      description="Meldungen: höflich angesagt, „Gefahr“ dringlich. Selbstständiges Ausblenden pausiert bei Maus oder Fokus – Meldungen mit Entscheidung verschwinden nie von selbst. Dialoge: Fokusfalle, Escape, Fokus zurück."
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-4 p-5">
          <Label>Meldungen (Toasts)</Label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() =>
                toast.show({
                  title: 'Signaturen aktuell',
                  description: 'Beispielmeldung.',
                  tone: 'success',
                })
              }
            >
              Erfolg
            </Button>
            <Button
              size="sm"
              onClick={() =>
                toast.show({
                  title: 'Scan geplant',
                  description: 'Beispiel: heute 18:00 Uhr.',
                  tone: 'info',
                })
              }
            >
              Info
            </Button>
            <Button
              size="sm"
              onClick={() =>
                toast.show({
                  title: 'Signaturen älter als 3 Tage',
                  description: 'Beispielmeldung.',
                  tone: 'warn',
                })
              }
            >
              Warnung
            </Button>
            <Button
              size="sm"
              onClick={() =>
                toast.show({
                  title: 'Gefährlicher Fund (Beispiel)',
                  description: 'Nichts wurde verändert. Bleibt stehen, bis du sie schließt.',
                  tone: 'danger',
                })
              }
            >
              Gefahr
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() =>
                toast.show({
                  title: 'Neue Version verfügbar (Beispiel)',
                  description: 'Installieren erst nach deiner Bestätigung.',
                  actions: [
                    {
                      label: 'Details',
                      variant: 'primary',
                      onAction: () =>
                        toast.show({
                          title: 'Beispiel – im Showcase passiert nichts.',
                          tone: 'info',
                        }),
                    },
                    { label: 'Später', variant: 'ghost', onAction: () => undefined },
                  ],
                })
              }
            >
              Mit Entscheidung
            </Button>
          </div>
          <p className="text-xs text-text-subtle">
            Meldungen mit Aktionen bleiben stehen; normale verschwinden nach 6 s (pausiert bei
            Hover/Fokus).
          </p>
        </Card>
        <Card className="flex flex-col gap-4 p-5">
          <Label>Dialog</Label>
          <p className="text-sm text-text-muted">
            Modal im Portal, Hintergrund inert, Tab bleibt im Dialog, Escape schließt, der Fokus
            kehrt zum Auslöser zurück.
          </p>
          <Button className="self-start" onClick={() => setDialogOpen(true)}>
            Dialog öffnen
          </Button>
          <Dialog
            open={dialogOpen}
            onClose={() => setDialogOpen(false)}
            eyebrow="Einstellungen"
            title="Scan-Zeitplan"
            description="Beispiel-Dialog – hier wird nichts gespeichert."
            footer={
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                  Abbrechen
                </Button>
                <Button variant="primary" onClick={() => setDialogOpen(false)}>
                  Übernehmen
                </Button>
              </div>
            }
          >
            <div className="flex flex-col gap-4">
              <Toggle
                defaultChecked
                label="Täglich prüfen"
                description="Schnell-Scan um 18:00 Uhr."
              />
              <Toggle
                label="Nur im Leerlauf"
                description="Wenn der PC 10 Minuten nicht genutzt wird."
              />
              <Tooltip content="Öffnet die Einstellungen (Beispiel)">
                <Button
                  size="sm"
                  variant="secondary"
                  className="self-start"
                  iconStart={<IconSettings />}
                >
                  Weitere Optionen
                </Button>
              </Tooltip>
            </div>
          </Dialog>
        </Card>
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------- Icons */

const iconLabels: Readonly<Record<IconName, string>> = {
  dashboard: 'Dashboard',
  scan: 'Scan',
  shield: 'Schutz',
  lab: 'Labor',
  network: 'Netzwerk',
  lock: 'Härtung',
  key: 'Tresor',
  tools: 'Tools',
  quarantine: 'Quarantäne',
  report: 'Berichte',
  settings: 'Einstellungen',
  info: 'Info',
  warning: 'Warnung',
  danger: 'Gefahr',
  check: 'OK',
  close: 'Schließen',
  minus: 'Minus',
  power: 'Ein/Aus',
  clock: 'Frist',
  panic: 'Panik',
  minimize: 'Minimieren',
  maximize: 'Maximieren',
  restore: 'Wiederherst.',
  search: 'Suche',
  chevronDown: 'Pfeil ↓',
  chevronUp: 'Pfeil ↑',
  chevronRight: 'Pfeil →',
  chevronLeft: 'Pfeil ←',
  arrowRight: 'Weiter',
  external: 'Extern',
  refresh: 'Aktualisieren',
  undo: 'Rückgängig',
  trash: 'Löschen',
  play: 'Start',
  pause: 'Pause',
  soundOn: 'Klang an',
  soundOff: 'Klang aus',
  sun: 'Hell',
  moon: 'Dunkel',
  globe: 'Sprache',
  file: 'Datei',
  process: 'Prozess',
  sliders: 'Einstellung',
  tree: 'Registrierung',
  eye: 'Verdächtig',
  gamepad: 'Spiel-Tool',
};

export function IconsSection() {
  return (
    <Section
      id="icons"
      eyebrow="Komponenten"
      title="Icons"
      description="Eigene Zeichnungen: 24-px-Raster, Strich 1,75, runde Enden, Farbe = currentColor. Dekorativ neben Text; allein stehend mit Titel."
    >
      <Card className="p-5">
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8">
          {(Object.keys(icons) as IconName[]).map((name) => {
            const Icon = icons[name];
            return (
              <li
                key={name}
                className="group flex flex-col items-center gap-2 rounded-lg border border-transparent px-2 py-3 text-text-muted hover:border-border hover:bg-surface-2 hover:text-text"
              >
                <Icon />
                <span className="w-full truncate text-center text-2xs">{iconLabels[name]}</span>
              </li>
            );
          })}
        </ul>
        <Divider className="my-5" />
        <div className="flex flex-wrap items-end gap-6 text-text">
          {[16, 20, 24, 32].map((size) => (
            <span key={size} className="flex flex-col items-center gap-2">
              <IconShield size={size} />
              <span className="font-mono text-2xs text-text-subtle tabular-nums">{size}</span>
            </span>
          ))}
          <span className="flex flex-col items-center gap-2 text-accent">
            <IconScan size={32} title="Scan" />
            <span className="font-mono text-2xs text-text-subtle">mit Titel</span>
          </span>
        </div>
      </Card>
    </Section>
  );
}

/* ------------------------------------------------------------ Leerzustände */

export function EmptySection() {
  const [page, setPage] = useState<'labor' | 'laden' | 'leer'>('labor');
  return (
    <Section
      id="leer"
      eyebrow="Komponenten"
      title="Platzhalter, Laden, Seitenwechsel"
      description="Was es noch nicht gibt, sagt die Oberfläche ehrlich („Folgt in P4“) – ohne Fantasiewerte. Seitenwechsel blenden kurz ein (opacity + 6 px), bei reduzierter Bewegung gar nicht."
    >
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl
            label="Beispielseite"
            value={page}
            onValueChange={setPage}
            options={[
              { value: 'labor', label: 'Platzhalter-Seite' },
              { value: 'laden', label: 'Lädt' },
              { value: 'leer', label: 'Leerer Zustand' },
            ]}
          />
          <PhaseBadge phase="P4" />
        </div>
        <div className="mt-5 min-h-80 rounded-lg border border-border bg-bg/60">
          <PageTransition transitionKey={page}>
            {page === 'labor' && (
              <ComingSoon
                icon={<IconLab />}
                title="Labor"
                phase="P4"
                description="Verdächtige Dateien isoliert öffnen und ihr Verhalten beobachten (Windows-Sandbox)."
              />
            )}
            {page === 'laden' && (
              <div aria-busy="true" className="flex flex-col gap-4 p-6">
                <span className="sr-only" role="status">
                  Wird geladen …
                </span>
                <div className="flex items-center gap-3">
                  <Skeleton width={40} height={40} radius="lg" />
                  <div className="flex-1">
                    <Skeleton width="40%" height={12} />
                    <Skeleton width="25%" height={10} className="mt-2" />
                  </div>
                </div>
                <SkeletonText lines={4} />
                <div className="grid grid-cols-3 gap-3">
                  <Skeleton height={64} radius="lg" />
                  <Skeleton height={64} radius="lg" />
                  <Skeleton height={64} radius="lg" />
                </div>
              </div>
            )}
            {page === 'leer' && (
              <EmptyState
                icon={<IconCheck />}
                title="Quarantäne ist leer"
                description="Es liegen keine isolierten Dateien vor."
                actions={
                  <Button size="sm" variant="secondary" iconStart={<IconScan />}>
                    Schnell-Scan
                  </Button>
                }
              />
            )}
          </PageTransition>
        </div>
      </Card>
    </Section>
  );
}
