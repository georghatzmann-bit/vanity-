// Simulator für den Spiel-Booster (nur Browser-Vorschau): typischer Gaming-PC mit Discord, Spotify, Steam & Co.

const H = 3600 * 1000;
const now = Date.now();

const R = {
  epic: { level: 'block', kind: 'epic', reason: 'Epic Games Launcher – Schließen kann deine laufende Fortnite-Sitzung stören.' },
  helix: { level: 'block', kind: 'helix', reason: 'Das ist HELIX selbst.' },
  fortnite: { level: 'block', kind: 'fortnite', reason: 'Gehört zu Fortnite – der Booster schließt Fortnite nie.' },
  anticheat: { level: 'block', kind: 'anticheat', reason: 'Anti-Cheat (Schutz gegen Schummler) – HELIX fasst Anti-Cheat nie an.' },
  system: { level: 'block', kind: 'system', reason: 'Teil von Windows – ohne dieses Programm läuft der PC nicht richtig.' },
  graphics: { level: 'warn', kind: 'graphics', reason: 'Hilfsprogramm des Grafiktreibers. Schließen geht, aber Treiber-Funktionen wie Aufnahme oder Farbeinstellungen können dann fehlen.' },
  inputsw: { level: 'warn', kind: 'inputsw', reason: 'Software für Maus, Tastatur oder Headset. Ohne sie können DPI (Mausempfindlichkeit), Tastenbelegung oder Beleuchtung anders sein.' },
};

function classify(name) {
  const n = String(name).toLowerCase().replace(/\.exe$/, '');
  if (n.startsWith('fortnite')) return R.fortnite;
  if (n.startsWith('easyanticheat') || n.startsWith('beservice') || n.endsWith('_be')) return R.anticheat;
  if (['epicgameslauncher', 'epicwebhelper'].includes(n)) return R.epic;
  if (['helix', 'electron'].includes(n)) return R.helix;
  if (['explorer', 'svchost', 'csrss', 'dwm', 'lsass', 'winlogon', 'system'].includes(n)) return R.system;
  if (['nvcontainer', 'nvdisplay.container', 'radeonsoftware'].includes(n)) return R.graphics;
  if (n.startsWith('lghub') || n.startsWith('razer') || n.startsWith('steelseries')) return R.inputsw;
  return null;
}

const PROCS = [
  ['chrome', 'chrome', 'Google Chrome', 'Google LLC', 1530, 18, true],
  ['discord', 'Discord', 'Discord', 'Discord Inc.', 412, 6, true],
  ['ms-teams', 'ms-teams', 'Microsoft Teams', 'Microsoft Corporation', 520, 4, false],
  ['spotify', 'Spotify', 'Spotify', 'Spotify AB', 236, 5, true],
  ['overwolf', 'Overwolf', 'Overwolf', 'Overwolf Ltd.', 210, 3, false],
  ['steam', 'steam', 'Steam', 'Valve Corporation', 180, 1, false],
  ['lghub', 'lghub', 'LGHUB', 'Logitech', 160, 3, false],
  ['wallpaper32', 'wallpaper32', 'Wallpaper Engine', 'Wallpaper Engine Team', 140, 1, false],
  ['onedrive', 'OneDrive', 'Microsoft OneDrive', 'Microsoft Corporation', 96, 1, false],
  ['nvcontainer', 'NVIDIA Container', 'NVIDIA Container', 'NVIDIA Corporation', 60, 3, false],
  ['epicgameslauncher', 'EpicGamesLauncher', 'Epic Games Launcher', 'Epic Games, Inc.', 330, 1, true],
  ['helix', 'HELIX', 'HELIX', 'HELIX', 240, 4, true],
].map(([name, display, description, company, memMb, count, hasWindow]) => ({
  name, display, description, company, memMb, count, hasWindow, path: `C:\\Programme\\${display}\\${display}.exe`, protect: classify(name),
}));

const state = {
  list: [
    { name: 'discord', display: 'Discord' },
    { name: 'spotify', display: 'Spotify' },
    { name: 'steam', display: 'Steam' },
    { name: 'onedrive', display: 'OneDrive' },
  ],
  options: { powerPlan: true, auto: false },
  active: null,
  lastReport: { kind: 'restore', at: now - 20 * H, trigger: 'auto', restarted: ['Discord', 'Spotify', 'Steam'], alreadyRunning: ['OneDrive'], failed: [], untouched: [], powerPlan: { changed: true, text: 'Energieplan zurück auf „Ausbalanciert“.' } },
  closedNames: new Set(),
};
let busy = null;

const running = (name) => !state.closedNames.has(name) && PROCS.some((p) => p.name === name);

function info() {
  const act = new Map((state.active?.apps || []).map((a) => [a.name, a]));
  return {
    supported: true,
    busy,
    list: state.list.map((e) => ({ ...e, path: null, protect: classify(e.name), running: running(e.name), boost: act.get(e.name)?.status || null })),
    options: { ...state.options },
    active: state.active ? {
      startedAt: state.active.startedAt, trigger: state.active.trigger,
      apps: state.active.apps.map((a) => ({ name: a.name, display: a.display, status: a.status, restartable: true })),
      powerPlan: state.active.powerPlan,
    } : null,
    lastReport: state.lastReport,
    power: { active: state.active?.powerPlan ? 'Höchstleistung' : 'Ausbalanciert', highAvailable: true, highName: 'Höchstleistung' },
  };
}

const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };

export default {
  async summary() {
    if (state.active) return { text: `Boost aktiv – ${state.active.apps.filter((a) => a.status !== 'open').length} Programme geschlossen` };
    return { text: `${state.list.length} ${state.list.length === 1 ? 'Programm' : 'Programme'} in der Liste` };
  },
  async info(_a, m) { await m.wait(120); return info(); },
  async running(_a, m) {
    await m.wait(500);
    const names = new Set(state.list.map((e) => e.name));
    return { unsupported: false, processes: PROCS.filter((p) => !state.closedNames.has(p.name)).map((p) => ({ ...p, inList: names.has(p.name) })) };
  },
  async add(a, m) {
    await m.wait(120);
    const raw = String(a.name || '').trim();
    if (!raw || /[\\/:*?"<>|]/.test(raw.split(/[\\/]/).pop())) fail('BAD_ARG', 'Bitte gib den Namen der Programmdatei ein, zum Beispiel „Discord.exe“.');
    const name = raw.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    const display = String(a.display || raw).replace(/\.exe$/i, '');
    const p = classify(name);
    if (p?.level === 'block') fail('PROTECTED', `„${display}“ ist geschützt: ${p.reason}`);
    if (p?.level === 'warn' && a.confirm !== true) fail('CONFIRM_NEEDED', p.reason);
    if (state.list.some((e) => e.name === name)) return { added: false, already: true, info: info() };
    state.list.push({ name, display });
    return { added: true, display, info: info() };
  },
  async remove(a) {
    state.list = state.list.filter((e) => e.name !== String(a.name).toLowerCase());
    return { removed: true, info: info() };
  },
  async setOptions(a) {
    if (typeof a.powerPlan === 'boolean') state.options.powerPlan = a.powerPlan;
    if (typeof a.auto === 'boolean') state.options.auto = a.auto;
    return { options: { ...state.options } };
  },
  async boost(_a, m) {
    if (!state.list.length && !state.options.powerPlan) fail('EMPTY_LIST', 'Deine Liste ist leer. Füge zuerst Programme hinzu, die beim Spielen zu sein sollen.');
    busy = 'boost';
    await m.wait(1400);
    const report = { kind: 'boost', at: Date.now(), trigger: 'manual', closed: [], stillOpen: [], notRunning: [], failed: [], powerPlan: null };
    const active = state.active || { startedAt: Date.now(), trigger: 'manual', apps: [], powerPlan: null };
    for (const e of state.list) {
      if (!running(e.name)) { if (!active.apps.some((x) => x.name === e.name)) report.notRunning.push(e.display); continue; }
      const stays = e.name === 'steam'; // versteckt sich beim Schließen nur im Infobereich
      if (!stays) state.closedNames.add(e.name);
      const app = { name: e.name, display: e.display, status: stays ? 'open' : 'closed' };
      const i = active.apps.findIndex((x) => x.name === e.name);
      if (i >= 0) active.apps[i] = app; else active.apps.push(app);
    }
    if (state.options.powerPlan && !active.powerPlan) {
      active.powerPlan = { beforeName: 'Ausbalanciert', setName: 'Höchstleistung' };
      report.powerPlan = { changed: true, text: 'Energieplan von „Ausbalanciert“ auf „Höchstleistung“ gestellt.' };
    }
    // wie das echte Modul: Bericht über den ganzen Boost (auch nach "Erneut boosten")
    const by = (s) => active.apps.filter((x) => x.status === s).map((x) => x.display);
    Object.assign(report, { closed: by('closed'), forced: by('forced'), stillOpen: by('open') });
    if (!report.powerPlan && state.active && state.lastReport?.kind === 'boost') report.powerPlan = state.lastReport.powerPlan || null;
    state.active = active;
    state.lastReport = report;
    busy = null;
    m.emit('booster.state', { active: true });
    return { report, active: info().active };
  },
  async forceClose(a, m) {
    if (a.confirm !== true) fail('CONFIRM_NEEDED', 'Sofort beenden geht nur nach deiner ausdrücklichen Bestätigung.');
    if (!state.active) fail('NOT_ACTIVE', 'Es läuft gerade kein Boost.');
    await m.wait(700);
    const report = { kind: 'force', at: Date.now(), forced: [], stillOpen: [], failed: [] };
    for (const app of state.active.apps) {
      if (app.status !== 'open') continue;
      app.status = 'forced';
      state.closedNames.add(app.name);
      report.forced.push(app.display);
    }
    const last = state.lastReport;
    if (last?.kind === 'boost') {
      last.stillOpen = last.stillOpen.filter((d) => !report.forced.includes(d));
      last.forced = [...(last.forced || []), ...report.forced];
    }
    m.emit('booster.state', { active: true });
    return { report, active: info().active };
  },
  async restore(_a, m) {
    if (!state.active) return { nothing: true, report: null };
    busy = 'restore';
    await m.wait(1200);
    const report = { kind: 'restore', at: Date.now(), trigger: 'manual', restarted: [], alreadyRunning: [], failed: [], untouched: [], powerPlan: null };
    for (const a of state.active.apps) {
      if (a.status === 'open') { report.untouched.push(a.display); continue; }
      state.closedNames.delete(a.name);
      report.restarted.push(a.display);
    }
    if (state.active.powerPlan) report.powerPlan = { changed: true, text: `Energieplan zurück auf „${state.active.powerPlan.beforeName}“.` };
    state.active = null;
    state.lastReport = report;
    busy = null;
    m.emit('booster.state', { active: false });
    return { report, active: null };
  },
};
