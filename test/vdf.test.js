'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseVdf, parseLibraryFolders, parseAppManifest } = require('../src/main/scan/vdf');

test('parses new-style libraryfolders.vdf with escaped backslashes', () => {
  const text = `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"
\t\t"label"\t\t""
\t\t"apps"
\t\t{
\t\t\t"228980"\t\t"123"
\t\t\t"730"\t\t"35000000000"
\t\t}
\t}
\t"1"
\t{
\t\t"path"\t\t"D:\\\\SteamLibrary"
\t\t"apps" { "252490" "1" }
\t}
}`;
  const libs = parseLibraryFolders(text).map((l) => ({ ...l, apps: l.apps.sort() }));
  assert.deepStrictEqual(libs, [
    { path: 'C:\\Program Files (x86)\\Steam', apps: ['228980', '730'] },
    { path: 'D:\\SteamLibrary', apps: ['252490'] },
  ]);
});

test('parses old-style libraryfolders.vdf', () => {
  const text = '"LibraryFolders"\n{\n "TimeNextStatsReport" "123"\n "ContentStatsID" "-1"\n "1" "E:\\\\Games\\\\Steam"\n}';
  assert.deepStrictEqual(parseLibraryFolders(text), [{ path: 'E:\\Games\\Steam', apps: [] }]);
});

test('parses appmanifest and ignores comments/conditionals', () => {
  const text = `// comment
"AppState"
{
  "appid"   "730"
  "Universe" "1"
  "name"    "Counter-Strike 2"
  "StateFlags" "4"
  "installdir" "Counter-Strike Global Offensive"
  "SizeOnDisk" "35123456789"
  "UserConfig" { "language" "german" [$WIN32] }
}`;
  assert.deepStrictEqual(parseAppManifest(text), {
    appId: 730,
    name: 'Counter-Strike 2',
    installdir: 'Counter-Strike Global Offensive',
    sizeBytes: 35123456789,
    stateFlags: 4,
  });
});

test('broken input does not throw', () => {
  assert.deepStrictEqual(parseVdf('"a" { "b" '), { a: {} });
  assert.strictEqual(parseAppManifest(''), null);
  assert.deepStrictEqual(parseLibraryFolders(null), []);
});
