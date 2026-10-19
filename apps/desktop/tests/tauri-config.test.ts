// @vitest-environment node
/**
 * Sicherheits- und Lokalisierungs-Invarianten der Tauri-Konfiguration (src-tauri/).
 * Die CSP selbst prüft src/csp.test.ts, die Laufzeit-Wirkung e2e/security.spec.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import tauriConfig from '../src-tauri/tauri.conf.json' with { type: 'json' };
import viteConfig from '../vite.config.ts';

const srcTauri = new URL('../src-tauri/', import.meta.url);

/**
 * Jede IPC-Berechtigung des Hauptfensters – mit Begründung (ausführlich in apps/desktop/README.md,
 * gleiche Reihenfolge wie `capabilities/default.json`). Nie ein ganzes `:default`-Bündel
 * eintragen. Welcher Aufruf der Oberfläche welches Recht braucht, prüft `ipc-contract.test.ts`.
 */
const JUSTIFIED_PERMISSIONS: Readonly<Record<string, string>> = {
  'core:window:allow-minimize': 'Knopf „Minimieren“ der eigenen Titelleiste',
  'core:window:allow-toggle-maximize': 'Knopf „Maximieren / Wiederherstellen“',
  'core:window:allow-internal-toggle-maximize':
    'Doppelklick auf die Titelleiste (Tauris Skript für data-tauri-drag-region)',
  'core:window:allow-is-maximized': 'Symbol des Maximieren-Knopfs passend zum Zustand (lesend)',
  'core:window:allow-start-dragging': 'Fenster an der Titelleiste verschieben',
  'core:window:allow-close': 'Schließen-Knopf ohne Infobereich: beendet AEGIS',
  'core:event:allow-listen': 'tauri://resize und aegis://navigate empfangen (nie senden)',
  'core:event:allow-unlisten': 'Empfänger wieder abmelden',
  'allow-app-info': 'App-Befehl app_info (Version, Build-Profil, Plattform, Infobereich; lesend)',
  'allow-hide-to-tray':
    'App-Befehl hide_to_tray: Schließen-Knopf mit „Beim Schließen in den Infobereich“ – versteckt nur mit Tray-Symbol',
  'allow-service-scan': 'Dienst: Dateien/Ordner prüfen (nur lesend)',
  'allow-service-list-quarantine': 'Dienst: Quarantäne anzeigen (nur lesend)',
  'allow-service-propose-quarantine': 'Dienst: Isolieren vorschlagen (ausgeführt erst nach Ja)',
  'allow-service-propose-restore': 'Dienst: Wiederherstellen vorschlagen',
  'allow-service-propose-delete': 'Dienst: endgültiges Löschen vorschlagen (zwei Bestätigungen)',
  'allow-service-decide': 'Dienst: Antwort aus dem Freigabe-Dialog (mit Einmal-Nonce)',
  'allow-service-confirm-second': 'Dienst: zweite Bestätigung vor endgültigem Löschen',
  'allow-service-list-trust': 'Dienst: eigene Vertrauensliste anzeigen (nur lesend)',
  'allow-service-revoke-trust': 'Dienst: Vertrauens-Eintrag widerrufen (macht AEGIS strenger)',
  'allow-service-watch-poll': 'Dienst: Meldungen des Echtzeit-Wächters abholen (nur lesend)',
  'allow-service-set-gaming': 'Dienst: Gaming-Modus an/aus (pausiert nur Hinweise, max. 4 h)',
  'allow-service-history': 'Dienst: eigener Verlauf für Berichte (nur lesend)',
  'allow-service-get-schedule': 'Dienst: eigener Zeitplan und Update-Einstellung (nur lesend)',
  'allow-service-set-schedule': 'Dienst: geplanten Scan setzen (prüft und meldet nur)',
  'allow-service-set-clamav-update': 'Dienst: tägliches ClamAV-Signatur-Update an/aus',
  'allow-service-lab-status': 'Dienst: Labor-Zustand und eigene Läufe (nur lesend)',
  'allow-service-propose-lab-run': 'Dienst: Labor-Lauf vorschlagen (Start nur nach „Ja“)',
  'allow-service-lab-screenshot': 'Dienst: Bildschirmfoto eines eigenen Laufs (nur lesend)',
  'allow-service-lab-report': 'Dienst: Verhaltensbericht eines eigenen Laufs (nur lesend)',
  'allow-service-propose-enable-sandbox':
    'Dienst: „Windows Sandbox einschalten“ vorschlagen (nur Admin, nur nach „Ja“)',
  'allow-service-propose-process-action':
    'Dienst: Programm beenden/anhalten/fortsetzen vorschlagen (nur nach „Ja“)',
  'allow-service-ransom-status': 'Dienst: eigene Köderdateien des Ransomware-Schutzes (nur lesend)',
  'allow-service-propose-baits':
    'Dienst: Köderdateien anlegen/entfernen vorschlagen (nur nach „Ja“)',
  'allow-service-set-protected-folders':
    'Dienst: eigene Schutzordner der Ransomware-Erkennung setzen (nur Beobachtung)',
  'allow-service-backup-status': 'Dienst: Zustand der eigenen Rückfall-Kopien (nur lesend)',
  'allow-service-hardening-status': 'Dienst: Systemzustand und Sicherheits-Score (nur lesend)',
  'allow-service-propose-hardening-fix':
    'Dienst: Härtungs-Schritt vorschlagen (feste Liste; ausgeführt erst nach „Ja“, mit Rückgängig)',
  'allow-service-propose-hardening-undo':
    'Dienst: gemerkten Stand vor dem Beheben wiederherstellen vorschlagen (erst nach „Ja“)',
  'allow-service-persistence-status': 'Dienst: Autostart-Einträge lesen und bewerten (nur lesend)',
  'allow-service-propose-autorun-disable':
    'Dienst: Autostart-Eintrag deaktivieren vorschlagen (erst nach „Ja“, mit Rückgängig)',
  'allow-service-propose-backup':
    'Dienst: Rückfall-Kopien ein-/ausschalten vorschlagen (nur nach „Ja“)',
  'allow-service-propose-backup-restore':
    'Dienst: Rückfall-Kopie zurückholen vorschlagen (nur nach „Ja“, nie überschreibend)',
  'allow-service-propose-backup-export':
    'Dienst: Rückfall-Kopien in einen Ordner exportieren vorschlagen (nur nach „Ja“)',
  'allow-service-propose-backup-prune':
    'Dienst: alte Rückfall-Kopien ausdünnen vorschlagen (nur nach „Ja“ + zweiter Bestätigung)',
  'allow-open-windows-security':
    'Windows-Sicherheit „Ransomware-Schutz“ öffnen (fester Aufruf, ändert nichts)',
  'allow-open-windows-settings':
    'Windows-Einstellungsseite aus fester Liste öffnen (Update, Verschlüsselung, Virenschutz)',
  'allow-service-memory-scan': 'Dienst: Speicher-Scan eigener Programme (nur lesend)',
  'allow-service-emergency-scan':
    'Dienst: Notfall-Scan (Autostarts, Downloads, Temp, AppData, Programme; nur lesend)',
  'allow-service-propose-restore-many':
    'Dienst: „Alles rückgängig“ – mehrere Einträge wiederherstellen vorschlagen (nur nach „Ja“)',
  'allow-service-panic-status': 'Dienst: Zustand des Panic-Buttons (nur lesend)',
  'allow-service-propose-panic':
    'Dienst: Netz trennen/wieder verbinden vorschlagen (nur nach „Ja“)',
  'allow-service-safe-status': 'Dienst: Zustand des eigenen Datei-Safes (nur lesend)',
  'allow-service-propose-safe-setup':
    'Dienst: Datei-Safe anlegen vorschlagen (Passwort nur an den Dienst, nur nach „Ja“)',
  'allow-service-safe-unlock':
    'Dienst: Datei-Safe entsperren (Schlüssel bleibt nur im Dienst, verändert nichts)',
  'allow-service-safe-lock': 'Dienst: Datei-Safe sperren (Schlüssel verwerfen)',
  'allow-service-propose-safe-store':
    'Dienst: Dateien in den Datei-Safe legen vorschlagen (nur nach „Ja“)',
  'allow-service-propose-safe-retrieve':
    'Dienst: Eintrag aus dem Datei-Safe holen vorschlagen (nur nach „Ja“)',
  'allow-lab-capture-windows': 'Fensterfotos eines eigenen Mini-Sandbox-Laufs (nur lesend)',
  'allow-export-report':
    'Bericht als HTML speichern – Inhalt aus Rust, Ort nur über den Speichern-Dialog',
  'dialog:allow-open': 'Datei-/Ordnerauswahl für Scans (nur Auswahl)',
};

/**
 * Bewusst nie gewährt: direktes Verstecken (ohne Tray-Symbol bliebe AEGIS unsichtbar ohne
 * Rückweg – das entscheidet Rust in `hide_to_tray`), Nach-vorn-Holen (nur Rust: Tray, zweiter
 * Start), Fenster zerstören/anlegen.
 */
const NEVER_GRANTED = [
  'core:window:allow-hide',
  'core:window:allow-show',
  'core:window:allow-set-focus',
  'core:window:allow-destroy',
  'core:window:allow-create',
] as const;

interface Capability {
  readonly identifier?: unknown;
  readonly windows?: unknown;
  readonly webviews?: unknown;
  readonly remote?: unknown;
  readonly permissions?: unknown;
}

function capabilities(): { file: string; capability: Capability }[] {
  const dir = new URL('capabilities/', srcTauri);
  return readdirSync(dir)
    .filter((file) => /\.(?:json|toml)$/i.test(file))
    .map((file) => {
      expect(file, 'Capabilities nur als JSON (prüfbar)').toMatch(/\.json$/i);
      return {
        file,
        capability: JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Capability,
      };
    });
}

function permissionId(entry: unknown): string {
  if (typeof entry === 'string') {
    return entry;
  }
  if (typeof entry === 'object' && entry !== null && 'identifier' in entry) {
    return String((entry as { identifier: unknown }).identifier);
  }
  throw new TypeError(`unbekannter Berechtigungs-Eintrag: ${JSON.stringify(entry)}`);
}

describe('Capabilities (IPC-Rechte)', () => {
  const all = capabilities();

  it('gibt es genau für das Hauptfenster und nie für entfernte Seiten', () => {
    expect(all.map(({ file }) => file)).toEqual(['default.json']);
    for (const { file, capability } of all) {
      expect(capability.windows, file).toEqual(['main']);
      expect(capability.webviews, file).toBeUndefined();
      expect(capability.remote, `${file}: keine IPC für Remote-URLs`).toBeUndefined();
    }
  });

  it('gewährt genau die einzeln begründeten Berechtigungen, nie ein :default-Bündel', () => {
    for (const { file, capability } of all) {
      expect(Array.isArray(capability.permissions), file).toBe(true);
      const ids = (capability.permissions as unknown[]).map(permissionId);
      for (const id of ids) {
        expect(id, `${file}: ${id}`).not.toMatch(/(?:^|:)default$/);
        expect(Object.keys(JUSTIFIED_PERMISSIONS), `${file}: ${id} ist nicht begründet`).toContain(
          id,
        );
      }
      expect(ids).toEqual(Object.keys(JUSTIFIED_PERMISSIONS));
      for (const id of NEVER_GRANTED) {
        expect(ids, `${file}: ${id}`).not.toContain(id);
      }
    }
  });
});

describe('App-Fenster', () => {
  it('kein globales Tauri-Objekt, eingefrorener Prototyp', () => {
    expect(tauriConfig.app.withGlobalTauri).toBe(false);
    expect(tauriConfig.app.security.freezePrototype).toBe(true);
  });

  it('main.rs registriert den Navigations-Wächter (keine fremden Seiten im Fenster)', () => {
    const main = readFileSync(new URL('src/main.rs', srcTauri), 'utf8');
    expect(main).toMatch(/^mod navigation;$/m);
    expect(main).toMatch(/\.plugin\(\s*navigation::guard\(/);
  });

  it('main.rs beendet die App beim Schließen des Hauptfensters (kein unsichtbarer Prozess)', () => {
    const main = readFileSync(new URL('src/main.rs', srcTauri), 'utf8');
    const production = main.slice(0, main.indexOf('#[cfg(test)]'));
    expect(production).toContain('.on_window_event(window::on_window_event)');
  });
});

describe('Build', () => {
  it('bettet keine Datei als data:-URI ein (CSP: img-src/font-src nur self)', () => {
    const limit = viteConfig.build?.assetsInlineLimit;
    if (typeof limit === 'function') {
      for (const file of ['logo.svg', 'icon.png', 'inter.woff2', 'x.webp']) {
        expect(limit(file, Buffer.from('x')), file).toBe(false);
      }
    } else {
      expect(limit).toBe(0);
    }
  });
});

describe('Installer (NSIS)', () => {
  const nsis = tauriConfig.bundle.windows.nsis as {
    installMode?: string;
    languages?: string[];
  };

  it('installiert pro Nutzer (kein Admin für die App)', () => {
    expect(nsis.installMode).toBe('currentUser');
  });

  it('spricht Deutsch zuerst, Englisch als zweite Sprache (Rückfall: Deutsch)', () => {
    expect(nsis.languages?.[0]).toBe('German');
    expect(nsis.languages).toContain('English');
  });
});
