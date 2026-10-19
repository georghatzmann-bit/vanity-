# Architektur

## Überblick

```
┌──────────────────────────── Nutzer-Sitzung (normale Rechte) ────────────────────────────┐
│  AEGIS Desktop (Tauri 2)                                                                 │
│   React-UI (WebView2) ──IPC──► Rust-Kern der App ──Named Pipe (ACL)──┐                   │
│   · zeigt ActionPlans, holt „Ja/Nein/Ignorieren/Vertrauen“ ein        │                   │
│   · Tray-Widget, Befehlspalette, Benachrichtigungen                   │                   │
│  Browser-Erweiterungen (MV3) ──Native Messaging (HKCU)──► vault-host  │                   │
└───────────────────────────────────────────────────────────────────────┼──────────────────┘
                                                                        ▼
┌──────────────────────────── aegis-service (Windows-Dienst) ──────────────────────────────┐
│  Pipe-Server (nur interaktiver Nutzer + SYSTEM)                                          │
│  ConsentGate  ◄── jede Veränderung braucht eine Approval (crates/core)                   │
│  Wächter (notify + ETW), Zeitpläne, Scans, Quarantäne, Prüfprotokoll (Hash-Kette)        │
│     │                │                         │                                         │
│     ▼                ▼                         ▼                                         │
│  Parser-Kindprozesse   clamd/clamscan (GPL,     Sandbox-Starter                           │
│  (niedrige Integrität, getrennter Prozess)      (Windows Sandbox .wsb / Mini-Sandbox)     │
│  Job-Objekt, kein Netz)                                                                   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

## Schichten

| Schicht | Ort | Aufgabe |
| --- | --- | --- |
| UI | `apps/desktop/src`, `packages/ui` | Darstellung, Bestätigungsdialoge, keine Sicherheitslogik |
| App-Kern | `apps/desktop/src-tauri` | Tauri-Befehle, Pipe-Client, Fenster/Tray |
| Dienst | `crates/service` | Langläufer: Wächter, Scans, Zeitpläne; führt bestätigte Pläne aus |
| Grundtypen | `crates/core` | Goldene Regel, `ActionPlan`, `Approval`, Prüfprotokoll, Risikostufen |
| Fachmodule | `crates/engine`, `sandbox`, `hardening`, `netwatch`, `vault-core`, `tools`, `defender-switch` | reine Bibliotheken; verändernde Funktionen verlangen `Approval` |

## Ablauf einer verändernden Aktion (Goldene Regel)

1. Ein Modul erkennt etwas (z. B. Fund) und erzeugt einen **`ActionPlan`**:
   Was genau (Ziele), Warum, Was passiert dann, Rückgängig-Weg, Schweregrad.
2. `ConsentGate::propose(plan)` legt ihn als „ausstehend“ ab (Frist, Standard: nichts tun) und
   liefert eine **Plan-ID + Digest** (SHA-256 über die kanonische Plan-Darstellung).
3. Die UI zeigt den Plan; der Nutzer wählt **Ja, ausführen / Nein / Ignorieren / Vertrauen**.
4. Nur „Ja“ ergibt über `ConsentGate::decide(id, digest, decision)` eine **`Approval`**
   (nicht kopierbar, nicht klonbar, einmalig, an den Digest gebunden, mit Ablaufzeit).
5. Das Modul führt mit `execute(plan, approval)` aus; die `Approval` wird dabei verbraucht.
   Jede Ausführung schreibt ins **Prüfprotokoll** und erzeugt einen **Rückgängig-Eintrag**.
6. Endgültiges Löschen verlangt zusätzlich eine zweite, getrennte Bestätigung
   (`PermanentDeleteApproval`, frühestens nach einer Mindestwartezeit).

Abgelaufene oder unbeantwortete Pläne verfallen ohne Wirkung.

## Datenhaltung (geplant)

- `%ProgramData%\AEGIS\` (Dienst): Quarantäne (verschlüsselt), Prüfprotokoll, Signaturen, Regeln.
- `%LOCALAPPDATA%\AEGIS\` (Nutzer): UI-Einstellungen, Tresor-Datei, Layouts.
- SQLite (`rusqlite`) für Funde, Zeitleiste, Whitelist (Hash + Pfad + Grund + Datum).

## Prozessisolation fremder Dateien (ab P2)

Parser für PE/Office/PDF/LNK/Archive laufen in Kindprozessen mit eingeschränktem Token,
niedriger Integrität, Job-Objekt (CPU/RAM/Zeit, keine Kindprozesse) und ohne Netz.
Ergebnis als JSON über eine anonyme Pipe; Absturz eines Parsers = Befund „nicht prüfbar“.

## Build & Verteilung

- Frontend: Vite 8, React 19, Tailwind 4 (CSS-first `@theme`), Motion.
- App: Tauri 2, Bundle NSIS (Installation pro Nutzer, ohne Admin).
- Dienst: eigener Installer-Schritt mit UAC (P2/P13).
- Setup-Bootstrapper `AEGIS-Setup.exe` (P13): lädt Release per HTTPS, prüft SHA-256 + Signatur.
