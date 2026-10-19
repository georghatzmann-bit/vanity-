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

1. Ein Modul erkennt etwas (z. B. Fund) und erzeugt über den validierenden Builder einen
   **`ActionPlan`**: Art, Ziele, Was genau, Warum, Was passiert dann, Rückgängig-Weg,
   Schweregrad und – falls nötig – Parameter (z. B. Zielordner beim Verschieben).
2. `ConsentGate::propose(plan)` legt ihn als „ausstehend“ ab (Frist 10 min, Standard: nichts
   tun) und liefert ein `ProposalTicket` mit **Plan-ID + Digest** (SHA-256 über eine
   versionierte, längenpräfixierte Binärkodierung; Plan-IDs werden nie zweimal angenommen).
3. Die UI zeigt den Plan; der Nutzer wählt **Ja, ausführen / Nein / Ignorieren / Vertrauen**.
4. `ConsentGate::decide(id, &digest, decision, origin)` verbraucht den Plan bei **jeder**
   Antwort. Nur „Ja“ ergibt `Outcome::Approved(Approval)`, nur „Vertrauen“ ein `TrustGrant`.
   Eine `Approval` ist nicht kopier-, klon- oder (de)serialisierbar, einmalig, an den Digest
   gebunden und läuft nach 2 min ab.
5. `approval.redeem(&plan, gate.clock())` tauscht sie gegen eine **`ExecutionPermit`**, die den
   freigegebenen Plan enthält. Ausführende Funktionen nehmen die Erlaubnis als Wert und lesen
   ihre Ziele nur aus `permit.plan()`. Danach `permit.complete(result)` → `AuditEvent`.
6. Endgültiges Löschen: Eine normale `Approval` lässt sich dafür nicht einlösen.
   `request_second_confirmation(&approval)` liefert eine Rückfrage, die frühestens nach 1,5 s
   und höchstens 2 min mit `confirm_second(..)` und „Ja, ausführen“ zu einer
   `PermanentDeleteApproval` wird. Jede andere Antwort verbraucht beides.
7. Das Tor macht selbst kein I/O: Es sammelt Audit-Ereignisse, die der Dienst mit
   `take_audit_events()` abholt und an das **Prüfprotokoll** (`AuditLog`, Hash-Kette) anhängt.
   Jede Ausführung erzeugt zusätzlich einen **Rückgängig-Eintrag** (`UndoRecord`).

Abgelaufene oder unbeantwortete Pläne verfallen ohne Wirkung (`expire_stale()`).
Fristen prüft eine versiegelte `Clock` – im Betrieb gibt es nur die Systemuhr.

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
