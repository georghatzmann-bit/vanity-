'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { filterEntries, iconPath, normName } = require('../src/main/scan/registry');
const { prettifyId } = require('../src/main/catalog');

test('registry filter drops updates, system components and noise', () => {
  const kept = filterEntries([
    { name: 'Discord', systemComponent: 0 },
    { name: 'Discord' },
    { name: 'KB5034441' },
    { name: 'Some Update', parentKeyName: 'Office' },
    { name: 'Hidden', systemComponent: 1 },
    { name: 'Microsoft Visual C++ 2015-2022 Redistributable (x64) - 14.40.33810' },
    { name: 'Security Patch', releaseType: 'Security Update' },
    { name: 'FiveM' },
  ]);
  assert.deepStrictEqual(kept.map((e) => e.name), ['Discord', 'FiveM']);
});

test('iconPath strips icon index and quotes', () => {
  assert.strictEqual(iconPath('"C:\\Program Files\\Discord\\app.exe",0'), 'C:\\Program Files\\Discord\\app.exe');
  assert.strictEqual(iconPath('C:\\x\\y.ico'), 'C:\\x\\y.ico');
  assert.strictEqual(iconPath('C:\\x\\y.exe,-101'), 'C:\\x\\y.exe');
  assert.strictEqual(iconPath('MsiExec.exe /X{123}'), null);
  assert.strictEqual(iconPath(''), null);
});

test('normName and prettifyId', () => {
  assert.strictEqual(normName('OBS Studio (64-bit) 30.2.3'), 'obsstudio');
  assert.strictEqual(prettifyId('EpicGames.EpicGamesLauncher'), 'Epic Games Launcher');
  assert.strictEqual(prettifyId('Discord.Discord'), 'Discord');
});
