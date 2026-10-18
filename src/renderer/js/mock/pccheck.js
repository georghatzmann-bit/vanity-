// Simulator für den PC-Check (nur Browser-Vorschau).
// Beispiel-PC: Ryzen 5 7600X, RTX 4070 (12 GB), 32 GB DDR5, 1920 × 1080 mit 165 Hz + zweiter Bildschirm.
// Die Daten stammen aus der echten Logik (src/main/tools/pccheck-logic.js) mit einer typischen GameUserSettings.ini.
// Adresszusätze: ?nowin = kein Windows, ?nofile = GameUserSettings.ini fehlt, ?running = Fortnite läuft.

const HARDWARE = {
  cpu: {"name":"AMD Ryzen 5 7600X 6-Core Processor","cores":6,"threads":12,"clockMHz":4701,"source":"windows","short":"AMD Ryzen 5 7600X"},
  gpu: {"name":"NVIDIA GeForce RTX 4070","short":"RTX 4070","driver":"32.0.15.6636","driverShown":"566.36","driverDate":"2025-08-21","vramBytes":12884901888,"vramSource":"registry","vramCapped":false,"refreshHz":165,"maxRefreshHz":165,"resX":1920,"resY":1080,"vendor":"nvidia","score":50,"known":true,"integrated":false,"mobile":false,"reflex":true,"rtx":true,"family":"rtx"},
  gpus: [{"name":"NVIDIA GeForce RTX 4070","short":"RTX 4070","driver":"32.0.15.6636","driverShown":"566.36","driverDate":"2025-08-21","vramBytes":12884901888,"vramSource":"registry","vramCapped":false,"refreshHz":165,"maxRefreshHz":165,"resX":1920,"resY":1080,"vendor":"nvidia","score":50,"known":true,"integrated":false,"mobile":false,"reflex":true,"rtx":true,"family":"rtx"}],
  ram: {"totalBytes":34359738368,"gb":32,"modules":2,"speedMTs":4800,"ratedMTs":4800,"type":"DDR5"},
  display: {"id":1,"label":"AOC 24G2","width":1920,"height":1080,"hz":165,"scale":1,"internal":false,"primary":true},
  displays: [{"id":1,"label":"AOC 24G2","width":1920,"height":1080,"hz":165,"scale":1,"internal":false,"primary":true},{"id":2,"label":"DELL P2419H","width":1920,"height":1080,"hz":60,"scale":1.25,"internal":false,"primary":false}],
  os: {"caption":"Microsoft Windows 11 Home","build":26100,"win11":true},
};

const RATINGS = {
  cpu: {"tier":3,"score":84,"known":true,"label":"stark","tone":"ok","text":"Schneller Prozessor. Er schafft hohe FPS.","details":"6 Kerne · 12 Threads (gleichzeitige Aufgaben) · 4,7 GHz Grundtakt"},
  gpu: {"tier":4,"label":"sehr stark","tone":"ok","text":"Sehr starke Grafikkarte. Hohe FPS und schöne Grafik sind kein Problem.","details":"12 GB Grafikspeicher · Treiber 566.36","tips":[{"kind":"driver","vendor":"nvidia","text":"Dein Grafiktreiber ist vom 21.08.2025. Ein aktueller Treiber behebt oft Ruckler und bringt FPS."}]},
  ram: {"cap":4,"label":"sehr gut","tone":"ok","text":"32 GB sind mehr als genug für Fortnite.","details":"32 GB · DDR5 · 4800 MHz · 2 Riegel","tips":[{"kind":"xmp","text":"Der Speicher läuft mit Grundtempo (4800 MHz). Viele Riegel schaffen mehr, wenn im BIOS „XMP“ oder „EXPO“ (fertiges Tempo-Profil des Herstellers) eingeschaltet ist."}]},
  display: {"label":"schnell","tone":"ok","text":"Gaming-Monitor: Er zeigt bis zu 165 Bilder pro Sekunde (165 Hz).","details":"1920 × 1080 · 165 Hz · +1 weiterer Bildschirm","tips":[{"kind":"multi","text":"Fortnite startet auf deinem Hauptbildschirm. HELIX richtet die Auflösung nach ihm aus."}]},
};

const PERF = {"cls":4,"label":"Sehr stark","text":"Sehr starker PC. Auch hohe Grafik läuft flüssig.","limiter":null,"limiterText":"Die Teile passen gut zusammen – keins bremst stark.","gpuTier":4,"cpuTier":3};

const PRESETS = [
  {"id":"leistung","title":"Leistung","desc":"Meiste FPS und klare Sicht. Schlichte Grafik – ideal für Ranked und Turniere.","mode":"Leistungsmodus","quality":"Niedrig","est":{"typical":390,"low":290,"high":450,"limitedBy":"cpu"},"fps":{"cap":0,"reason":"unlimited","why":"Ohne Grenze: Dein PC schafft viel mehr Bilder, als dein Monitor zeigt (165 Hz). So reagiert das Spiel minimal schneller. Wird der PC laut oder heiß, stell die Grenze auf 165.","recommendedCap":0,"recommendedReason":"unlimited"},"fpsOptions":[60,120,144,165,240,0],"warnings":[],"heavy":false,"recommended":false,"itemCount":21},
  {"id":"ausgewogen","title":"Ausgewogen","desc":"Gutes Bild und trotzdem flüssig. DirectX 12 mit so viel Details, wie dein PC locker schafft.","mode":"DirectX 12","quality":"Hoch","est":{"typical":270,"low":200,"high":310,"limitedBy":"cpu"},"fps":{"cap":165,"reason":"hz","why":"Genau so viele Bilder, wie dein Monitor zeigen kann (165 Hz). Das läuft gleichmäßig und hält den PC kühler und leiser.","recommendedCap":165,"recommendedReason":"hz"},"fpsOptions":[60,120,144,165,240,0],"warnings":[],"heavy":false,"recommended":true,"itemCount":20},
  {"id":"qualitaet","title":"Qualität","desc":"Das schönste Bild für deinen PC: Licht, Schatten und Details. Dafür weniger FPS.","mode":"DirectX 12","quality":"Episch","est":{"typical":110,"low":85,"high":130,"limitedBy":"gpu"},"fps":{"cap":60,"reason":"stable","why":"Dein PC schafft in Kämpfen grob 85 Bilder pro Sekunde. Eine feste Grenze von 60 sorgt für ein gleichmäßiges Spielgefühl statt Ruckeln.","recommendedCap":60,"recommendedReason":"stable"},"fpsOptions":[60,120,144,165,240,0],"warnings":[],"heavy":false,"recommended":false,"itemCount":20},
];

const EXTRA = {"warnings":[],"hz":165,"recommended":"ausgewogen","recommendReason":"Dein PC schafft damit auch in Kämpfen grob 200 FPS – genug für deinen 165-Hz-Monitor – und das Bild sieht deutlich besser aus.","competitiveTip":"Spielst du vor allem Ranked oder Turniere, nimm „Leistung“ – dort sind mehr FPS wichtiger als schöne Grafik."};

// So ist Fortnite gerade eingestellt (Simulator)
const START = {"renderMode":"DirectX 12","resolution":"1920 × 1080","windowMode":"Fenster-Vollbild","fps":"60 FPS","vsync":"An","reflex":"An","res3d":"100 %","viewDistance":"Episch","textures":"Episch","meshes":"nicht gesetzt","shadows":"Hoch","gi":"Hoch","reflections":"Hoch","effects":"Hoch","postprocess":"Hoch","details":"Hoch","aa":"TSR hoch","grass":"An","motionBlur":"An","nanite":"Aus","raytracing":"Aus"};

const ROWS = {
  leistung: [
    ["renderMode","Darstellungsmodus","Anzeige","Leistungsmodus","Der Leistungsmodus ist Fortnites eigener Modus für hohe FPS: schlichte Grafik, sehr flüssig, wenig Ruckler.",["PreferredRHI","PreferredFeatureLevel"]],
    ["resolution","Auflösung","Anzeige","1920 × 1080","Die volle Auflösung deines Monitors (1920 × 1080) gibt das schärfste Bild. Eine kleinere Auflösung bringt kaum FPS, macht Gegner auf Distanz aber unscharf.",["ResolutionSizeX","ResolutionSizeY","LastUserConfirmedResolutionSizeX","LastUserConfirmedResolutionSizeY","DesiredScreenWidth","DesiredScreenHeight","LastUserConfirmedDesiredScreenWidth","LastUserConfirmedDesiredScreenHeight"]],
    ["windowMode","Anzeigemodus","Anzeige","Vollbild","Echtes Vollbild: Windows mischt sich nicht ein, das gibt die geringste Verzögerung. Wechselst du oft mit Alt+Tab, ist „Fenster-Vollbild“ bequemer.",["FullscreenMode","LastConfirmedFullscreenMode","PreferredFullscreenMode"]],
    ["fps","FPS-Grenze","Anzeige","Unbegrenzt","Ohne Grenze: Dein PC schafft viel mehr Bilder, als dein Monitor zeigt (165 Hz). So reagiert das Spiel minimal schneller. Wird der PC laut oder heiß, stell die Grenze auf 165.",["FrameRateLimit"]],
    ["vsync","VSync","Anzeige","Aus","VSync wartet bei jedem Bild auf den Monitor. Das verhindert Bildrisse, macht die Maus aber spürbar träger.",["bUseVSync"]],
    ["reflex","NVIDIA Reflex","Anzeige","An + Boost","NVIDIA Reflex verkürzt die Zeit zwischen Klick und Bild. „An + Boost“ hält die Grafikkarte dabei auf vollem Takt.",["LatencyTweak2"]],
    ["res3d","3D-Auflösung","Grafik","100 %","100 % heißt: Das Spiel wird in voller Schärfe berechnet.",["sg.ResolutionQuality"]],
    ["viewDistance","Sichtweite","Grafik","Episch","Wie weit entfernte Gebäude und Objekte mit Details gezeigt werden. „Episch“ kostet wenig Leistung und hilft, Gegner früh zu sehen.",["sg.ViewDistanceQuality"]],
    ["textures","Texturen","Grafik","Mittel","Texturen sind die Oberflächenbilder und brauchen vor allem Grafikspeicher. Mit 12 GB passt „Mittel“ – mehr bringt im Leistungsmodus kaum etwas.",["sg.TextureQuality"]],
    ["meshes","Objekt-Details (Meshes)","Grafik","Niedrig","Wie fein Objekte im Leistungsmodus gebaut sind. „Niedrig“ bringt die meisten FPS.",["MeshQuality"]],
    ["shadows","Schatten","Grafik","Aus","Schatten aus: mehr FPS, und Gegner in dunklen Ecken sind leichter zu sehen.",["sg.ShadowQuality"]],
    ["gi","Globale Beleuchtung","Grafik","Aus","Wie Licht von Wänden zurückstrahlt. „Aus“ bringt die meisten FPS.",["DesiredGlobalIlluminationQuality","sg.GlobalIlluminationQuality"]],
    ["reflections","Reflexionen","Grafik","Aus","Spiegelungen auf Wasser und Glas. „Aus“ spart Leistung.",["DesiredReflectionQuality","sg.ReflectionQuality"]],
    ["effects","Effekte","Grafik","Niedrig","Explosionen, Rauch und Funken. „Niedrig“ sorgt für klare Sicht in Kämpfen.",["sg.EffectsQuality"]],
    ["postprocess","Nachbearbeitung","Grafik","Niedrig","Filter über dem ganzen Bild (z. B. Leuchten). „Niedrig“ = klareres Bild und mehr FPS.",["sg.PostProcessQuality"]],
    ["details","Pflanzen & Oberflächen","Grafik","Niedrig","Pflanzen-Dichte und feine Oberflächen. Im Spielmenü nicht einzeln einstellbar – HELIX setzt sie passend zum Rest.",["sg.FoliageQuality","sg.ShadingQuality"]],
    ["aa","Kantenglättung","Grafik","Aus","Kantenglättung aus: Das Bild bleibt gestochen scharf ohne Nachzieh-Effekte und kostet keine Leistung. Kanten flimmern dafür etwas.",["FortAntiAliasingMethod","sg.AntiAliasingQuality"]],
    ["grass","Gras","Extras","Aus","Gras aus: mehr FPS und freie Sicht auf den Boden.",["bShowGrass"]],
    ["motionBlur","Bewegungsunschärfe","Extras","Aus","Bewegungsunschärfe verwischt das Bild bei schnellen Drehungen – Gegner sind dann schwerer zu treffen.",["bMotionBlur"]],
    ["nanite","Nanite","Extras","Aus","Nanite (sehr feine Geometrie) kostet viel Leistung. Aus = mehr FPS.",["bUseNanite"]],
    ["raytracing","Raytracing","Extras","Aus","Raytracing (berechnetes Licht in Echtzeit) sieht toll aus, halbiert aber oft die FPS. Für Fortnite lohnt es sich kaum.",["bRayTracing"]],
  ],
  ausgewogen: [
    ["renderMode","Darstellungsmodus","Anzeige","DirectX 12","DirectX 12 ist der normale Grafikmodus mit allen Details. (DirectX 11 gibt es in Fortnite nicht mehr.)",["PreferredRHI","PreferredFeatureLevel"]],
    ["resolution","Auflösung","Anzeige","1920 × 1080","Die volle Auflösung deines Monitors (1920 × 1080) gibt das schärfste Bild. Eine kleinere Auflösung bringt kaum FPS, macht Gegner auf Distanz aber unscharf.",["ResolutionSizeX","ResolutionSizeY","LastUserConfirmedResolutionSizeX","LastUserConfirmedResolutionSizeY","DesiredScreenWidth","DesiredScreenHeight","LastUserConfirmedDesiredScreenWidth","LastUserConfirmedDesiredScreenHeight"]],
    ["windowMode","Anzeigemodus","Anzeige","Vollbild","Echtes Vollbild: Windows mischt sich nicht ein, das gibt die geringste Verzögerung. Wechselst du oft mit Alt+Tab, ist „Fenster-Vollbild“ bequemer.",["FullscreenMode","LastConfirmedFullscreenMode","PreferredFullscreenMode"]],
    ["fps","FPS-Grenze","Anzeige","165 FPS","Genau so viele Bilder, wie dein Monitor zeigen kann (165 Hz). Das läuft gleichmäßig und hält den PC kühler und leiser.",["FrameRateLimit"]],
    ["vsync","VSync","Anzeige","Aus","VSync wartet bei jedem Bild auf den Monitor. Das verhindert Bildrisse, macht die Maus aber spürbar träger.",["bUseVSync"]],
    ["reflex","NVIDIA Reflex","Anzeige","An + Boost","NVIDIA Reflex verkürzt die Zeit zwischen Klick und Bild. „An + Boost“ hält die Grafikkarte dabei auf vollem Takt.",["LatencyTweak2"]],
    ["res3d","3D-Auflösung","Grafik","100 %","100 % heißt: Das Spiel wird in voller Schärfe berechnet.",["sg.ResolutionQuality"]],
    ["viewDistance","Sichtweite","Grafik","Episch","Wie weit entfernte Gebäude und Objekte mit Details gezeigt werden. „Episch“ kostet wenig Leistung und hilft, Gegner früh zu sehen.",["sg.ViewDistanceQuality"]],
    ["textures","Texturen","Grafik","Hoch","Texturen sind die Oberflächenbilder und brauchen vor allem Grafikspeicher. Mit 12 GB passt „Hoch“.",["sg.TextureQuality"]],
    ["shadows","Schatten","Grafik","Hoch","Schatten auf „Hoch“ sehen natürlich aus und kosten nur mäßig FPS.",["sg.ShadowQuality"]],
    ["gi","Globale Beleuchtung","Grafik","Mittel","Wie Licht von Wänden zurückstrahlt. Auf „Mittel“ bleibt das teure Lumen-Licht aus – das spart viele FPS.",["DesiredGlobalIlluminationQuality","sg.GlobalIlluminationQuality"]],
    ["reflections","Reflexionen","Grafik","Mittel","Spiegelungen auf Wasser und Glas. „Mittel“ spart Leistung.",["DesiredReflectionQuality","sg.ReflectionQuality"]],
    ["effects","Effekte","Grafik","Hoch","Explosionen, Rauch und Funken sehen auf „Hoch“ deutlich schöner aus.",["sg.EffectsQuality"]],
    ["postprocess","Nachbearbeitung","Grafik","Hoch","Filter über dem ganzen Bild (z. B. Leuchten). „Hoch“ macht das Bild stimmungsvoller.",["sg.PostProcessQuality"]],
    ["details","Pflanzen & Oberflächen","Grafik","Hoch","Pflanzen-Dichte und feine Oberflächen. Im Spielmenü nicht einzeln einstellbar – HELIX setzt sie passend zum Rest.",["sg.FoliageQuality","sg.ShadingQuality"]],
    ["aa","Kantenglättung","Grafik","TSR mittel","TSR (Epics Kantenglättung) glättet Kanten sauber. „Mittel“ ist ein guter Mittelweg aus Schärfe und Leistung.",["FortAntiAliasingMethod","sg.AntiAliasingQuality"]],
    ["grass","Gras","Extras","An","Gras an: Die Landschaft wirkt lebendiger. Kostet etwas Leistung.",["bShowGrass"]],
    ["motionBlur","Bewegungsunschärfe","Extras","Aus","Bewegungsunschärfe verwischt das Bild bei schnellen Drehungen – Gegner sind dann schwerer zu treffen.",["bMotionBlur"]],
    ["nanite","Nanite","Extras","Aus","Nanite (sehr feine Geometrie) kostet viel Leistung. Aus = mehr FPS.",["bUseNanite"]],
    ["raytracing","Raytracing","Extras","Aus","Raytracing (berechnetes Licht in Echtzeit) sieht toll aus, halbiert aber oft die FPS. Für Fortnite lohnt es sich kaum.",["bRayTracing"]],
  ],
  qualitaet: [
    ["renderMode","Darstellungsmodus","Anzeige","DirectX 12","DirectX 12 ist der normale Grafikmodus mit allen Details. (DirectX 11 gibt es in Fortnite nicht mehr.)",["PreferredRHI","PreferredFeatureLevel"]],
    ["resolution","Auflösung","Anzeige","1920 × 1080","Die volle Auflösung deines Monitors (1920 × 1080) gibt das schärfste Bild. Eine kleinere Auflösung bringt kaum FPS, macht Gegner auf Distanz aber unscharf.",["ResolutionSizeX","ResolutionSizeY","LastUserConfirmedResolutionSizeX","LastUserConfirmedResolutionSizeY","DesiredScreenWidth","DesiredScreenHeight","LastUserConfirmedDesiredScreenWidth","LastUserConfirmedDesiredScreenHeight"]],
    ["windowMode","Anzeigemodus","Anzeige","Vollbild","Echtes Vollbild: Windows mischt sich nicht ein, das gibt die geringste Verzögerung. Wechselst du oft mit Alt+Tab, ist „Fenster-Vollbild“ bequemer.",["FullscreenMode","LastConfirmedFullscreenMode","PreferredFullscreenMode"]],
    ["fps","FPS-Grenze","Anzeige","60 FPS","Dein PC schafft in Kämpfen grob 85 Bilder pro Sekunde. Eine feste Grenze von 60 sorgt für ein gleichmäßiges Spielgefühl statt Ruckeln.",["FrameRateLimit"]],
    ["vsync","VSync","Anzeige","Aus","VSync wartet bei jedem Bild auf den Monitor. Das verhindert Bildrisse, macht die Maus aber spürbar träger.",["bUseVSync"]],
    ["reflex","NVIDIA Reflex","Anzeige","An + Boost","NVIDIA Reflex verkürzt die Zeit zwischen Klick und Bild. „An + Boost“ hält die Grafikkarte dabei auf vollem Takt.",["LatencyTweak2"]],
    ["res3d","3D-Auflösung","Grafik","100 %","100 % heißt: Das Spiel wird in voller Schärfe berechnet.",["sg.ResolutionQuality"]],
    ["viewDistance","Sichtweite","Grafik","Episch","Wie weit entfernte Gebäude und Objekte mit Details gezeigt werden. „Episch“ kostet wenig Leistung und hilft, Gegner früh zu sehen.",["sg.ViewDistanceQuality"]],
    ["textures","Texturen","Grafik","Episch","Texturen sind die Oberflächenbilder und brauchen vor allem Grafikspeicher. Mit 12 GB passt „Episch“.",["sg.TextureQuality"]],
    ["shadows","Schatten","Grafik","Episch","Schatten auf „Episch“ für ein echtes Bild. Schatten kosten viel Leistung – wird es zu langsam, stell sie zuerst runter.",["sg.ShadowQuality"]],
    ["gi","Globale Beleuchtung","Grafik","Episch","Wie Licht von Wänden zurückstrahlt. Ab „Hoch“ nutzt Fortnite „Lumen“ (sehr echtes Licht) – sieht toll aus, kostet aber viel Leistung.",["DesiredGlobalIlluminationQuality","sg.GlobalIlluminationQuality"]],
    ["reflections","Reflexionen","Grafik","Episch","Spiegelungen auf Wasser und Glas. Ab „Hoch“ mit Lumen: echte Spiegelungen, kostet viel Leistung.",["DesiredReflectionQuality","sg.ReflectionQuality"]],
    ["effects","Effekte","Grafik","Episch","Explosionen, Rauch und Funken sehen auf „Episch“ deutlich schöner aus.",["sg.EffectsQuality"]],
    ["postprocess","Nachbearbeitung","Grafik","Episch","Filter über dem ganzen Bild (z. B. Leuchten). „Episch“ macht das Bild stimmungsvoller.",["sg.PostProcessQuality"]],
    ["details","Pflanzen & Oberflächen","Grafik","Episch","Pflanzen-Dichte und feine Oberflächen. Im Spielmenü nicht einzeln einstellbar – HELIX setzt sie passend zum Rest.",["sg.FoliageQuality","sg.ShadingQuality"]],
    ["aa","Kantenglättung","Grafik","TSR mittel","TSR (Epics Kantenglättung) glättet Kanten sauber. „Mittel“ ist ein guter Mittelweg aus Schärfe und Leistung. Mit deiner RTX-Karte kannst du im Spiel auch „NVIDIA DLSS“ wählen – das bringt mehr FPS bei fast gleichem Bild.",["FortAntiAliasingMethod","sg.AntiAliasingQuality"]],
    ["grass","Gras","Extras","An","Gras an: Die Landschaft wirkt lebendiger. Kostet etwas Leistung.",["bShowGrass"]],
    ["motionBlur","Bewegungsunschärfe","Extras","Aus","Bewegungsunschärfe verwischt das Bild bei schnellen Drehungen – Gegner sind dann schwerer zu treffen.",["bMotionBlur"]],
    ["nanite","Nanite","Extras","An","Nanite zeigt Gebäude und Felsen extrem detailreich. Deine Grafikkarte ist stark genug dafür.",["bUseNanite"]],
    ["raytracing","Raytracing","Extras","Aus","Raytracing (berechnetes Licht in Echtzeit) sieht toll aus, halbiert aber oft die FPS. Für Fortnite lohnt es sich kaum.",["bRayTracing"]],
  ],
};

const q = () => new URLSearchParams(location.search);
const cur = { ...START }; // simulierte GameUserSettings.ini (als lesbare Werte)
let lastApplied = null;
let scannedAt = Date.now() - 3 * 60 * 1000;

const fail = (code, message, details) => { const e = new Error(message); e.code = code; if (details) e.details = details; throw e; };
const fpsLabel = (cap) => (cap <= 0 ? 'Unbegrenzt' : `${cap} FPS`);
const presetOf = (id) => PRESETS.find((p) => p.id === id) || fail('BAD_ARG', 'Unbekannter Vorschlag.');

function fpsFor(p, fpsCap) {
  const cap = Number.isInteger(fpsCap) ? fpsCap : p.fps.cap;
  if (cap === p.fps.recommendedCap) return { ...p.fps, cap, reason: p.fps.recommendedReason };
  const why = cap === 0 ? 'Von dir gewählt: keine Grenze. Dein PC macht so viele Bilder, wie er schafft.' : `Von dir gewählt: höchstens ${cap} Bilder pro Sekunde.`;
  return { ...p.fps, cap, reason: 'user', why };
}

function rowsFor(p, fps) {
  return ROWS[p.id].map(([id, label, group, to, why, keys]) => {
    const target = id === 'fps' ? fpsLabel(fps.cap) : to;
    const from = cur[id] ?? 'nicht gesetzt';
    return {
      id, label, group, from, to: target, why: id === 'fps' ? fps.why : why,
      changed: from !== target, raw: keys.map((key) => ({ key })), note: null,
    };
  });
}

export default {
  async scan(args, mctx) {
    await mctx.wait(args.fresh ? 1400 : 600);
    if (q().has('nowin')) return { unsupported: true, message: 'Der PC-Check liest die Hardware über Windows aus. Das geht nur unter Windows.' };
    if (args.fresh) scannedAt = Date.now();
    return {
      unsupported: false, at: scannedAt, hardware: HARDWARE, warnings: EXTRA.warnings, ratings: RATINGS, perf: PERF, hz: EXTRA.hz,
      presets: PRESETS.map((p) => ({ ...p, recommended: p.id === EXTRA.recommended })),
      recommended: EXTRA.recommended, recommendReason: EXTRA.recommendReason, competitiveTip: EXTRA.competitiveTip,
    };
  },

  async preview(args, mctx) {
    await mctx.wait(250);
    if (q().has('nofile')) fail('NO_FILE', 'GameUserSettings.ini wurde nicht gefunden. Starte Fortnite einmal, damit die Datei angelegt wird.');
    const p = presetOf(args.preset);
    const fps = fpsFor(p, args.fpsCap);
    const rows = rowsFor(p, fps);
    const changed = rows.filter((r) => r.changed).length;
    return {
      preset: p.id, title: p.title, fps, est: p.est, rel: 'WindowsClient/GameUserSettings.ini', readOnly: false, rows,
      counts: { total: rows.length, changed, same: rows.length - changed },
      fortnite: { running: !!mctx.db.fortnite.running, unsupported: false, processes: mctx.db.fortnite.processes || [] },
    };
  },

  async apply(args, mctx) {
    await mctx.wait(700);
    if (mctx.db.fortnite.running) fail('FORTNITE_RUNNING', 'Fortnite läuft noch. Schließe Fortnite zuerst – HELIX kann das für dich übernehmen.', { processes: mctx.db.fortnite.processes });
    const p = presetOf(args.preset);
    const skip = new Set(Array.isArray(args.skip) ? args.skip : []);
    const rows = rowsFor(p, fpsFor(p, args.fpsCap)).filter((r) => r.changed && !skip.has(r.id));
    if (!rows.length) return { preset: p.id, applied: 0, nothing: true };
    for (const r of rows) cur[r.id] = r.to;
    const id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-pc01`;
    mctx.db.backups.unshift({ id, createdAt: Date.now(), reason: 'tool', label: `PC-Check: Vorschlag „${p.title}“`, pinned: false, fileCount: 5, bytes: 22812 });
    lastApplied = p.title;
    return { preset: p.id, title: p.title, applied: rows.length, keys: rows.reduce((n, r) => n + r.raw.length, 0), backupId: id, rel: 'WindowsClient/GameUserSettings.ini', skipped: [...skip] };
  },

  async summary() {
    if (q().has('nowin')) return null;
    const rec = PRESETS.find((p) => p.id === EXTRA.recommended);
    return { text: lastApplied ? `${HARDWARE.gpu.short} · übernommen: ${lastApplied}` : `${HARDWARE.gpu.short} · empfohlen: ${rec.title}` };
  },
};
