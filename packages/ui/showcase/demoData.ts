/**
 * Beispiel- und Demo-Daten **nur für den Showcase**. Nichts davon ist gemessen; die Werte
 * dienen ausschließlich der Gestaltung und sind in der Oberfläche als „Beispiel“ bzw.
 * „Demo-Daten (Showcase)“ gekennzeichnet. Die App zeigt nur echte Messwerte.
 */
import type { ConsentPlan, ConsentTarget, ModuleState, RiskLevel } from '../src/index.ts';

/** Eindeutige Plan-ID je Öffnen (der Dialog beginnt dann von vorn). */
let planCounter = 0;
function nextPlanId(prefix: string): string {
  planCounter += 1;
  return `beispiel-${prefix}-${planCounter}`;
}

const RLO = '\u202E';

/** Beispiel: EICAR-Testdatei in die Quarantäne (umkehrbar). */
export function quarantinePlan(now: number): ConsentPlan {
  return {
    id: nextPlanId('quarantaene'),
    kindLabel: 'In Quarantäne verschieben',
    severity: 'dangerous',
    targets: [
      { type: 'file', path: 'C:\\Users\\Beispiel\\Downloads\\eicar-testdatei.com' },
      {
        type: 'file',
        path: `C:\\Users\\Beispiel\\Downloads\\Projekte\\Angebote 2026\\Entwürfe\\Rechnung_Oktober_${RLO}fdp.exe`,
      },
    ],
    what: 'Beide Dateien werden verschlüsselt in die Quarantäne verschoben und sind danach nicht mehr ausführbar.',
    why: 'Die erste Datei entspricht der Signatur „EICAR-Testdatei“ (harmlose Prüfdatei). Die zweite tarnt ihre Endung mit einem unsichtbaren Steuerzeichen.',
    consequence:
      'Die Dateien verschwinden aus „Downloads“. Programme, die sie öffnen wollen, finden sie nicht mehr.',
    undo: {
      type: 'reversible',
      how: 'Jederzeit über Quarantäne → Wiederherstellen an den ursprünglichen Ort.',
    },
    expiresAt: now + 10 * 60_000,
  };
}

/** Beispiel: Prozess beenden (nicht umkehrbar). */
export function terminatePlan(now: number): ConsentPlan {
  return {
    id: nextPlanId('beenden'),
    kindLabel: 'Prozess beenden',
    severity: 'suspicious',
    targets: [
      {
        type: 'process',
        pid: 4711,
        image_path: 'C:\\Users\\Beispiel\\AppData\\Local\\Temp\\updater_helper.exe',
      },
    ],
    what: 'Der Prozess „updater_helper.exe“ wird sofort beendet.',
    why: 'Er startet sich alle 30 Sekunden neu und schreibt in den Autostart (Heuristik, kein sicherer Nachweis).',
    consequence:
      'Nicht gespeicherte Daten dieses Programms gehen verloren. Andere Programme laufen weiter.',
    undo: {
      type: 'irreversible',
      warning: 'Ein beendeter Prozess lässt sich nicht fortsetzen – nur neu starten.',
    },
    expiresAt: now + 10 * 60_000,
  };
}

/** Beispiel: endgültig löschen (nicht umkehrbar, zweite Bestätigung). */
export function deletePlan(now: number): ConsentPlan {
  return {
    id: nextPlanId('loeschen'),
    kindLabel: 'Endgültig löschen',
    severity: 'dangerous',
    targets: deleteTargets,
    what: 'Die Datei wird aus der Quarantäne endgültig gelöscht.',
    why: 'Du hast „Endgültig löschen“ gewählt. Die Datei liegt seit 30 Tagen in der Quarantäne.',
    consequence: 'Der Speicherplatz wird frei. Die Datei ist danach nicht mehr vorhanden.',
    undo: {
      type: 'irreversible',
      warning: 'Endgültig gelöschte Dateien lassen sich nicht wiederherstellen.',
    },
    expiresAt: now + 2 * 60_000,
  };
}

export const deleteTargets: readonly ConsentTarget[] = [
  { type: 'file', path: 'C:\\Users\\Beispiel\\Downloads\\eicar-testdatei.com' },
];

/** Beispiel mit kurzer Frist, um den Ablauf zu zeigen. */
export function shortDeadlinePlan(now: number): ConsentPlan {
  return {
    id: nextPlanId('frist'),
    kindLabel: 'Einstellung ändern',
    severity: 'info',
    targets: [
      {
        type: 'registry_value',
        key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        name: 'BeispielUpdater',
      },
    ],
    what: 'Der Autostart-Eintrag „BeispielUpdater“ wird deaktiviert (nicht gelöscht).',
    why: 'Der Eintrag verweist auf eine Datei, die es nicht mehr gibt.',
    consequence:
      'Beim nächsten Anmelden wird nichts gestartet. Es erscheint keine Fehlermeldung mehr.',
    undo: { type: 'reversible', how: 'Über Tools → Autostart wieder aktivieren.' },
    expiresAt: now + 15_000,
    parameters: [{ label: 'Neuer Wert', value: 'deaktiviert' }],
  };
}

export interface DemoModule {
  readonly label: string;
  readonly state: ModuleState;
  readonly sublabel: string;
}

/** Demo-Daten (Showcase) für die Dashboard-Komposition. */
export const demoModules: readonly DemoModule[] = [
  { label: 'Echtzeit-Wächter', state: 'ok', sublabel: 'Aktiv seit 08:12' },
  { label: 'Signaturen', state: 'warn', sublabel: 'Älter als 3 Tage' },
  { label: 'Schnell-Scan', state: 'scanning', sublabel: '1.204 von 3.880 Dateien' },
  { label: 'Härtung', state: 'danger', sublabel: '2 Punkte offen' },
  { label: 'Sandbox', state: 'off', sublabel: 'Ausgeschaltet' },
  { label: 'Web-Schutz', state: 'unavailable', sublabel: 'Folgt in P7' },
];

export interface DemoEvent {
  readonly time: string;
  readonly title: string;
  readonly detail: string;
  readonly level: RiskLevel;
}

export const demoEvents: readonly DemoEvent[] = [
  {
    time: '09:41',
    title: 'eicar-testdatei.com',
    detail: 'In Quarantäne (nach Freigabe)',
    level: 'dangerous',
  },
  {
    time: '09:12',
    title: 'remote_support.exe',
    detail: 'Fernwartung – gemeldet, nichts verändert',
    level: 'risky',
  },
  { time: '08:55', title: 'trainer_v3.exe', detail: 'Spiel-Tool – ignoriert', level: 'game' },
  { time: '08:12', title: 'Schnell-Scan', detail: 'Nichts gefunden', level: 'clean' },
];

/** Demo-Wert für den Score – ausdrücklich erfunden. */
export const demoScore = 82;
