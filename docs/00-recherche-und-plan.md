# Phase 0 – Recherche und Plan

Stand: 23.10.2026. Gelesen wurden jeweils die aktuellen Stände der Projekte:

| Projekt | Stand (letzter Commit) | Was es ist |
|---|---|---|
| [Auties00/reboot_launcher](https://github.com/Auties00/reboot_launcher) | 05.09.2026 | Launcher (Flutter/Dart) |
| [plooshi/Erbium](https://github.com/plooshi/Erbium) | 05.09.2026 | Game Server (C++) + kleiner Client „ErbiumClient“ |
| [Ralzify/Magnesium](https://github.com/Ralzify/Magnesium) | 04.09.2026 | Game Server, stark erweiterte Kopie von Erbium |
| [plooshi/Tellurium](https://github.com/plooshi/Tellurium) | 16.02.2026 | Umleitungs-DLL (Redirect) |
| [Ralzify/ATLAS-Client](https://github.com/Ralzify/ATLAS-Client) | 04.09.2026 | Ingame-Menü (F9) |
| [Lawin0129/LawinServer](https://github.com/Lawin0129/LawinServer) | 16.10.2026 | Backend (Node.js) |

---

## 1. Wie die Teile zusammenspielen

Ein OG-Fortnite-Build will nach dem Start mit Epics Servern reden (Login, Spind, Lobby,
Matchmaking). Die gibt es für alte Versionen nicht mehr. Deshalb braucht man fünf Teile:

```
 ┌──────────────┐ startet ┌────────────────────────────────────┐
 │   LAUNCHER   │────────▶│ BACKEND  (127.0.0.1:3551)          │
 │              │         │ spielt „Epic“: Login, Spind, Lobby, │
 └──────┬───────┘         │ Matchmaking → „Server ist :7777“    │
        │                 └──────────────────▲─────────────────┘
        │ startet Fortnite zweimal           │ alle Anfragen an Epic
        ▼                                    │ werden hierher umgeleitet
 ┌──────────────────────────────┐   ┌────────┴─────────────────────┐
 │ Fortnite #1 = SERVER          │   │ Fortnite #2 = DEIN SPIEL      │
 │ + Redirect-DLL  (Tellurium)   │   │ + Redirect-DLL  (Tellurium)   │
 │ + Game-Server-DLL (Erbium /   │◀──│ + Overlay-DLL   (ATLAS, F9)   │
 │   Magnesium), Port 7777       │   │                               │
 └──────────────────────────────┘   └───────────────────────────────┘
```

Der Ablauf bei Reboot (nachgelesen in `gui/lib/src/button/game_start_button.dart`):

1. **Launcher** startet das **Backend** (eine gepackte LawinServer-Kopie, Port 3551).
2. Launcher startet **Fortnite #1** als Server (auf Wunsch ohne Grafik, `-nullrhi`).
   Direkt danach lädt er die **Redirect-DLL** hinein.
3. Die **Redirect-DLL** (Tellurium) hängt sich in Fortnites eingebauten HTTP-Teil und schreibt
   jede Adresse wie `…ol.epicgames.com` auf `http://127.0.0.1:3551` um. Das Backend antwortet
   „Login okay“.
4. Der Launcher liest das Spiel-Log mit. Sobald dort „Login fertig“ steht, lädt er die
   **Game-Server-DLL** (Erbium/Magnesium). Die macht aus diesem Fortnite einen echten Server:
   Spieler-Teil abschalten, Karte laden (bei Chapter 3: `Artemis_Terrain`), Port 7777 öffnen
   und die ganze Spiellogik übernehmen, die sonst Epic macht (Inventar, Loot, Sturm, Bus,
   Bauen, Eliminierungen).
5. Launcher startet **Fortnite #2** = dein Spiel, wieder mit Redirect-DLL → du landest in der
   Lobby. Nach dem Login lädt er die **Overlay-DLL** (ATLAS): Menü auf F9, Konsole,
   Edit on Release usw.
6. Du drückst „Spielen“: Der Matchmaker im Backend antwortet „Server ist 127.0.0.1:7777“
   (`Config/config.ini` → `[GameServer]`). Dein Spiel verbindet sich mit Fortnite #1.

Deine jetzige Reboot-Einstellung passt genau dazu: In `settings\v3_dll_storage.gs` sind
`backend` = Redirect (bei dir Tellurium), `game_server` = Game Server (Magnesium),
`unreal_engine_console` = Overlay (ATLAS), `memory_leak` = Speicherleck-Fix (nur Chapter 1).

### Technische Details, die für uns wichtig sind

- **DLL laden („Injektion“)**: Reboot benutzt den Standardweg `LoadLibraryA` +
  `CreateRemoteThread` (`common/lib/src/util/os.dart`).
- **Startargumente** (Reboot, `game_metadata.dart`): `-epicapp=Fortnite -epicenv=Prod
  -skippatchcheck -nobe -fromfl=eac -fltoken=… -caldera=… -AUTH_LOGIN=… -AUTH_PASSWORD=…
  -AUTH_TYPE=epic`, beim Server zusätzlich `-nosplash -nosound` (und `-nullrhi`).
- **Hilfsprozesse**: Reboot startet `FortniteLauncher.exe` und
  `FortniteClient-Win64-Shipping_EAC.exe` und hält sie sofort an (sie laufen nie wirklich).
  Das alte Spiel prüft nur, ob sie da sind. Siehe offene Frage 3.
- **Versionserkennung**: Reboot liest die Datei-Infos von `CrashReportClient.exe`
  (z. B. `++Fortnite+Release-19.10-CL-18675304`) und hat eine Tabelle Build-Nummer → Version.
  19.10 = CL 18675304 steht dort drin.
- **Log-Erkennung**: „Login fertig“ = Zeile mit `[UOnlineAccountCommon::ContinueLoggingIn]`
  und `(Completed)`. „Build kaputt“ = z. B. `Pak chunk signature verification failed!`.
  „Keine Verbindung“ = z. B. `port 3551 failed: Connection refused`. „Match vorbei“ =
  `TeamsLeft: 1`.
- **Umgebungsvariable** `OPENSSL_ia32cap=~0x20000000`: verhindert einen bekannten Absturz
  alter OpenSSL-Versionen auf neuen Intel-CPUs. Gilt nur für den gestarteten Prozess.
- **Erbium/Magnesium** brauchen kein fest eingebautes SDK pro Version. Sie suchen Funktionen
  und Felder zur Laufzeit über Muster und Unreals eigene Typ-Infos (`Finders.cpp`,
  `SDK/`). Deshalb laufen sie auf vielen Versionen. Erbium: volle Unterstützung 3.4 bis
  19.40 – also auch 19.10.
- **19.10 läuft nach allem, was bekannt ist, schon auf Unreal Engine 5.0** (Chapter 3 war der
  Wechsel auf UE5). Erbium schaltet ab UE 5.0 extra Dinge um
  (z. B. `bWaitForServerToBeInitializedBeforeTravelingFeatureEnabled = false`). Das prüfen
  wir beim Import automatisch.
- **Warum Reboots console.dll bei 19.40 abstürzt (sehr wahrscheinlich)**: ErbiumClient (die
  Basis vieler Konsolen-DLLs) greift aus einem *eigenen* Thread auf Spiel-Objekte zu
  (`ClientThread()` in `ErbiumClient/Private/Client.cpp` läuft alle 33 ms neben dem Spiel).
  Unreal erlaubt das nicht – je nach Version kracht es mit „Access Violation“. ATLAS hat das
  gelöst: Alle Befehle landen in einem Briefkasten und werden im Takt des Spiels
  (Hook auf `UEngine::GetMaxTickRate`, also im Game-Thread) ausgeführt. **Das übernehmen wir
  als Grundregel: Wir fassen Spiel-Objekte nur im Game-Thread an.**
- **Overlay**: ATLAS hängt sich in DirectX 11/12 `Present` und `ResizeBuffers` (über eine
  Hilfs-SwapChain) und in die Fenster-Nachrichten (`WndProc`). Standardweg, so machen wir es
  auch.
- **„Join Local Host“** ist in ATLAS einfach der Konsolenbefehl `open 127.0.0.1`.
- **Bots**: Magnesium hat „Spawnbots“ über den Cheat-Manager (Name, Leben, Schild einstellbar).
  Das sind eher Spieler-Attrappen. Echte KI-Gegner (laufen, bauen, schießen) hat keines der
  Projekte fertig → das ist der schwierigste Teil des Plans.
- **Backend**: LawinServer = Express (HTTP, Port 3551) + XMPP/Matchmaker per WebSocket auf
  Port 80. Profile (Spind, Skins) liegen als JSON in `profiles/`, Antworten in `responses/`.

---

## 2. Lizenzen – was wir dürfen

| Projekt | Lizenz | Was das für uns heißt |
|---|---|---|
| Reboot Launcher (GUI, common, cli) | **Keine Lizenz-Datei** → alle Rechte beim Autor | Nur lesen und daraus lernen. **Kein Code kopieren.** Abläufe nachbauen ist erlaubt. |
| Reboot `auth_backend` | GPL-3.0 | ist ein LawinServer-Ableger |
| Erbium + ErbiumClient | **GPL-3.0** (seit 16.08.2026, vorher BSD-3) | Code übernehmen erlaubt. Dann muss unser Game Server auch GPL-3.0 sein und die Quelle nennen. |
| Magnesium | BSD-3 (Copyright Ploosh) | Ist kein Git-Fork, sondern ein Code-Import vom 11.01.2026 (damals war Erbium BSD). Übernahme erlaubt mit Copyright-Hinweis. Ob spätere Teile aus dem GPL-Erbium kamen, ist nicht sicher erkennbar → kein Problem, wenn unser Projekt GPL-3.0 ist. |
| Tellurium | BSD-3-Clause | Übernahme erlaubt, Copyright-Hinweis behalten, Autorin nennen. |
| ATLAS-Client | Eigene „ATLAS Console Attribution License“ | Nutzung erlaubt, aber mit Pflicht-Hinweis „Based on ATLAS Link…“ an sichtbarer Stelle. Der Text redet verwirrend von „ATLAS Link“ (einem Launcher). **Empfehlung: keinen ATLAS-Code kopieren, nur Ideen.** Unser Menü schreiben wir selbst. |
| LawinServer | GPL-3.0 | Nachbau in TypeScript + Übernahme der JSON-Daten → unser Backend wird GPL-3.0. |
| MinHook | BSD-2-Clause | frei nutzbar mit Hinweis |
| Dear ImGui | MIT | frei nutzbar mit Hinweis |
| Memcury | MIT | frei nutzbar mit Hinweis |

**Empfehlung: Das ganze Projekt wird GPL-3.0.** Das ist mit allen oben genannten Lizenzen
verträglich. Folge: Wenn du den Launcher irgendwann veröffentlichst, muss der Quellcode
mit dabei sein. Alle Quellen kommen in `THIRD_PARTY_NOTICES.md` und in einen
„Credits“-Bereich im Launcher.

### Fertige Binärdateien in den Projekten (nehmen wir NICHT)

- `minhook.lib` in Erbium, ErbiumClient, Magnesium, ATLAS → wir bauen MinHook aus dem Quellcode.
- `libcurl.lib` und `zlib.lib` in Erbium und Magnesium → brauchen wir nicht (nur für
  Discord-Webhooks). Falls doch: Windows' eingebautes WinHTTP.
- Reboot liefert `console.dll`, `sinum.dll`, `cobalt.dll`, `starfall.dll`, `memory.dll`,
  `lawinserver.exe`, `aria2c.exe`, `7zip.exe`, `winrar.exe` fertig mit → nehmen wir alle nicht.

---

## 3. Plan

### Grundregeln

- **Nur alte Builds, nur eigenes Backend.** Der Launcher nimmt nur Builds, die er sicher als
  alt erkennt (am Anfang nur 19.10). Alle Anfragen gehen an unser eigenes Backend. Die Modi
  von Tellurium, die teilweise mit Epics echten Servern reden („Hybrid“, „Dev“), bauen wir
  nicht ein. „Manual Mapping“ (gedacht, um an Anti-Cheat vorbeizukommen) auch nicht.
- **Alles aus Quellcode.** Drittbibliotheken als Git-Submodule mit fester Version.
- **Spiel-Objekte nur im Game-Thread anfassen.** Eigene Threads dürfen nur Nachrichten
  einwerfen.
- **Versions-Weichen statt Absturz.** Jede Funktion im Menü/Server hat eine Liste, auf
  welchen Versionen sie geprüft ist. Ungeprüft = ausgegraut statt Absturz.
- **Nichts außerhalb des Projekts ändern, ohne zu fragen.** Der Launcher speichert seine
  eigenen Daten in `%APPDATA%\Vanity`. Den Build-Ordner und Reboots Einstellungen fasst er
  nur nach einer Rückfrage an (z. B. das Umbenennen von `GFSDK_Aftermath_Lib.dll`, das
  Reboot ungefragt löscht).

### Ordnerstruktur

```
vanity-/
├─ launcher/               Der Launcher (Tauri 2)
│  ├─ src/                 Oberfläche: React + TypeScript + Tailwind + shadcn/ui + Framer Motion
│  └─ src-tauri/           Rust: Spiel starten, DLLs laden, Logs, Absturz-Analyse, Steuerzentrale
├─ backend/                Eingebautes Backend (Node 22 + TypeScript + Fastify), nach LawinServer
├─ native/                 Alle Spiel-DLLs, eine Visual-Studio-2022-Lösung (C++20, x64)
│  ├─ common/              Geteilt: Unreal-Zugriff, Hooks, Game-Thread-Briefkasten, Versions-Weichen
│  ├─ redirect/            Umleitungs-DLL (Basis: Tellurium)
│  ├─ client/              Ingame-Menü F9 (ImGui + DX11 + MinHook)
│  ├─ gameserver/          Game Server (Basis: Erbium, Teile/Ideen aus Magnesium)
│  └─ third_party/         MinHook, ImGui, Memcury, nlohmann/json – als Quellcode
├─ docs/                   Dieser Plan + eine Test-Checkliste pro Phase
├─ .github/workflows/      Baut alles auf einem Windows-Rechner von GitHub aus dem Quellcode
├─ THIRD_PARTY_NOTICES.md  Wer hat was geschrieben, unter welcher Lizenz
└─ LICENSE                 GPL-3.0
```

### Technik

| Teil | Technik | Warum |
|---|---|---|
| Oberfläche | Tauri 2, React, TypeScript, Vite, Tailwind, shadcn/ui, Framer Motion, lucide-Icons | wie gewünscht; klein und schnell |
| Launcher-Logik | Rust: `windows`-Crate (Prozesse, DLL laden), `tokio` (gleichzeitig Logs lesen), `pelite` (Version aus der .exe lesen) | stabil, keine Abstürze durch Speicherfehler |
| Backend | Node 22 + TypeScript, Fastify (HTTP), `ws` (Matchmaker/XMPP); wird als eine einzige .exe gebaut und vom Launcher mitgestartet | LawinServer-Logik lässt sich gut übertragen |
| Spiel-DLLs | C++20, VS 2022, x64, MinHook, Dear ImGui (DX11), Memcury | Standard in der Szene, alles Quellcode |
| Verbindung Launcher ↔ DLLs | Named Pipe pro Prozess, Nachrichten als JSON | Launcher sieht live „Server bereit“, kann Server-Optionen ändern |
| Verbindung F9-Menü ↔ Server | über Fortnites eigenen `ServerCheat`-Weg; der Server prüft, ob es der Host ist | funktioniert auch, wenn Freunde mitspielen |
| Bauen | GitHub Actions auf `windows-latest`: baut DLLs, Backend-.exe und Launcher-Installer | du lädst einen fertigen, aus *unserem* Quellcode gebauten Installer herunter – oder baust selbst mit VS 2022 |

Hinweis: Hier in meiner Arbeitsumgebung läuft Linux. Oberfläche, Backend und Rust-Logik
(Versionserkennung, Log- und Absturz-Auswertung) teste ich hier automatisch. Die DLLs und den
Windows-Installer baut GitHub Actions. Fortnite selbst kann ich nicht starten – das testest
du mit der Checkliste und schickst mir die Logs.

### Phasen

Jede Phase endet mit einer Test-Checkliste in `docs/` und wartet auf dein „läuft“.

| # | Phase | Was du danach testen kannst |
|---|---|---|
| 0 | Recherche + Plan | dieses Dokument lesen, Fragen beantworten |
| 1 | **Launcher-Oberfläche** (nur Design, Beispieldaten): Start („Host & Play“), Bibliothek (Builds), Server & Freunde, Live-Log, Ingame-Menü-Optionen, Profile, Einstellungen, Credits | Installer starten, durch alle Seiten klicken, Animationen, Fenstergröße ändern |
| 2 | **Fortnite 19.10 starten + Logs**: Build-Ordner importieren mit Versions-Erkennung (19.10 · CL-18675304 · Chapter 3 Season 1 · UE 5.0), Start mit `-d3d11`, Live-Log, Erkennen von „geschlossen“/„abgestürzt“. **Zusätzlich schon die Redirect-DLL**, auf 127.0.0.1 gestellt – so redet Fortnite nie mit Epic. | Build importieren → Version stimmt; Start → Fortnite öffnet sich und meldet „keine Verbindung“ (richtig so, Backend fehlt noch); Log läuft live mit; Fortnite schließen → Launcher merkt es |
| 3 | **Backend + Lobby**: Login, Profil/Spind, Lobby-Inhalte, Versionsprüfung, Cloud-Einstellungen, Matchmaker. Im Launcher: Backend-Status und Anfragen-Liste | Start → du landest in der Lobby mit deinem Namen; Spind öffnen; Einstellungen bleiben gespeichert |
| 4 | **Game Server + Match auf 127.0.0.1**: Game-Server-DLL (Erbium-Basis) für 19.10, „Host & Play“ mit einem Klick (Backend + Server ohne Grafik + dein Spiel). Freund-Beitritt per IP (Tailscale/Radmin) | Spielen drücken → Bus, Absprung, Loot, Bauen, Editieren, Fallschaden, Sieg; Server beendet/neu gestartet nach dem Match |
| 5 | **Ingame-Menü (F9)**: modernes ImGui-Design, Edit on Release, Reset on Release, Disable Pre-Edits, FOV, Keybinds, Join Local Host / per IP, Konsole an/aus (Game-Thread-sicher) | jede Option einzeln an/aus im Match; Einstellungen bleiben nach Neustart |
| 6 | **Bots**: 6a Ziel-Bots (Anzahl, Leben/Schild, stehen still); 6b echte Gegner mit Schwierigkeit (**experimentell** – schwierigster Teil) | Bots spawnen, treffen, eliminieren; Anzahl/Schwierigkeit ändern |
| 7 | **Trickshot-Modus + Match-Steuerung**: kein Fallschaden, unendlich Munition/Material, Instant Reload, Spawn in der Höhe, Teleport-Punkte, Trickshot-Erkennung mit Anzeige; Playlist, Lategame, Match starten, Sturm an/aus + Tempo, Items geben, Respawn an/aus – im Launcher (Host-Panel) und im F9-Menü (nur Host) | jede Option im Match ausprobieren |
| 8 | **Feinschliff**: Design, Absturz-Analyse in einfacher Sprache (liest `…\Saved\Crashes`), Server-Browser, Installer, Anleitung | absichtlich Absturz auslösen → verständliche Meldung; Installer auf frischem Windows |

Später: weitere Versionen (19.40 zuerst, weil Erbium sie schon voll unterstützt).

### Was du brauchst

- Windows 10/11, genug RAM für zwei Fortnite-Instanzen (Server + Spiel, grob 12–16 GB).
- Zum Selberbauen (optional): Visual Studio 2022 („Desktop development with C++“),
  Rust, Node 22, pnpm. Sonst reicht der Installer aus GitHub Actions.

---

## 4. Offene Fragen an dich

1. **Lizenz**: Ist GPL-3.0 für das ganze Projekt okay? (Empfehlung: ja – sonst dürften wir
   weder Erbium noch LawinServer verwenden und müssten den Game Server komplett neu schreiben.)
2. **Game-Server-Basis**: Erbium als saubere Grundlage nehmen und Magnesium-Funktionen gezielt
   (mit Credit) übernehmen? (Empfehlung: ja. Magnesium ist ~330.000 Zeilen mit vielen
   Extras, die wir nicht brauchen.)
3. **Startmethode**: Alle OG-Launcher (auch Reboot) starten die Epic-Hilfsprogramme
   (`FortniteLauncher.exe`, `…_EAC.exe`) und halten sie sofort an. Dazu kommen Start-Argumente
   „ohne BattlEye“ und ein fester Platzhalter-Token. Easy Anti-Cheat läuft dabei nie. Das
   ist nötig, damit der alte Build überhaupt startet. Es hilft nicht, im echten Fortnite zu
   cheaten: Unser Spiel redet nur mit deinem eigenen Backend und alte Builds kommen nicht auf
   Epics Server. Trotzdem sage ich es dir offen, weil du „keine Anti-Cheat-Umgehung“
   geschrieben hast. Ist das so für dich okay?
4. **Name**: Soll das Projekt „Vanity“ heißen (wie das Repo)? Die alte „Jarvis“-README würde
   ich in Phase 1 ersetzen.
