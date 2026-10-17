'use strict';
// Mock backend (non-Windows or PHOENIX_MOCK=1): same surface as ../backend.js, fake system calls.
const fs = require('fs');
const os = require('os');
const path = require('path');
const catalog = require('../catalog');
const profile = require('../profile/profile');
const code = require('../profile/code');

const MOCK_ROOT = path.join(os.tmpdir(), 'phoenix-mock');
const DRIVES = [
  { root: path.join(MOCK_ROOT, 'C'), label: 'Windows', kind: 'system', freeBytes: 182e9, totalBytes: 999e9 },
  { root: path.join(MOCK_ROOT, 'D'), label: 'Spiele', kind: 'fixed', freeBytes: 410e9, totalBytes: 2000e9 },
  { root: path.join(MOCK_ROOT, 'E'), label: 'SANDISK', kind: 'removable', freeBytes: 28e9, totalBytes: 32e9 },
];
for (const d of DRIVES) fs.mkdirSync(d.root, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const speed = () => Math.max(0.05, Number(process.env.PHOENIX_MOCK_SPEED || 1));

const MACHINE = {
  hostname: 'GAMING-PC',
  user: 'Georg',
  os: { caption: 'Windows 11 Pro', version: '10.0.26100', build: '26100.4946', displayVersion: '24H2' },
  cpu: 'AMD Ryzen 7 7800X3D 8-Core Processor',
  ramGB: 32,
  gpus: [{ name: 'NVIDIA GeForce RTX 4070 SUPER', vendor: 'nvidia' }],
};

const SCAN_IDS = [
  'EpicGames.EpicGamesLauncher', 'Valve.Steam', 'Discord.Discord', 'Spotify.Spotify', 'Google.Chrome', 'Opera.OperaGX',
  'OBSProject.OBSStudio', '7zip.7zip', 'VideoLAN.VLC', 'SteelSeries.GG', 'Logitech.GHUB', 'Microsoft.VisualStudioCode',
  'Notepad++.Notepad++', 'Microsoft.VCRedist.2015+.x64', 'Microsoft.VCRedist.2015+.x86', 'Microsoft.DirectX',
  'Telegram.TelegramDesktop', 'Mojang.MinecraftLauncher', 'RazerInc.RazerInstaller.Synapse4', 'Guru3D.Afterburner', 'REALiX.HWiNFO',
  'Brave.Brave', 'Malwarebytes.Malwarebytes', 'ShareX.ShareX', 'qBittorrent.qBittorrent',
];

function scanApps() {
  return SCAN_IDS.map((id) => {
    const hit = catalog.lookup(id, 'winget');
    return { id, source: 'winget', name: catalog.displayName(id, 'winget'), version: '1.0', category: hit ? hit.category : undefined, elevation: hit ? hit.elevation : 'unknown' };
  });
}

const GAMES = [
  { platform: 'epic', title: 'Fortnite', appName: 'Fortnite', namespace: 'fn', catalogItemId: '4fe75bbc5a674f4f9b356b5c90567da5', sizeBytes: 38.4e9 },
  { platform: 'epic', title: 'Rocket League®', appName: 'Sugar', namespace: '9773aa1aa54f4f7b80e44bef04986cea', catalogItemId: '530145df28a24424923f5828cc9031a1', sizeBytes: 21.1e9 },
  { platform: 'steam', title: 'Counter-Strike 2', appId: 730, sizeBytes: 33.9e9 },
  { platform: 'steam', title: 'Rust', appId: 252490, sizeBytes: 31.2e9 },
];

const UNMATCHED = [
  { name: 'Razer Cortex', publisher: 'Razer Inc.', version: '10.16.6' },
  { name: 'FiveM', publisher: 'Cfx.re', version: '' },
  { name: 'Lunar Client 3.2.1', publisher: 'Moonsworth LLC', version: '3.2.1' },
];

async function ensureWinget(onProgress) {
  const steps = [
    ['detect', 'winget wird gesucht …'],
    ['version', 'Version wird geprüft …'],
    ['sources', 'Paketquellen werden aktualisiert …'],
  ];
  for (const [step, message] of steps) {
    onProgress && onProgress({ step, message });
    await sleep(500 * speed());
  }
  return { ok: true, version: '1.12.350' };
}

async function runScan(onProgress) {
  const apps = scanApps();
  const phases = [
    ['winget', 'winget-Export läuft …', 25],
    ['registry', 'Registry wird durchsucht …', 50],
    ['games', 'Spielebibliotheken werden gelesen …', 75],
    ['icons', 'Icons werden gesammelt …', 95],
  ];
  let found = 0;
  for (const [phase, message, pct] of phases) {
    const step = Math.ceil(apps.length / phases.length);
    found = Math.min(apps.length, found + step);
    onProgress && onProgress({ phase, message, pct, found });
    await sleep(700 * speed());
  }
  onProgress && onProgress({ phase: 'done', message: 'Fertig', pct: 100, found: apps.length });
  return { apps, games: GAMES, unmatched: UNMATCHED, machine: MACHINE, winget: { ok: true, version: '1.12.350' }, warnings: [] };
}

async function findProfiles() {
  const out = [];
  for (const d of DRIVES) {
    for (const dir of [path.join(d.root, 'Phoenix'), d.root]) {
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(profile.EXT));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const p = profile.loadProfile(path.join(dir, f));
          out.push({ path: path.join(dir, f), location: d.kind === 'removable' ? `USB-Stick ${d.label}` : `Laufwerk ${d.label}`, createdAt: p.createdAt, hostname: p.machine.hostname, appCount: p.apps.length, gameCount: p.games.length });
        } catch {
          /* ignore broken */
        }
      }
    }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ----------------------------------------------------------------- install
let job = null;

async function startInstall(items, emit) {
  if (job && !job.done) throw new Error('Es läuft bereits eine Installation.');
  const { sanitizeItems } = require('../install/protocol');
  const list = sanitizeItems(items);
  if (!list.length) throw new Error('Keine gültigen Apps ausgewählt.');
  const jobId = `mock-${Date.now()}`;
  job = { id: jobId, cancelled: false, done: false };
  const current = job;
  const lanes = list.map((it) => ({ ...it, lane: it.elevation === 'prohibited' || it.source === 'msstore' ? 'user' : 'admin' }));
  const ordered = [...lanes.filter((i) => i.lane === 'admin'), ...lanes.filter((i) => i.lane === 'user')];

  (async () => {
    const started = Date.now();
    const summary = { installed: 0, already: 0, failed: 0, skipped: 0, cancelled: 0, rebootRequired: false };
    emit({ type: 'job-start', jobId, items: ordered.map((i) => ({ key: i.key, name: i.name, lane: i.lane })) });
    emit({ type: 'phase', phase: 'winget-check', message: 'winget wird geprüft …' });
    await sleep(600 * speed());
    emit({ type: 'phase', phase: 'elevating', message: 'Administratorrechte werden angefordert …' });
    emit({ type: 'elevation', status: 'requested', message: 'Bitte bestätige die Windows-Abfrage mit „Ja“.' });
    await sleep(1200 * speed());
    emit({ type: 'elevation', status: 'granted', message: 'Administratorrechte erteilt.' });
    emit({ type: 'phase', phase: 'installing', message: 'Installation läuft …' });
    for (let i = 0; i < ordered.length; i++) {
      const it = ordered[i];
      const t0 = Date.now();
      if (current.cancelled) {
        summary.cancelled++;
        emit({ type: 'item-done', key: it.key, status: 'cancelled', rebootRequired: false, message: 'Abgebrochen', durationMs: 0 });
        continue;
      }
      emit({ type: 'item-start', key: it.key, index: i, total: ordered.length });
      emit({ type: 'item-progress', key: it.key, stage: 'resolving', pct: null });
      await sleep(350 * speed());
      const total = (20 + ((i * 37) % 180)) * 1024 * 1024;
      for (let p = 0; p <= 100 && !current.cancelled; p += 8 + ((i * 13) % 9)) {
        emit({ type: 'item-progress', key: it.key, stage: 'downloading', pct: Math.min(100, p), bytes: { done: Math.round((total * Math.min(100, p)) / 100), total } });
        await sleep(110 * speed());
      }
      emit({ type: 'item-progress', key: it.key, stage: 'verifying', pct: null });
      await sleep(250 * speed());
      emit({ type: 'item-progress', key: it.key, stage: 'installing', pct: null });
      await sleep((700 + ((i * 211) % 900)) * speed());
      if (current.cancelled) {
        summary.cancelled++;
        emit({ type: 'item-done', key: it.key, status: 'cancelled', rebootRequired: false, message: 'Abgebrochen', durationMs: Date.now() - t0 });
        continue;
      }
      let status = 'installed';
      let message = 'Erfolgreich installiert';
      let codeNum;
      if (/Logitech/i.test(it.id)) {
        status = 'failed';
        codeNum = 0x8a150011;
        message = 'Der Installer-Hash stimmt nicht überein (Paket wurde vom Hersteller geändert).';
      } else if (/VCRedist/i.test(it.id)) {
        status = 'already';
        message = 'War bereits installiert';
      }
      const reboot = /DirectX/i.test(it.id);
      if (reboot) summary.rebootRequired = true;
      summary[status]++;
      emit({ type: 'item-done', key: it.key, status, rebootRequired: reboot, code: codeNum, codeHex: codeNum ? `0x${codeNum.toString(16).toUpperCase()}` : undefined, message, durationMs: Date.now() - t0 });
    }
    emit({ type: 'phase', phase: 'finishing', message: 'Abschluss …' });
    await sleep(400 * speed());
    current.done = true;
    emit({ type: 'job-done', summary, durationMs: Date.now() - started });
  })();

  return { jobId };
}

async function cancelInstall() {
  if (job) job.cancelled = true;
  return true;
}

module.exports = {
  getMachineInfo: async () => MACHINE,
  getWingetStatus: async () => ({ available: true, version: '1.12.350', path: 'C:\\Users\\Georg\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe', ok: true, minVersion: '1.6.0' }),
  ensureWinget,
  runScan,
  getCatalog: async () => catalog.getCatalog(),
  saveProfile: (p, dir, parentWin) =>
    dir === 'onedrive' || dir === 'documents'
      ? Promise.resolve({ path: profile.writeProfile(p, path.join(MOCK_ROOT, dir === 'onedrive' ? 'OneDrive' : 'Dokumente', 'Phoenix')) })
      : profile.saveProfile(p, { dir, parentWin }),
  saveToDrive: (p, root) => profile.saveToDrive(p, root),
  openProfileDialog: (parentWin) => profile.openProfileDialog(parentWin),
  findProfiles,
  loadProfile: async (file) => profile.loadProfile(file),
  encodeProfile: async (p) => code.encode(p),
  decodeProfile: async (text) => code.decode(text),
  listDrives: async () =>
    DRIVES.filter((d) => d.kind !== 'system')
      .concat(DRIVES.filter((d) => d.kind === 'system'))
      .concat([{ root: 'onedrive', label: 'OneDrive', kind: 'cloud', path: path.join(MOCK_ROOT, 'OneDrive'), freeBytes: 0, totalBytes: 0 }]),
  findSetupExe: async () => null,
  startInstall,
  cancelInstall,
  isInstallRunning: () => !!(job && !job.done),
  detectLaunchers: async () => ({ epic: { installed: true }, steam: { installed: true } }),
  installGame: async (game, mode) => {
    const { installUri } = require('../games/launch');
    return { ok: true, uri: installUri(game, mode) };
  },
};
