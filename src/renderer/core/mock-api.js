// Browser-only mock of window.phoenix (Vite dev server / screenshots). Mirrors src/main/mock.
import catalogData from '../../main/catalog/catalog.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const SPEED = Math.max(0.05, Number(params.get('speed') || 1));

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

const items = () => catalogData.items || catalogData;
const lookup = (id, source = 'winget') => items().find((i) => i.source === source && i.id.toLowerCase() === id.toLowerCase());
const prettify = (id) => {
  const parts = String(id).split('.');
  return (parts.length > 1 ? parts.slice(1) : parts).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2');
};

function scanApps() {
  return SCAN_IDS.map((id) => {
    const hit = lookup(id);
    return { id, source: 'winget', name: hit ? hit.name : prettify(id), version: '1.0', category: hit && hit.category, elevation: hit ? hit.elevation : 'unknown' };
  });
}

function emitter() {
  const map = new Map();
  return {
    on(ch, cb) {
      if (!map.has(ch)) map.set(ch, new Set());
      map.get(ch).add(cb);
      return () => map.get(ch).delete(cb);
    },
    emit(ch, payload) {
      for (const cb of map.get(ch) || []) cb(payload);
    },
  };
}

export function createMockApi() {
  const bus = emitter();
  const saved = [];
  let job = null;

  const profileFrom = (p) => ({ format: 'phoenix-profile', version: 1, createdAt: new Date().toISOString(), appVersion: '1.0.0', machine: MACHINE, apps: [], games: [], unmatched: [], ...p });

  return {
    app: {
      info: async () => ({ version: '1.0.0', firstRun: params.get('firstRun') !== '0', isPackaged: false, mock: true }),
      markInstalled: async () => true,
    },
    win: { minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {} },
    system: { info: async () => MACHINE },
    winget: {
      status: async () => ({ available: true, version: '1.12.350', path: 'winget.exe', ok: true, minVersion: '1.6.0' }),
      ensure: async () => {
        for (const [step, message] of [['detect', 'winget wird gesucht …'], ['version', 'Version wird geprüft …'], ['sources', 'Paketquellen werden aktualisiert …']]) {
          bus.emit('winget:ensure-progress', { step, message });
          await sleep(450 * SPEED);
        }
        return { ok: true, version: '1.12.350' };
      },
    },
    scan: {
      run: async () => {
        const apps = scanApps();
        const phases = [['winget', 'winget-Export läuft …', 25], ['registry', 'Registry wird durchsucht …', 50], ['games', 'Spielebibliotheken werden gelesen …', 75], ['icons', 'Icons werden gesammelt …', 95]];
        let found = 0;
        for (const [phase, message, pct] of phases) {
          found = Math.min(apps.length, found + Math.ceil(apps.length / phases.length));
          bus.emit('scan:progress', { phase, message, pct, found });
          await sleep(650 * SPEED);
        }
        bus.emit('scan:progress', { phase: 'done', message: 'Fertig', pct: 100, found: apps.length });
        return { apps, games: GAMES, unmatched: UNMATCHED, machine: MACHINE, winget: { ok: true, version: '1.12.350' }, warnings: [] };
      },
    },
    catalog: {
      get: async () => {
        const list = items();
        return { categories: [...new Set(list.map((i) => i.category))], items: list };
      },
    },
    profile: {
      save: async (p, dir) => {
        const path = dir === 'documents' ? 'C:\\Users\\Georg\\Documents\\Phoenix\\Phoenix-Profil-GAMING-PC.phoenix.json' : 'C:\\Users\\Georg\\Desktop\\Phoenix-Profil-GAMING-PC.phoenix.json';
        saved.push({ path, profile: profileFrom(p) });
        return { path };
      },
      saveToDrive: async (p, root) => {
        const path = `${root}Phoenix\\Phoenix-Profil-GAMING-PC.phoenix.json`;
        saved.push({ path, profile: profileFrom(p) });
        return { path, setupCopied: true, setupPath: `${root}Phoenix\\Phoenix-Setup-1.0.0.exe` };
      },
      open: async () => profileFrom({ apps: scanApps(), games: GAMES, unmatched: UNMATCHED }),
      find: async () => {
        const base = [{ path: 'E:\\Phoenix\\Phoenix-Profil-GAMING-PC-2026-10-17.phoenix.json', location: 'USB-Stick E:\\', createdAt: '2026-10-17T09:12:00.000Z', hostname: 'GAMING-PC', appCount: SCAN_IDS.length, gameCount: GAMES.length }];
        return params.get('noProfiles') === '1' ? [] : base;
      },
      load: async () => profileFrom({ apps: scanApps(), games: GAMES, unmatched: UNMATCHED }),
      encode: async (p) => 'PHX1-' + btoa(unescape(encodeURIComponent(JSON.stringify({ a: (p.apps || []).map((a) => a.id) })))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'),
      decode: async (code) => {
        if (!/^\s*PHX1-/i.test(code)) throw new Error('Der Code ist ungültig oder unvollständig. Bitte komplett kopieren (beginnt mit PHX1-).');
        return profileFrom({ apps: scanApps(), games: GAMES });
      },
    },
    drives: {
      list: async () => [
        { root: 'E:\\', label: 'SANDISK', kind: 'removable', freeBytes: 28e9, totalBytes: 32e9 },
        { root: 'D:\\', label: 'Spiele', kind: 'fixed', freeBytes: 410e9, totalBytes: 2000e9 },
        { root: 'C:\\', label: 'Windows', kind: 'system', freeBytes: 182e9, totalBytes: 999e9 },
      ],
    },
    setup: { find: async () => ({ path: 'C:\\Users\\Georg\\Downloads\\Phoenix-Setup-1.0.0.exe' }) },
    install: {
      start: async (list) => {
        const jobId = `mock-${Date.now()}`;
        job = { cancelled: false };
        const current = job;
        const ordered = list.map((it) => ({ ...it, lane: it.elevation === 'prohibited' || it.source === 'msstore' ? 'user' : 'admin' }));
        ordered.sort((a, b) => (a.lane === b.lane ? 0 : a.lane === 'admin' ? -1 : 1));
        const emit = (e) => bus.emit('install:event', e);
        (async () => {
          const t = Date.now();
          const summary = { installed: 0, already: 0, failed: 0, skipped: 0, cancelled: 0, rebootRequired: false };
          emit({ type: 'job-start', jobId, items: ordered.map((i) => ({ key: i.key, name: i.name, lane: i.lane })) });
          emit({ type: 'phase', phase: 'winget-check', message: 'winget wird geprüft …' });
          await sleep(500 * SPEED);
          emit({ type: 'elevation', status: 'requested', message: 'Bitte bestätige die Windows-Abfrage mit „Ja“.' });
          await sleep(1100 * SPEED);
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
            await sleep(300 * SPEED);
            const total = (20 + ((i * 37) % 180)) * 1048576;
            for (let p = 0; p <= 100 && !current.cancelled; p += 9 + ((i * 13) % 9)) {
              emit({ type: 'item-progress', key: it.key, stage: 'downloading', pct: Math.min(100, p), bytes: { done: Math.round((total * Math.min(p, 100)) / 100), total } });
              await sleep(100 * SPEED);
            }
            emit({ type: 'item-progress', key: it.key, stage: 'installing', pct: null });
            await sleep((600 + ((i * 211) % 800)) * SPEED);
            let status = 'installed';
            let message = 'Erfolgreich installiert';
            if (/Logitech/i.test(it.id)) {
              status = 'failed';
              message = 'Der Installer-Hash stimmt nicht überein (Paket wurde vom Hersteller geändert).';
            } else if (/VCRedist/i.test(it.id)) {
              status = 'already';
              message = 'War bereits installiert';
            }
            const reboot = /DirectX/i.test(it.id);
            if (reboot) summary.rebootRequired = true;
            summary[status]++;
            emit({ type: 'item-done', key: it.key, status, rebootRequired: reboot, code: status === 'failed' ? 2316632081 : undefined, codeHex: status === 'failed' ? '0x8A150011' : undefined, message, durationMs: Date.now() - t0 });
          }
          emit({ type: 'job-done', summary, durationMs: Date.now() - t });
        })();
        return { jobId };
      },
      cancel: async () => {
        if (job) job.cancelled = true;
        return true;
      },
    },
    games: {
      launchers: async () => ({ epic: { installed: true }, steam: { installed: true } }),
      install: async (game) => ({ ok: true, uri: game.platform === 'steam' ? `steam://install/${game.appId}` : `com.epicgames.launcher://apps/${game.appName}?action=install` }),
    },
    shell: { open: async () => true, showItem: async () => true },
    clipboard: {
      write: async (text) => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          /* ignore in headless */
        }
        return true;
      },
    },
    log: { export: async () => ({ path: 'C:\\Users\\Georg\\Desktop\\Phoenix-Log.txt' }) },
    on: (channel, cb) => bus.on(channel, cb),
  };
}
