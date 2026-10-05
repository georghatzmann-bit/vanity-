// Built-in sample catalog for the UI mock server (tests/ui/mock-server.mjs).
// Used only when neither data/ nor tests/fixtures/ provide a file. Shapes follow
// docs/ARCHITECTURE.md sections 3-5 exactly, so the UI sees what the real backend serves.

const HKLM = 'HKLM\\';
const HKCU = 'HKCU\\';
const reg = (path, name, kind, value, def, extra) => Object.assign({ type: 'reg', path, name, kind, value, default: def }, extra || {});
const svc = (name, start, def) => ({ type: 'service', name, start, default: def });
const task = (path, enabled, def) => ({ type: 'task', path, enabled, default: def });
const bcd = (name, value, def) => ({ type: 'bcd', name, value, default: def });
const ps = (apply, revert, detect) => ({ type: 'ps', apply, revert: revert || null, detect: detect || null });
const clean = (paths, extra) => Object.assign({ type: 'clean', paths }, extra || {});
const appx = (pkg) => ({ type: 'appx', package: pkg });

function t(id, name, desc, o) {
  return Object.assign({ id, name, desc, kind: 'toggle', impact: 2, risk: 'safe', warning: null, needs: 'none', tags: [], actions: [] }, o);
}

export const categories = [
  { id: 'gaming', order: 1, icon: 'gamepad', name: 'Gaming & FPS', desc: 'Mehr Bilder pro Sekunde, weniger Ruckler, Spiele bekommen Vorrang.' },
  { id: 'latency', order: 2, icon: 'mouse', name: 'Input & Latenz', desc: 'Maus, Tastatur und Timer: alles reagiert direkter.' },
  { id: 'power', order: 3, icon: 'bolt', name: 'Energie & CPU', desc: 'Prozessor und Energieplan auf Leistung statt Stromsparen.' },
  { id: 'gpu', order: 4, icon: 'gpu', name: 'Grafikkarte', desc: 'Einstellungen für NVIDIA, AMD und Intel Grafik.' },
  { id: 'network', order: 5, icon: 'wifi', name: 'Netzwerk & Ping', desc: 'Niedrigerer Ping und stabilere Verbindung beim Online-Spielen.' },
  { id: 'memory', order: 6, icon: 'chip', name: 'Speicher & Laufwerke', desc: 'Arbeitsspeicher, SSD und Festplatten effizienter nutzen.' },
  { id: 'system', order: 7, icon: 'cog', name: 'System & Start', desc: 'Schnellerer Start, kürzere Wartezeiten, weniger Unterbrechungen.' },
  { id: 'privacy', order: 8, icon: 'shield', name: 'Datenschutz', desc: 'Weniger Daten an Microsoft, weniger Hintergrund-Aktivität.' },
  { id: 'debloat', order: 9, icon: 'sparkles', name: 'Werbung & KI-Features', desc: 'Werbung, Vorschläge, Copilot, Widgets und anderen Ballast abschalten.' },
  { id: 'services', order: 10, icon: 'layers', name: 'Dienste & Aufgaben', desc: 'Unnötige Hintergrunddienste und geplante Aufgaben ruhigstellen.' },
  { id: 'ui', order: 11, icon: 'layout', name: 'Oberfläche & Explorer', desc: 'Windows so einrichten, wie es sich gut bedienen lässt.' },
  { id: 'games', order: 12, icon: 'target', name: 'Spiele-spezifisch', desc: 'Feinschliff für einzelne Spiele wie FiveM und GTA V.' },
  { id: 'security', order: 13, icon: 'alert', name: 'Experte (riskant)', desc: 'Mehr Leistung gegen weniger Schutz. Nur wenn du genau weißt, was du tust.' },
  { id: 'cleanup', order: 14, icon: 'broom', name: 'Reinigung', desc: 'Temporäre Dateien, Caches und Datenmüll entfernen.' },
  { id: 'repair', order: 15, icon: 'wrench', name: 'Reparatur', desc: 'Windows-Dateien prüfen und typische Probleme beheben.' },
  { id: 'apps', order: 16, icon: 'package', name: 'Bloatware', desc: 'Vorinstallierte Apps entfernen, die kaum jemand braucht.' }
];

const MMCSS = HKLM + 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile';
const POL = HKLM + 'SOFTWARE\\Policies\\Microsoft\\Windows';

export const tweaks = {
  gaming: [
    t('gaming.gamedvr-off', 'Hintergrund-Aufnahme (Game DVR) aus', 'Windows nimmt sonst heimlich Gameplay auf. Aus = mehr FPS und weniger Ruckler.', {
      group: 'Xbox Game Bar', impact: 3, tags: ['fps', 'stutter'], when: { minBuild: 17763 },
      info: 'Die Aufnahme läuft dauerhaft im Hintergrund mit und kostet vor allem auf schwächeren Grafikkarten spürbar Leistung. Clips aufnehmen geht danach nicht mehr über Win+Alt+G.',
      actions: [reg(HKCU + 'System\\GameConfigStore', 'GameDVR_Enabled', 'DWord', 0, 1), reg(POL + '\\GameDVR', 'AllowGameDVR', 'DWord', 0, null)] }),
    t('gaming.gamemode-on', 'Spielmodus an', 'Windows gibt laufenden Spielen Vorrang und pausiert Updates während du spielst.', {
      group: 'Xbox Game Bar', impact: 2, tags: ['fps'], actions: [reg(HKCU + 'Software\\Microsoft\\GameBar', 'AutoGameModeEnabled', 'DWord', 1, null)] }),
    t('gaming.hags-on', 'Hardwarebeschleunigte GPU-Planung an', 'Die Grafikkarte plant ihre Arbeit selbst. Kann Eingabeverzögerung senken.', {
      group: 'Grafik-Pipeline', impact: 2, risk: 'moderate', warning: 'Mit älteren Treibern kann es zu Bildfehlern kommen.', needs: 'reboot', tags: ['fps', 'latency'], when: { minBuild: 19041 },
      actions: [reg(HKLM + 'SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', 'HwSchMode', 'DWord', 2, null)] }),
    t('gaming.fso-off', 'Vollbild-Optimierungen global aus', 'Echtes Vollbild statt Fenster-Trick. Hilft bei manchen älteren Spielen gegen Ruckler.', {
      group: 'Grafik-Pipeline', impact: 2, risk: 'moderate', warning: 'Alt+Tab dauert in manchen Spielen etwas länger.', tags: ['fps', 'stutter', 'compat'],
      actions: [reg(HKCU + 'System\\GameConfigStore', 'GameDVR_FSEBehaviorMode', 'DWord', 2, 0), reg(HKCU + 'System\\GameConfigStore', 'GameDVR_HonorUserFSEBehaviorMode', 'DWord', 1, 0)] }),
    t('gaming.mmcss-games', 'Spiele bekommen CPU-Vorrang', 'Der Multimedia-Planer gibt Spielen mehr Rechenzeit als Hintergrund-Programmen.', {
      group: 'Prozessor', impact: 2, tags: ['fps', 'stutter'],
      actions: [reg(MMCSS + '\\Tasks\\Games', 'Priority', 'DWord', 6, 2), reg(MMCSS + '\\Tasks\\Games', 'Scheduling Category', 'String', 'High', 'Medium')] }),
    t('gaming.priority-sep', 'Vordergrund-Programme bevorzugen', 'Das Fenster, in dem du gerade bist, bekommt kürzere Reaktionszeiten.', {
      group: 'Prozessor', impact: 2, risk: 'moderate', warning: 'Hintergrund-Aufgaben wie Downloads werden etwas langsamer.', tags: ['latency', 'input'],
      actions: [reg(HKLM + 'SYSTEM\\CurrentControlSet\\Control\\PriorityControl', 'Win32PrioritySeparation', 'DWord', 38, 2)] }),
    t('gaming.responsiveness', 'Systemreserve für Hintergrund senken', 'Windows hält normal 20 % CPU für Hintergrund frei. 10 % reicht für Spiele.', {
      group: 'Prozessor', impact: 1, tags: ['fps', 'streaming'],
      actions: [reg(MMCSS, 'SystemResponsiveness', 'DWord', 10, 20)] })
  ],
  latency: [
    t('latency.mouse-accel-off', 'Mausbeschleunigung aus', 'Die Maus bewegt sich immer gleich weit, egal wie schnell du sie bewegst. Besser zum Zielen.', {
      impact: 3, tags: ['input', 'competitive'], group: 'Maus & Tastatur',
      actions: [reg(HKCU + 'Control Panel\\Mouse', 'MouseSpeed', 'String', '0', '1'), reg(HKCU + 'Control Panel\\Mouse', 'MouseThreshold1', 'String', '0', '6'), reg(HKCU + 'Control Panel\\Mouse', 'MouseThreshold2', 'String', '0', '10')] }),
    t('latency.keyboard-delay', 'Tastatur-Wiederholung schneller', 'Gehaltene Tasten wiederholen sich sofort statt nach einer kurzen Pause.', {
      impact: 1, tags: ['input', 'quality-of-life'], group: 'Maus & Tastatur', actions: [reg(HKCU + 'Control Panel\\Keyboard', 'KeyboardDelay', 'String', '0', '1')] }),
    t('latency.sticky-keys-off', 'Einrastfunktion-Abfrage aus', 'Fünfmal Shift im Spiel öffnet keine nervige Abfrage mehr.', {
      impact: 1, tags: ['input', 'quality-of-life'], group: 'Maus & Tastatur', actions: [reg(HKCU + 'Control Panel\\Accessibility\\StickyKeys', 'Flags', 'String', '506', '510')] }),
    t('latency.dynamic-tick-off', 'Dynamischen Timer-Tick aus', 'Der Systemtakt läuft gleichmäßig. Kann Mikroruckler verringern.', {
      impact: 2, risk: 'moderate', warning: 'Auf Laptops etwas höherer Stromverbrauch.', needs: 'reboot', tags: ['latency', 'stutter', 'laptop-bad'], group: 'Timer',
      actions: [bcd('disabledynamictick', 'yes', null)] }),
    t('latency.timer-res', 'Globale Timer-Auflösung erlauben', 'Spiele dürfen den genauen Systemtakt wieder für alle Programme setzen (Windows 11).', {
      impact: 2, needs: 'reboot', tags: ['latency', 'input'], group: 'Timer', when: { os: 'win11' },
      actions: [reg(HKLM + 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\kernel', 'GlobalTimerResolutionRequests', 'DWord', 1, null)] })
  ],
  power: [
    t('power.ultimate-plan', 'Energieplan "Ultimative Leistung"', 'Der Prozessor taktet nie herunter. Mehr Leistung, aber höherer Stromverbrauch.', {
      impact: 3, tags: ['fps', 'latency', 'laptop-bad', 'desktop'], group: 'Energieplan',
      info: 'Der versteckte Plan wird bei Bedarf angelegt. Auf einem Desktop-PC gibt es praktisch keinen Nachteil.',
      actions: [{ type: 'powerplan', plan: 'ultimate', default: 'balanced' }] }),
    t('power.core-parking-off', 'CPU-Kerne nicht schlafen legen', 'Alle Kerne bleiben wach und reagieren sofort, wenn ein Spiel sie braucht.', {
      impact: 2, risk: 'moderate', warning: 'Mehr Abwärme und Stromverbrauch im Leerlauf.', tags: ['fps', 'stutter', 'laptop-bad'], group: 'Prozessor',
      actions: [{ type: 'powersetting', subgroup: 'SUB_PROCESSOR', setting: 'CPMINCORES', ac: 100, dc: null, default: { ac: 10, dc: 10 } }] }),
    t('power.throttling-off', 'Power Throttling aus', 'Windows bremst Hintergrund-Programme nicht mehr künstlich aus.', {
      impact: 1, tags: ['fps', 'laptop-bad'], group: 'Prozessor',
      actions: [reg(HKLM + 'SYSTEM\\CurrentControlSet\\Control\\Power\\PowerThrottling', 'PowerThrottlingOff', 'DWord', 1, null)] }),
    t('power.usb-suspend-off', 'USB-Energiesparen aus', 'Maus, Headset und Controller werden nie schlafen gelegt. Keine Aussetzer mehr.', {
      impact: 1, tags: ['input', 'audio'], group: 'Geräte',
      actions: [{ type: 'powersetting', subgroup: '2a737441-1930-4402-8d77-b2bebba308a3', setting: '48e6b7a6-50f5-4782-a5d4-53bb8f07e226', ac: 0, dc: 0, default: { ac: 1, dc: 1 } }] }),
    t('power.hibernate-off', 'Ruhezustand aus', 'Gibt mehrere GB auf dem Systemlaufwerk frei. Nur für Desktop-PCs gedacht.', {
      impact: 1, risk: 'moderate', warning: 'Der Ruhezustand und der Schnellstart sind danach nicht mehr verfügbar.', tags: ['storage', 'desktop'], group: 'Energieplan', when: { formFactor: 'desktop' },
      actions: [ps('powercfg.exe /hibernate off', 'powercfg.exe /hibernate on', "return -not (Test-Path \"$env:SystemDrive\\hiberfil.sys\")")] })
  ],
  gpu: [
    t('gpu.nvidia-telemetry-off', 'NVIDIA-Telemetrie aus', 'Der NVIDIA-Treiber schickt keine Nutzungsdaten mehr nach Hause.', {
      impact: 1, tags: ['nvidia', 'privacy', 'telemetry'], when: { gpuVendor: 'nvidia' }, group: 'NVIDIA',
      actions: [svc('NvTelemetryContainer', 'Disabled', 'Automatic')] }),
    t('gpu.nvidia-pstate', 'NVIDIA: Höchster Leistungszustand', 'Die Grafikkarte taktet zwischen Szenen nicht herunter. Gleichmäßigere Frametimes.', {
      impact: 2, risk: 'moderate', warning: 'Höherer Stromverbrauch im Leerlauf.', tags: ['nvidia', 'stutter', 'laptop-bad'], when: { gpuVendor: 'nvidia' }, group: 'NVIDIA',
      actions: [reg(HKLM + 'SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\*', 'DisableDynamicPstate', 'DWord', 1, null, { onlyExisting: true })] }),
    t('gpu.amd-ulps-off', 'AMD ULPS aus', 'Verhindert, dass eine AMD-Grafikkarte in einen Tiefschlaf fällt und beim Aufwachen ruckelt.', {
      impact: 2, tags: ['amd', 'stutter'], when: { gpuVendor: 'amd' }, group: 'AMD',
      actions: [reg(HKLM + 'SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\*', 'EnableUlps', 'DWord', 0, 1, { onlyExisting: true })] }),
    t('gpu.mpo-off', 'Multiplane Overlay aus', 'Behebt Flackern und schwarze Bildschirme bei manchen Treibern mit mehreren Monitoren.', {
      impact: 1, risk: 'moderate', warning: 'Nur sinnvoll, wenn du Flackern hast. Kostet sonst minimal Leistung.', needs: 'reboot', tags: ['stutter', 'compat'], group: 'Allgemein',
      actions: [reg(HKLM + 'SOFTWARE\\Microsoft\\Windows\\Dwm', 'OverlayTestMode', 'DWord', 5, null)] }),
    t('gpu.intel-dptf', 'Intel-Grafik: Stromsparen aus', 'Die integrierte Intel-Grafik taktet nicht mehr so aggressiv herunter.', {
      impact: 1, tags: ['intel', 'laptop-bad'], when: { gpuVendor: 'intel' }, group: 'Intel',
      actions: [reg(HKLM + 'SOFTWARE\\Intel\\Display\\igfxcui\\profiles', 'PowerSaving', 'DWord', 0, null)] })
  ],
  network: [
    t('network.nagle-off', 'Nagle-Algorithmus aus', 'Kleine Datenpakete werden sofort verschickt statt gesammelt. Niedrigerer Ping in Online-Spielen.', {
      impact: 2, tags: ['ping', 'network', 'competitive'], group: 'TCP',
      actions: [reg(HKLM + 'SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\*', 'TcpAckFrequency', 'DWord', 1, null), reg(HKLM + 'SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\*', 'TCPNoDelay', 'DWord', 1, null)] }),
    t('network.throttling-off', 'Netzwerk-Drosselung aus', 'Windows bremst Netzwerkverkehr bei Musik und Videos nicht mehr aus.', {
      impact: 2, tags: ['network', 'ping'], group: 'TCP',
      actions: [reg(MMCSS, 'NetworkThrottlingIndex', 'DWord', 4294967295, 10)] }),
    t('network.autotuning', 'TCP-Autotuning auf Normal', 'Stellt sicher, dass Downloads die volle Leitung nutzen dürfen.', {
      impact: 1, tags: ['network'], group: 'TCP',
      actions: [ps('netsh.exe int tcp set global autotuninglevel=normal', null, "return ((netsh.exe int tcp show global) -match 'normal').Count -gt 0")] }),
    t('network.delivery-opt-off', 'Updates nicht mit anderen PCs teilen', 'Windows lädt Updates nicht mehr im Hintergrund zu fremden PCs hoch.', {
      impact: 2, tags: ['network', 'update', 'privacy'], group: 'Windows Update',
      actions: [reg(POL + '\\DeliveryOptimization', 'DODownloadMode', 'DWord', 0, null)] }),
    t('network.dns-flush', 'DNS-Cache leeren', 'Hilft, wenn Webseiten oder Server plötzlich nicht mehr erreichbar sind.', {
      kind: 'action', impact: 1, tags: ['network', 'repair'], group: 'Werkzeuge', actions: [ps('ipconfig.exe /flushdns | Out-Null')] })
  ],
  memory: [
    t('memory.sysmain-off', 'SysMain (Superfetch) aus', 'Auf einer SSD bringt das Vorladen nichts und erzeugt nur Hintergrundlast.', {
      impact: 2, risk: 'moderate', warning: 'Programme starten auf Festplatten (HDD) langsamer.', tags: ['ssd', 'stutter'], when: { systemDisk: 'ssd' }, group: 'Arbeitsspeicher',
      actions: [svc('SysMain', 'Disabled', 'Automatic')] }),
    t('memory.compression-off', 'Speicherkomprimierung aus', 'Mit viel RAM spart Windows sich das Packen und Entpacken von Speicher.', {
      impact: 1, risk: 'moderate', warning: 'Nur mit 16 GB RAM oder mehr sinnvoll.', tags: ['memory', 'stutter'], when: { minRamGB: 16 }, group: 'Arbeitsspeicher',
      actions: [ps('Disable-MMAgent -MemoryCompression -ErrorAction Stop', 'Enable-MMAgent -MemoryCompression -ErrorAction Stop', 'return -not (Get-MMAgent).MemoryCompression')] }),
    t('memory.lastaccess-off', 'Zugriffs-Zeitstempel aus', 'Windows schreibt nicht bei jedem Lesen einer Datei die Uhrzeit mit.', {
      impact: 1, tags: ['ssd', 'storage'], group: 'Laufwerke',
      actions: [ps('fsutil.exe behavior set disablelastaccess 1 | Out-Null', 'fsutil.exe behavior set disablelastaccess 2 | Out-Null', "return ((fsutil.exe behavior query disablelastaccess) -match '= 1').Count -gt 0")] }),
    t('memory.paging-exec-off', 'Systemkern im RAM halten', 'Der Windows-Kern wird nie auf die Platte ausgelagert. Nur bei viel RAM sinnvoll.', {
      impact: 1, risk: 'moderate', warning: 'Bei wenig Arbeitsspeicher kann es eng werden.', needs: 'reboot', tags: ['memory', 'latency'], when: { minRamGB: 16 }, group: 'Arbeitsspeicher',
      actions: [reg(HKLM + 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management', 'DisablePagingExecutive', 'DWord', 1, 0)] }),
    t('memory.hdd-defrag', 'Festplatte wöchentlich defragmentieren', 'Hält eine klassische Festplatte (HDD) schnell. Für SSDs nicht nötig.', {
      impact: 1, tags: ['hdd', 'storage'], when: { systemDisk: 'hdd' }, group: 'Laufwerke',
      actions: [task('\\Microsoft\\Windows\\Defrag\\ScheduledDefrag', true, true)] })
  ],
  system: [
    t('system.startup-delay-off', 'Autostart-Verzögerung aus', 'Programme im Autostart starten sofort statt mit 10 Sekunden Wartezeit.', {
      impact: 2, tags: ['boot', 'quality-of-life'], group: 'Start',
      actions: [reg(HKCU + 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Serialize', 'StartupDelayInMSec', 'DWord', 0, null)] }),
    t('system.fast-shutdown', 'Schneller herunterfahren', 'Hängende Dienste werden nach 2 statt 5 Sekunden beendet.', {
      impact: 1, tags: ['boot', 'quality-of-life'], group: 'Start',
      actions: [reg(HKLM + 'SYSTEM\\CurrentControlSet\\Control', 'WaitToKillServiceTimeout', 'String', '2000', '5000')] }),
    t('system.menu-delay', 'Menüs öffnen ohne Verzögerung', 'Untermenüs klappen sofort auf statt nach 0,4 Sekunden.', {
      impact: 1, tags: ['ui', 'quality-of-life'], group: 'Bedienung',
      actions: [reg(HKCU + 'Control Panel\\Desktop', 'MenuShowDelay', 'String', '0', '400')] }),
    t('system.fastboot-off', 'Schnellstart aus', 'Echter Neustart bei jedem Hochfahren. Behebt viele seltsame Treiberprobleme.', {
      impact: 1, risk: 'moderate', warning: 'Der PC fährt ein paar Sekunden langsamer hoch.', tags: ['boot', 'compat'], group: 'Start',
      actions: [reg(HKLM + 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power', 'HiberbootEnabled', 'DWord', 0, 1)] }),
    t('system.verbose-status', 'Ausführliche Startmeldungen', 'Beim Hoch- und Herunterfahren siehst du, woran Windows gerade arbeitet.', {
      impact: 1, tags: ['boot'], group: 'Start',
      actions: [reg(HKLM + 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', 'VerboseStatus', 'DWord', 1, null)] })
  ],
  privacy: [
    t('privacy.telemetry-min', 'Telemetrie auf Minimum', 'Windows schickt nur noch das Nötigste an Microsoft.', {
      impact: 2, tags: ['privacy', 'telemetry'], group: 'Telemetrie',
      actions: [reg(POL + '\\DataCollection', 'AllowTelemetry', 'DWord', 0, null), svc('DiagTrack', 'Disabled', 'Automatic')] }),
    t('privacy.adid-off', 'Werbe-ID aus', 'Apps können dich nicht mehr über eine gemeinsame ID für Werbung wiedererkennen.', {
      impact: 1, tags: ['privacy', 'ads'], group: 'Werbung',
      actions: [reg(HKCU + 'Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo', 'Enabled', 'DWord', 0, 1)] }),
    t('privacy.activity-off', 'Aktivitätsverlauf aus', 'Windows merkt sich nicht mehr, welche Programme und Dateien du wann geöffnet hast.', {
      impact: 1, tags: ['privacy'], group: 'Verlauf',
      actions: [reg(POL + '\\System', 'PublishUserActivities', 'DWord', 0, null), reg(POL + '\\System', 'UploadUserActivities', 'DWord', 0, null)] }),
    t('privacy.location-off', 'Standortzugriff aus', 'Kein Programm kann mehr deinen Standort abfragen.', {
      impact: 1, risk: 'moderate', warning: 'Wetter, Karten und "Mein Gerät suchen" funktionieren nicht mehr.', tags: ['privacy'], group: 'Berechtigungen',
      actions: [reg(HKLM + 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location', 'Value', 'String', 'Deny', 'Allow')] }),
    t('privacy.ceip-tasks-off', 'Programm zur Verbesserung aus', 'Geplante Aufgaben, die Nutzungsdaten sammeln, laufen nicht mehr.', {
      impact: 1, tags: ['privacy', 'telemetry'], group: 'Telemetrie',
      actions: [task('\\Microsoft\\Windows\\Customer Experience Improvement Program\\Consolidator', false, true), task('\\Microsoft\\Windows\\Application Experience\\Microsoft Compatibility Appraiser', false, true)] }),
    t('privacy.feedback-off', 'Feedback-Fragen aus', 'Windows fragt nicht mehr ständig nach deiner Meinung.', {
      impact: 1, tags: ['privacy', 'quality-of-life'], group: 'Telemetrie',
      actions: [reg(HKCU + 'Software\\Microsoft\\Siuf\\Rules', 'NumberOfSIUFInPeriod', 'DWord', 0, null)] })
  ],
  debloat: [
    t('debloat.copilot-off', 'Copilot aus', 'Der KI-Assistent verschwindet aus Taskleiste und Windows.', {
      impact: 2, tags: ['ai', 'bloat'], when: { os: 'win11' }, group: 'KI', needs: 'explorer',
      actions: [reg(HKCU + 'Software\\Policies\\Microsoft\\Windows\\WindowsCopilot', 'TurnOffWindowsCopilot', 'DWord', 1, null)] }),
    t('debloat.recall-off', 'Recall aus', 'Windows macht keine regelmäßigen Bildschirmfotos für die KI-Suche.', {
      impact: 2, tags: ['ai', 'privacy'], when: { minBuild: 26100 }, group: 'KI',
      actions: [reg(POL + '\\WindowsAI', 'DisableAIDataAnalysis', 'DWord', 1, null)] }),
    t('debloat.widgets-off', 'Widgets aus', 'Kein Nachrichten- und Wetterfenster mehr, das im Hintergrund Daten lädt.', {
      impact: 2, tags: ['bloat', 'ads'], when: { os: 'win11' }, needs: 'explorer', group: 'Taskleiste',
      actions: [reg(HKLM + 'SOFTWARE\\Policies\\Microsoft\\Dsh', 'AllowNewsAndInterests', 'DWord', 0, null)] }),
    t('debloat.start-ads-off', 'Vorschläge im Startmenü aus', 'Keine App-Werbung mehr im Startmenü und in den Einstellungen.', {
      impact: 1, tags: ['ads', 'bloat'], group: 'Werbung',
      actions: [reg(HKCU + 'Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SubscribedContent-338388Enabled', 'DWord', 0, 1), reg(HKCU + 'Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SilentInstalledAppsEnabled', 'DWord', 0, 1)] }),
    t('debloat.bing-search-off', 'Websuche im Startmenü aus', 'Die Suche findet nur noch deine Dateien und Programme, keine Bing-Ergebnisse.', {
      impact: 2, tags: ['bloat', 'privacy'], needs: 'explorer', group: 'Suche',
      actions: [reg(HKCU + 'Software\\Policies\\Microsoft\\Windows\\Explorer', 'DisableSearchBoxSuggestions', 'DWord', 1, null)] }),
    t('debloat.lockscreen-tips-off', 'Tipps auf dem Sperrbildschirm aus', 'Keine Werbung und Fun Facts mehr auf dem Sperrbildschirm.', {
      impact: 1, tags: ['ads'], group: 'Werbung',
      actions: [reg(HKCU + 'Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'RotatingLockScreenOverlayEnabled', 'DWord', 0, 1)] })
  ],
  services: [
    t('services.fax-off', 'Fax-Dienst aus', 'Kaum jemand faxt noch. Der Dienst wird nicht mehr gestartet.', {
      impact: 1, tags: ['bloat'], when: { service: 'Fax' }, group: 'Dienste', actions: [svc('Fax', 'Disabled', 'Manual')] }),
    t('services.spooler-off', 'Druckwarteschlange aus', 'Spart einen Hintergrunddienst, wenn du nie druckst.', {
      impact: 1, risk: 'moderate', warning: 'Drucken geht danach nicht mehr.', tags: ['bloat'], group: 'Dienste', actions: [svc('Spooler', 'Disabled', 'Automatic')] }),
    t('services.xbox-off', 'Xbox-Dienste aus', 'Spart Hintergrundlast, wenn du keine Xbox-App und keinen Game Pass nutzt.', {
      impact: 1, risk: 'moderate', warning: 'Game-Pass-Spiele und Xbox-Erfolge funktionieren nicht mehr.', tags: ['bloat'], group: 'Dienste',
      actions: [svc('XblAuthManager', 'Disabled', 'Manual'), svc('XblGameSave', 'Disabled', 'Manual')] }),
    t('services.maps-off', 'Karten-Updates aus', 'Offline-Karten werden nicht mehr im Hintergrund aktualisiert.', {
      impact: 1, tags: ['bloat', 'network'], group: 'Dienste', actions: [svc('MapsBroker', 'Disabled', 'AutomaticDelayed')] }),
    t('services.wsearch-off', 'Such-Indexierung aus', 'Keine Festplattenlast mehr durch das Durchsuchen aller Dateien.', {
      impact: 2, risk: 'moderate', warning: 'Die Suche im Startmenü und Explorer wird deutlich langsamer.', tags: ['storage', 'stutter'], group: 'Dienste',
      actions: [svc('WSearch', 'Disabled', 'AutomaticDelayed')] }),
    t('services.compat-task-off', 'Kompatibilitäts-Prüfung aus', 'Eine geplante Aufgabe, die regelmäßig alle Programme scannt, läuft nicht mehr.', {
      impact: 1, tags: ['telemetry', 'stutter'], group: 'Aufgaben', actions: [task('\\Microsoft\\Windows\\Application Experience\\ProgramDataUpdater', false, true)] })
  ],
  ui: [
    t('ui.dark-mode', 'Dunkles Design', 'Windows und Apps erscheinen dunkel. Angenehmer für die Augen am Abend.', {
      impact: 1, tags: ['ui', 'quality-of-life'], group: 'Aussehen',
      actions: [reg(HKCU + 'Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', 'AppsUseLightTheme', 'DWord', 0, 1), reg(HKCU + 'Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', 'SystemUsesLightTheme', 'DWord', 0, 0, { defaultWin11: 1 })] }),
    t('ui.file-ext', 'Dateiendungen anzeigen', 'Du siehst, ob eine Datei .exe oder .pdf ist. Schützt vor getarnten Viren.', {
      impact: 1, tags: ['explorer', 'quality-of-life'], needs: 'explorer', group: 'Explorer',
      actions: [reg(HKCU + 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', 'HideFileExt', 'DWord', 0, 1)] }),
    t('ui.classic-context', 'Klassisches Kontextmenü', 'Rechtsklick zeigt sofort alle Optionen, ohne "Weitere Optionen anzeigen".', {
      impact: 2, tags: ['explorer', 'quality-of-life'], needs: 'explorer', when: { os: 'win11' }, group: 'Explorer',
      actions: [{ type: 'regkey', path: HKCU + 'Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32', present: true, default: false }] }),
    t('ui.taskbar-left', 'Startknopf links', 'Taskleiste wie unter Windows 10: Start ganz links.', {
      impact: 1, tags: ['ui'], when: { os: 'win11' }, group: 'Taskleiste',
      actions: [reg(HKCU + 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', 'TaskbarAl', 'DWord', 0, null)] }),
    t('ui.animations-off', 'Fenster-Animationen aus', 'Fenster gehen sofort auf und zu. Fühlt sich auf schwachen PCs schneller an.', {
      impact: 1, risk: 'moderate', warning: 'Windows wirkt weniger weich.', tags: ['ui'], group: 'Aussehen',
      actions: [reg(HKCU + 'Control Panel\\Desktop\\WindowMetrics', 'MinAnimate', 'String', '0', '1')] }),
    t('ui.this-pc', 'Explorer öffnet "Dieser PC"', 'Der Explorer startet bei deinen Laufwerken statt bei "Start".', {
      impact: 1, tags: ['explorer', 'quality-of-life'], group: 'Explorer',
      actions: [reg(HKCU + 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', 'LaunchTo', 'DWord', 1, null)] })
  ],
  games: [
    t('games.fivem-priority', 'FiveM mit hoher CPU-Priorität', 'Der FiveM-Spielprozess bekommt immer Vorrang vor anderen Programmen.', {
      impact: 2, tags: ['fivem', 'gta', 'fps'], group: 'FiveM',
      actions: [reg(HKLM + 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\FiveM_GTAProcess.exe\\PerfOptions', 'CpuPriorityClass', 'DWord', 3, null)] }),
    t('games.fivem-cache', 'FiveM-Cache leeren', 'Behebt Ladeprobleme und Texturfehler auf Servern. Wird beim nächsten Join neu geladen.', {
      kind: 'action', impact: 1, tags: ['fivem', 'cleanup'], group: 'FiveM',
      actions: [clean(['%LOCALAPPDATA%\\FiveM\\FiveM.app\\data\\cache\\*', '%LOCALAPPDATA%\\FiveM\\FiveM.app\\data\\server-cache\\*'])] }),
    t('games.gta-fso-off', 'GTA V: Vollbild-Optimierung aus', 'GTA V läuft im echten Vollbild. Weniger Eingabeverzögerung.', {
      impact: 1, tags: ['gta', 'fivem', 'latency'], group: 'GTA V',
      actions: [reg(HKCU + 'Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers', 'C:\\Program Files\\Rockstar Games\\Grand Theft Auto V\\GTA5.exe', 'String', '~ DISABLEDXMAXIMIZEDWINDOWEDMODE', null)] }),
    t('games.cs2-priority', 'Counter-Strike 2 mit hoher Priorität', 'CS2 bekommt Vorrang auf dem Prozessor.', {
      impact: 1, tags: ['competitive', 'fps'], group: 'Esport',
      actions: [reg(HKLM + 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\cs2.exe\\PerfOptions', 'CpuPriorityClass', 'DWord', 3, null)] })
  ],
  security: [
    t('security.mitigations-off', 'Spectre/Meltdown-Schutz aus', 'Bringt auf älteren Prozessoren ein paar Prozent Leistung zurück.', {
      impact: 2, risk: 'risky', warning: 'Der PC wird anfälliger für Angriffe über Webseiten und Programme.', needs: 'reboot', tags: ['security-off', 'fps'], group: 'Prozessor-Schutz',
      actions: [reg(HKLM + 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management', 'FeatureSettingsOverride', 'DWord', 3, null), reg(HKLM + 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management', 'FeatureSettingsOverrideMask', 'DWord', 3, null)] }),
    t('security.vbs-off', 'Speicherintegrität (HVCI) aus', 'Kann in manchen Spielen 5-10 % mehr FPS bringen.', {
      impact: 3, risk: 'risky', warning: 'Schadsoftware kann sich leichter im Systemkern einnisten. Manche Anti-Cheats verlangen es eingeschaltet.', needs: 'reboot', tags: ['security-off', 'fps'], group: 'Virtualisierung',
      actions: [reg(HKLM + 'SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity', 'Enabled', 'DWord', 0, null)] }),
    t('security.smartscreen-off', 'SmartScreen-Warnungen aus', 'Heruntergeladene Programme starten ohne blaue Warnmeldung.', {
      impact: 1, risk: 'risky', warning: 'Du wirst nicht mehr vor bekannten Schadprogrammen gewarnt.', tags: ['security-off', 'quality-of-life'], group: 'Schutz',
      actions: [reg(POL + '\\System', 'EnableSmartScreen', 'DWord', 0, null)] })
  ],
  cleanup: [
    t('cleanup.temp', 'Temporäre Dateien', 'Reste von Installationen und Programmen. Kann immer gefahrlos weg.', {
      kind: 'action', impact: 2, tags: ['cleanup', 'storage'], actions: [clean(['%TEMP%\\*', '%WINDIR%\\Temp\\*'])] }),
    t('cleanup.wu-cache', 'Windows-Update-Downloads', 'Bereits installierte Update-Dateien. Windows lädt sie bei Bedarf neu.', {
      kind: 'action', impact: 2, tags: ['cleanup', 'storage', 'update'], actions: [clean(['%WINDIR%\\SoftwareDistribution\\Download\\*'], { stopServices: ['wuauserv', 'bits'] })] }),
    t('cleanup.shader-cache', 'Shader-Cache (DirectX, NVIDIA, AMD)', 'Wird beim nächsten Spielstart neu aufgebaut. Hilft bei Grafikfehlern nach Treiber-Updates.', {
      kind: 'action', impact: 1, tags: ['cleanup', 'stutter'], actions: [clean(['%LOCALAPPDATA%\\D3DSCache\\*', '%LOCALAPPDATA%\\NVIDIA\\DXCache\\*', '%LOCALAPPDATA%\\AMD\\DxCache\\*'])] }),
    t('cleanup.thumbnails', 'Miniaturansichten-Cache', 'Vorschaubilder im Explorer. Werden automatisch neu erstellt.', {
      kind: 'action', impact: 1, tags: ['cleanup', 'explorer'], actions: [clean(['%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer\\thumbcache_*.db'])] }),
    t('cleanup.crashdumps', 'Absturzberichte', 'Alte Fehlerberichte und Speicherabbilder von Abstürzen.', {
      kind: 'action', impact: 1, tags: ['cleanup', 'storage'], actions: [clean(['%LOCALAPPDATA%\\CrashDumps\\*', '%PROGRAMDATA%\\Microsoft\\Windows\\WER\\ReportArchive\\*'])] }),
    t('cleanup.recycle', 'Papierkorb leeren', 'Löscht alles im Papierkorb endgültig.', {
      kind: 'action', impact: 1, risk: 'moderate', warning: 'Gelöschte Dateien kannst du danach nicht mehr zurückholen.', tags: ['cleanup', 'storage'], actions: [ps('Clear-RecycleBin -Force -ErrorAction Stop')] })
  ],
  repair: [
    t('repair.sfc', 'Systemdateien prüfen (SFC)', 'Sucht beschädigte Windows-Dateien und ersetzt sie. Dauert 5-15 Minuten.', {
      kind: 'action', impact: 1, tags: ['repair'], actions: [ps('sfc.exe /scannow | Out-Null')] }),
    t('repair.dism', 'Windows-Abbild reparieren (DISM)', 'Repariert die Quelle, aus der SFC Dateien wiederherstellt. Braucht Internet.', {
      kind: 'action', impact: 1, tags: ['repair'], actions: [ps('DISM.exe /Online /Cleanup-Image /RestoreHealth | Out-Null')] }),
    t('repair.network-reset', 'Netzwerk zurücksetzen', 'Hilft bei "kein Internet" trotz Verbindung. Setzt Winsock und TCP/IP zurück.', {
      kind: 'action', impact: 1, risk: 'moderate', warning: 'VPN-Adapter und feste IP-Einstellungen müssen danach neu eingerichtet werden.', needs: 'reboot', tags: ['repair', 'network'],
      actions: [ps('netsh.exe winsock reset | Out-Null; netsh.exe int ip reset | Out-Null')] }),
    t('repair.icon-cache', 'Symbol-Cache neu aufbauen', 'Behebt falsche oder leere Symbole auf dem Desktop und im Explorer.', {
      kind: 'action', impact: 1, needs: 'explorer', tags: ['repair', 'explorer'], actions: [clean(['%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer\\iconcache_*.db'])] }),
    t('repair.store-reset', 'Microsoft Store zurücksetzen', 'Hilft, wenn der Store nicht lädt oder Downloads hängen.', {
      kind: 'action', impact: 1, tags: ['repair'], actions: [ps('Start-Process wsreset.exe -Wait')] })
  ],
  apps: [
    t('apps.bing-news', 'Microsoft News', 'Nachrichten-App mit viel Werbung.', { kind: 'remove', impact: 1, tags: ['bloat', 'ads'], when: { package: 'Microsoft.BingNews' }, actions: [appx('Microsoft.BingNews')] }),
    t('apps.bing-weather', 'Wetter', 'Wetter-App von MSN. Das Wetter findest du auch im Browser.', { kind: 'remove', impact: 1, tags: ['bloat'], when: { package: 'Microsoft.BingWeather' }, actions: [appx('Microsoft.BingWeather')] }),
    t('apps.solitaire', 'Solitaire Collection', 'Kartenspiele mit Werbung und Abo-Angeboten.', { kind: 'remove', impact: 1, tags: ['bloat', 'ads'], when: { package: 'Microsoft.MicrosoftSolitaireCollection' }, actions: [appx('Microsoft.MicrosoftSolitaireCollection')] }),
    t('apps.clipchamp', 'Clipchamp', 'Video-Editor, der im Hintergrund Updates lädt.', { kind: 'remove', impact: 1, tags: ['bloat'], when: { package: 'Clipchamp.Clipchamp' }, actions: [appx('Clipchamp.Clipchamp')] }),
    t('apps.teams-personal', 'Teams (privat)', 'Die Privat-Version von Teams startet sonst automatisch mit.', { kind: 'remove', impact: 2, tags: ['bloat', 'boot'], when: { package: 'MSTeams' }, actions: [appx('MSTeams')] }),
    t('apps.getstarted', 'Tipps', 'Einführungs-App von Windows.', { kind: 'remove', impact: 1, tags: ['bloat'], when: { package: 'Microsoft.Getstarted' }, actions: [appx('Microsoft.Getstarted')] }),
    t('apps.cortana', 'Cortana', 'Alte Sprachassistentin, unter Windows 11 eingestellt.', { kind: 'remove', impact: 1, tags: ['bloat', 'ai'], when: { package: 'Microsoft.549981C3F5F10' }, actions: [appx('Microsoft.549981C3F5F10')] })
  ]
};

export const presets = [
  { id: 'safe', name: 'Sicherer Boost', tagline: 'Spürbar schneller, null Risiko', desc: 'Nur Tweaks ohne Nachteile. Perfekt, wenn du einfach einen schnelleren PC willst.', icon: 'shield', maxRisk: 'safe', recommendedFor: ['desktop', 'laptop'],
    ids: ['gaming.gamedvr-off', 'gaming.gamemode-on', 'latency.mouse-accel-off', 'system.startup-delay-off', 'system.menu-delay', 'privacy.adid-off', 'debloat.start-ads-off', 'network.delivery-opt-off'] },
  { id: 'gaming', name: 'Gaming Max', tagline: 'Maximale FPS, Sicherheit bleibt an', desc: 'Alles, was Spiele schneller und flüssiger macht. Ideal für Desktop-PCs.', icon: 'gamepad', maxRisk: 'moderate', recommendedFor: ['desktop'],
    ids: ['gaming.gamedvr-off', 'gaming.gamemode-on', 'gaming.hags-on', 'gaming.mmcss-games', 'gaming.responsiveness', 'power.ultimate-plan', 'power.core-parking-off', 'power.throttling-off', 'network.throttling-off', 'memory.sysmain-off', 'gpu.nvidia-telemetry-off'] },
  { id: 'competitive', name: 'Esport / Low Latency', tagline: 'Jede Millisekunde zählt', desc: 'Für kompetitive Shooter: weniger Eingabeverzögerung, direkteres Zielen, niedrigerer Ping.', icon: 'target', maxRisk: 'moderate', recommendedFor: ['desktop'],
    ids: ['latency.mouse-accel-off', 'latency.dynamic-tick-off', 'latency.timer-res', 'gaming.priority-sep', 'network.nagle-off', 'network.throttling-off', 'power.ultimate-plan', 'gaming.gamedvr-off'] },
  { id: 'laptop', name: 'Laptop & Akku', tagline: 'Schneller, ohne den Akku zu killen', desc: 'Entfernt Ballast und Hintergrundlast, lässt aber das Energiesparen in Ruhe.', icon: 'battery', maxRisk: 'moderate', recommendedFor: ['laptop'],
    ids: ['gaming.gamedvr-off', 'system.startup-delay-off', 'debloat.widgets-off', 'debloat.start-ads-off', 'privacy.telemetry-min', 'services.maps-off'] },
  { id: 'privacy', name: 'Datenschutz', tagline: 'Weniger Daten an Microsoft', desc: 'Telemetrie, Werbe-ID, Aktivitätsverlauf und KI-Funktionen aus.', icon: 'eye-off', maxRisk: 'moderate', recommendedFor: [],
    ids: ['privacy.telemetry-min', 'privacy.adid-off', 'privacy.activity-off', 'privacy.ceip-tasks-off', 'privacy.feedback-off', 'debloat.copilot-off', 'debloat.recall-off', 'debloat.bing-search-off'] },
  { id: 'streaming', name: 'Streamer', tagline: 'Spiel und Stream gleichzeitig flüssig', desc: 'Lässt genug Luft für OBS und Discord, ohne Spiel-FPS zu verschenken.', icon: 'broadcast', maxRisk: 'moderate', recommendedFor: ['desktop'],
    ids: ['gaming.gamedvr-off', 'gaming.gamemode-on', 'power.ultimate-plan', 'network.throttling-off', 'network.autotuning'] },
  { id: 'fivem', name: 'FiveM / GTA V', tagline: 'Flüssig durch Los Santos', desc: 'Speziell für FiveM-Server: weniger Ruckler in der Stadt, schnelleres Laden.', icon: 'car', maxRisk: 'moderate', recommendedFor: [],
    ids: ['games.fivem-priority', 'games.gta-fso-off', 'gaming.gamedvr-off', 'gaming.mmcss-games', 'power.ultimate-plan', 'network.throttling-off', 'memory.sysmain-off'] },
  { id: 'clean', name: 'Aufräumen', tagline: 'Platz schaffen in einem Klick', desc: 'Temporäre Dateien, Update-Reste und Caches löschen.', icon: 'broom', maxRisk: 'safe', recommendedFor: [],
    ids: ['cleanup.temp', 'cleanup.wu-cache', 'cleanup.shader-cache', 'cleanup.thumbnails', 'cleanup.crashdumps'] },
  { id: 'ultimate', name: 'Alles außer riskant', tagline: 'Das volle Programm', desc: 'Jeder sichere und mittlere Tweak, der auf deinen PC passt. Für Leute, die alles wollen.', icon: 'rocket', maxRisk: 'moderate', recommendedFor: ['desktop'],
    ids: [] /* filled by the mock server: every applicable non-risky toggle */ }
];

export const detweak = {
  registry: [
    { path: HKLM + 'SYSTEM\\CurrentControlSet\\Control\\PriorityControl', name: 'Win32PrioritySeparation', kind: 'DWord', default: 2, label: 'CPU-Zeitverteilung (Win32PrioritySeparation)', group: 'CPU & Scheduler' },
    { path: MMCSS, name: 'SystemResponsiveness', kind: 'DWord', default: 20, label: 'Systemreserve (SystemResponsiveness)', group: 'CPU & Scheduler' },
    { path: MMCSS, name: 'NetworkThrottlingIndex', kind: 'DWord', default: 10, label: 'Netzwerk-Drosselung (NetworkThrottlingIndex)', group: 'Netzwerk' },
    { path: HKLM + 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management', name: 'LargeSystemCache', kind: 'DWord', default: 0, label: 'Großer System-Cache', group: 'Speicher' },
    { path: HKLM + 'SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters', name: 'DefaultTTL', kind: 'DWord', default: null, label: 'TCP Default TTL', group: 'Netzwerk' },
    { path: HKCU + 'Control Panel\\Mouse', name: 'MouseSensitivity', kind: 'String', default: '10', label: 'Mausempfindlichkeit', group: 'Eingabe' }
  ],
  registryKeys: [
    { path: HKLM + 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\*\\PerfOptions', label: 'Prozess-Prioritäten per IFEO', group: 'Prozesse' }
  ],
  bcd: [
    { name: 'useplatformclock', label: 'HPET erzwungen', group: 'Boot & Timer' },
    { name: 'disabledynamictick', label: 'Dynamischer Tick aus', group: 'Boot & Timer' },
    { name: 'useplatformtick', label: 'Plattform-Tick erzwungen', group: 'Boot & Timer' },
    { name: 'tscsyncpolicy', label: 'TSC-Synchronisation geändert', group: 'Boot & Timer' }
  ],
  services: [
    { name: 'SysMain', default: 'Automatic', label: 'SysMain (Superfetch)', group: 'Dienste' },
    { name: 'DiagTrack', default: 'Automatic', label: 'Telemetrie-Dienst (DiagTrack)', group: 'Dienste' },
    { name: 'WSearch', default: 'AutomaticDelayed', label: 'Windows-Suche', group: 'Dienste' },
    { name: 'Spooler', default: 'Automatic', label: 'Druckwarteschlange', group: 'Dienste' }
  ],
  tasks: [
    { path: '\\Microsoft\\Windows\\Defrag\\ScheduledDefrag', default: true, label: 'Laufwerke optimieren (geplant)', group: 'Aufgaben' }
  ],
  commands: [
    { id: 'power-defaults', label: 'Energiepläne auf Standard', desc: 'Löscht eigene Energiepläne anderer Tools und stellt die Windows-Pläne wieder her.', defaultOn: true, needs: 'none', script: 'powercfg -restoredefaultschemes' },
    { id: 'tcp-reset', label: 'TCP/IP-Einstellungen zurücksetzen', desc: 'Setzt alle Netzwerk-Feineinstellungen auf Windows-Standard. Danach Neustart nötig.', defaultOn: true, needs: 'reboot', script: 'netsh int ip reset' },
    { id: 'mmagent-defaults', label: 'Speicherverwaltung auf Standard', desc: 'Schaltet Speicherkomprimierung und Vorab-Laden wieder ein.', defaultOn: true, needs: 'none', script: 'Enable-MMAgent -MemoryCompression' },
    { id: 'nvidia-profile', label: 'NVIDIA-Profil zurücksetzen', desc: 'Setzt Änderungen aus dem NVIDIA Profile Inspector zurück. Nur wenn du ihn benutzt hast.', defaultOn: false, needs: 'none', script: 'nvidiaProfileInspector.exe -restore' }
  ]
};

// Same shape as core/Scan.ps1 produces.
export const profiles = {
  desktop: {
    os: { caption: 'Windows 11 Pro', build: 22631, displayVersion: '23H2', isWin11: true, edition: 'Professional' },
    cpu: { name: 'AMD Ryzen 7 7800X3D 8-Core Processor', vendor: 'amd', cores: 8, threads: 16, maxMHz: 4200 },
    gpus: [{ name: 'NVIDIA GeForce RTX 4070 SUPER', vendor: 'nvidia', vramGB: 12, driver: '32.0.15.6636' }],
    ram: { totalGB: 32, type: 'DDR5', speedMHz: 6000, configuredMHz: 6000, modules: 2 },
    disks: [{ model: 'Samsung SSD 990 PRO 1TB', media: 'ssd', bus: 'nvme', sizeGB: 1000 }, { model: 'WDC WD20EZBX', media: 'hdd', bus: 'sata', sizeGB: 2000 }],
    systemDisk: 'ssd',
    systemDriveFreeGB: 412.4,
    formFactor: 'desktop',
    battery: false,
    display: { width: 2560, height: 1440, currentHz: 144, maxHz: 165 },
    power: { activePlan: '381b4222-f694-41f0-9685-ff5bb260df2e', name: 'Ausbalanciert' },
    security: { vbs: true, hvci: true, defenderRealtime: true },
    gaming: { gameMode: true, hags: false, gameDvr: true },
    network: [{ name: 'Ethernet', type: 'ethernet', linkMbps: 1000 }],
    startupCount: 7,
    uptimeHours: 31.5,
    tempMB: 1840
  },
  laptop: {
    os: { caption: 'Windows 10 Home', build: 19045, displayVersion: '22H2', isWin11: false, edition: 'Core' },
    cpu: { name: '12th Gen Intel(R) Core(TM) i7-12700H', vendor: 'intel', cores: 14, threads: 20, maxMHz: 2300 },
    gpus: [{ name: 'NVIDIA GeForce RTX 3060 Laptop GPU', vendor: 'nvidia', vramGB: 6, driver: '31.0.15.5222' }, { name: 'Intel(R) Iris(R) Xe Graphics', vendor: 'intel', vramGB: 1, driver: '31.0.101.5186' }],
    ram: { totalGB: 16, type: 'DDR4', speedMHz: 3200, configuredMHz: 3200, modules: 2 },
    disks: [{ model: 'SAMSUNG MZVL2512HCJQ', media: 'ssd', bus: 'nvme', sizeGB: 512 }],
    systemDisk: 'ssd',
    systemDriveFreeGB: 61.2,
    formFactor: 'laptop',
    battery: true,
    display: { width: 1920, height: 1080, currentHz: 60, maxHz: 144 },
    power: { activePlan: '381b4222-f694-41f0-9685-ff5bb260df2e', name: 'Ausbalanciert' },
    security: { vbs: true, hvci: true, defenderRealtime: true },
    gaming: { gameMode: true, hags: false, gameDvr: true },
    network: [{ name: 'WLAN', type: 'wifi', linkMbps: 866 }],
    startupCount: 11,
    uptimeHours: 52,
    tempMB: 900
  }
};
