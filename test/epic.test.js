'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseEpicItem, parseLauncherInstalled, mergeEpic } = require('../src/main/scan/epic');

const fortnite = {
  FormatVersion: 0,
  bIsIncompleteInstall: false,
  LaunchExecutable: 'FortniteGame/Binaries/Win64/FortniteLauncher.exe',
  DisplayName: 'Fortnite',
  InstallLocation: 'C:\\Program Files\\Epic Games\\Fortnite',
  InstallSize: 38400000000,
  AppCategories: ['public', 'games', 'applications'],
  CatalogNamespace: 'fn',
  CatalogItemId: '4fe75bbc5a674f4f9b356b5c90567da5',
  AppName: 'Fortnite',
  MainGameCatalogNamespace: 'fn',
  MainGameCatalogItemId: '4fe75bbc5a674f4f9b356b5c90567da5',
  MainGameAppName: 'Fortnite',
};

test('parses Fortnite manifest (with BOM)', () => {
  const g = parseEpicItem('\uFEFF' + JSON.stringify(fortnite));
  assert.strictEqual(g.title, 'Fortnite');
  assert.strictEqual(g.appName, 'Fortnite');
  assert.strictEqual(g.namespace, 'fn');
  assert.strictEqual(g.catalogItemId, '4fe75bbc5a674f4f9b356b5c90567da5');
  assert.strictEqual(g.sizeBytes, 38400000000);
});

test('skips DLC, add-ons and engine installs', () => {
  assert.strictEqual(parseEpicItem(JSON.stringify({ ...fortnite, AppName: 'FortniteDLC', MainGameAppName: 'Fortnite' })), null);
  assert.strictEqual(parseEpicItem(JSON.stringify({ ...fortnite, AppCategories: ['addons'] })), null);
  assert.strictEqual(parseEpicItem(JSON.stringify({ ...fortnite, AppName: 'UE_5.4', MainGameAppName: 'UE_5.4' })), null);
  assert.strictEqual(parseEpicItem('not json'), null);
});

test('LauncherInstalled.dat fallback + merge prefers manifests', () => {
  const dat = JSON.stringify({ InstallationList: [
    { InstallLocation: 'C:\\Fortnite', NamespaceId: 'fn', ItemId: '4fe75bbc5a674f4f9b356b5c90567da5', ArtifactId: 'Fortnite', AppVersion: 'x', AppName: 'Fortnite' },
    { InstallLocation: 'C:\\UE', NamespaceId: 'ue', ItemId: 'abc', ArtifactId: 'UE_5.4', AppVersion: 'x', AppName: 'UE_5.4' },
    { InstallLocation: 'C:\\RL', NamespaceId: 'sugar', ItemId: 'def', ArtifactId: 'Sugar', AppVersion: 'x', AppName: 'Sugar' },
  ] });
  const installed = parseLauncherInstalled(dat);
  assert.deepStrictEqual(installed.map((g) => g.appName), ['Fortnite', 'Sugar']);
  const merged = mergeEpic([parseEpicItem(JSON.stringify(fortnite))], installed);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged.find((g) => g.appName === 'Fortnite').sizeBytes, 38400000000);
});
