'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalize, parseProfileText, fileNameFor } = require('../src/main/profile/profile');
const code = require('../src/main/profile/code');

const sample = {
  format: 'phoenix-profile',
  version: 1,
  createdAt: '2026-10-17T09:00:00Z',
  machine: { hostname: 'GAMING-PC', os: { caption: 'Windows 11 Pro', build: '26100' }, ramGB: 32, gpus: [{ name: 'RTX 4070', vendor: 'nvidia' }] },
  apps: [
    { id: 'EpicGames.EpicGamesLauncher', source: 'winget' },
    { id: 'epicgames.epicgameslauncher', source: 'winget' },
    { id: 'Discord.Discord', source: 'winget', icon: 'data:image/png;base64,AAAA' },
    { id: '9NKSQGP7F2NH', source: 'msstore', name: 'WhatsApp' },
    { id: 'rm -rf /', source: 'winget' },
    { id: 'Evil.Icon', source: 'winget', icon: 'javascript:alert(1)' },
  ],
  games: [
    { platform: 'epic', title: 'Fortnite', appName: 'Fortnite', namespace: 'fn', catalogItemId: '4fe75bbc5a674f4f9b356b5c90567da5' },
    { platform: 'epic', title: 'Fortnite', appName: 'Fortnite' },
    { platform: 'steam', title: 'CS2', appId: '730' },
    { platform: 'steam', title: 'Broken', appId: 'abc' },
  ],
  unmatched: [{ name: 'FiveM' }, { name: '' }],
};

test('normalize dedupes, validates ids and strips unsafe icons', () => {
  const p = normalize(sample);
  assert.deepStrictEqual(p.apps.map((a) => a.id), ['EpicGames.EpicGamesLauncher', 'Discord.Discord', '9NKSQGP7F2NH', 'Evil.Icon']);
  assert.ok(p.apps[1].icon.startsWith('data:image/png'));
  assert.strictEqual(p.apps[3].icon, undefined);
  assert.strictEqual(p.apps[2].name, 'WhatsApp');
  assert.deepStrictEqual(p.games.map((g) => g.title), ['Fortnite', 'CS2']);
  assert.strictEqual(p.games[1].appId, 730);
  assert.deepStrictEqual(p.unmatched, [{ name: 'FiveM' }]);
});

test('rejects foreign formats and newer versions', () => {
  assert.throws(() => normalize({ format: 'other' }), /kein gültiges Phoenix-Profil/);
  assert.throws(() => normalize({ format: 'phoenix-profile', version: 99 }), /neueren Phoenix-Version/);
  assert.throws(() => parseProfileText('{oops'), /beschädigt/);
});

test('imports raw winget export JSON', () => {
  const exported = JSON.stringify({
    $schema: 'https://aka.ms/winget-packages.schema.2.0.json',
    CreationDate: '2026-10-16T20:00:00.000-00:00',
    Sources: [
      { Packages: [{ PackageIdentifier: 'Valve.Steam' }, { PackageIdentifier: 'Discord.Discord' }], SourceDetails: { Argument: 'https://cdn.winget.microsoft.com/cache', Identifier: 'Microsoft.Winget.Source_8wekyb3d8bbwe', Name: 'winget', Type: 'Microsoft.PreIndexed.Package' } },
      { Packages: [{ PackageIdentifier: '9NKSQGP7F2NH' }], SourceDetails: { Name: 'msstore' } },
    ],
    WinGetVersion: '1.12.350',
  });
  const p = parseProfileText('\uFEFF' + exported);
  assert.deepStrictEqual(p.apps.map((a) => `${a.source}:${a.id}`), ['winget:Valve.Steam', 'winget:Discord.Discord', 'msstore:9NKSQGP7F2NH']);
});

test('file name is safe', () => {
  assert.strictEqual(fileNameFor(normalize({ ...sample, machine: { hostname: 'Mein PC/<x>' } })), 'Phoenix-Profil-MeinPCx-2026-10-17.phoenix.json');
});

test('restore code round trip keeps apps and games', () => {
  const c = code.encode(sample);
  assert.match(c, /^PHX1-[A-Za-z0-9_-]+$/);
  const back = code.decode(`  ${c.slice(0, 20)}\n${c.slice(20)}  `);
  const p = normalize(sample);
  assert.deepStrictEqual(back.apps.map((a) => `${a.source}:${a.id}`), p.apps.map((a) => `${a.source}:${a.id}`));
  assert.strictEqual(back.apps.find((a) => a.id === '9NKSQGP7F2NH').name, 'WhatsApp');
  assert.deepStrictEqual(back.games, p.games.map(({ sizeBytes, ...g }) => g));
  assert.strictEqual(back.machine.hostname, 'GAMING-PC');
  assert.throws(() => code.decode('PHX1-!!!'), /ungültig/);
  assert.throws(() => code.decode(''), /leer/);
});
