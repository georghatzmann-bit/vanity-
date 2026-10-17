'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createProgressParser, cleanLine } = require('../src/main/winget/progress');

function run(chunks) {
  const events = [];
  const lines = [];
  const p = createProgressParser((e) => events.push(e), (l) => lines.push(l));
  for (const c of chunks) p.feed(c);
  p.flush();
  return { events, lines };
}

test('English install output with \\r progress redraws', () => {
  const { events, lines } = run([
    'Found Discord [Discord.Discord] Version 1.0.9262\r\n',
    'This application is licensed to you by its owner.\r\n',
    'Downloading https://dl.discordapp.net/distro/app/stable/win/x64/1.0.9262/DiscordSetup.exe\r\n',
    '\r  \u2588\u2588\u2588\u2592\u2592\u2592\u2592\u2592  10.0 MB / 100 MB',
    '\r  \u2588\u2588\u2588\u2588\u2588\u2588\u2592\u2592  55.5 MB / 100 MB',
    '\r  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588  100 MB / 100 MB\r\n',
    'Successfully verified installer hash\r\n',
    'Starting package install...\r\n',
    '\r-\r\\\r|\r/\r',
    'Successfully installed\r\n',
  ]);
  const stages = events.map((e) => `${e.stage}:${e.pct}`);
  assert.deepStrictEqual(stages, ['resolving:null', 'downloading:0', 'downloading:10', 'downloading:55', 'downloading:100', 'verifying:null', 'installing:null']);
  assert.deepStrictEqual(events[3].bytes, { done: Math.round(55.5 * 1048576), total: 100 * 1048576 });
  assert.ok(lines.includes('Successfully installed'));
  assert.ok(!lines.some((l) => /MB \//.test(l)));
});

test('German output and comma decimals', () => {
  const { events } = run([
    'Gefunden Spotify [Spotify.Spotify] Version 1.2\n',
    'Wird heruntergeladen https://download.scdn.co/SpotifySetup.exe\n',
    '  \u2588\u2588\u2592  1,5 MB / 3,0 MB\r',
    'Paketinstallation wird gestartet...\n',
  ]);
  assert.deepStrictEqual(events.map((e) => `${e.stage}:${e.pct}`), ['resolving:null', 'downloading:0', 'downloading:50', 'installing:null']);
});

test('percent-only progress and ANSI noise', () => {
  const { events } = run(['\x1b[0G\x1b[2K  \u2588\u2588\u2592\u2592  40%\r', '\x1b[2K  \u2588\u2588\u2588\u2588  100%\r\n']);
  assert.deepStrictEqual(events.map((e) => e.pct), [40, 100]);
  assert.strictEqual(cleanLine('\x1b[32m  - \x1b[0m'), '');
});
