'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mergeAppsWithRegistry } = require('../src/main/scan/apps');

test('registry entries enrich winget apps; leftovers become unmatched', () => {
  const exported = [
    { id: 'Discord.Discord', source: 'winget', name: 'Discord' },
    { id: 'OBSProject.OBSStudio', source: 'winget', name: 'OBS Studio' },
    { id: 'Unknown.CoolTool', source: 'winget', name: 'Cool Tool' },
  ];
  const entries = [
    { name: 'Discord', version: '1.0.9262', publisher: 'Discord Inc.' },
    { name: 'OBS Studio', version: '31.0.2', publisher: 'OBS Project' },
    { name: 'CoolTool 2.1', version: '2.1', publisher: 'Cool' },
    { name: 'FiveM', publisher: 'Cfx.re' },
  ];
  const { apps, unmatched } = mergeAppsWithRegistry(exported, entries);
  assert.strictEqual(apps.find((a) => a.id === 'Discord.Discord').version, '1.0.9262');
  assert.strictEqual(apps.find((a) => a.id === 'OBSProject.OBSStudio').publisher, 'OBS Project');
  assert.strictEqual(apps.find((a) => a.id === 'Unknown.CoolTool').version, '2.1');
  assert.deepStrictEqual(unmatched.map((u) => u.name), ['FiveM']);
});
