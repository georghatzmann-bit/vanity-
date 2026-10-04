'use strict';
// Tests, die nur auf echtem Windows laufen (z. B. im GitHub-Build auf windows-latest).
// Sie prüfen die Discord-Steuerung mit einem nachgebauten "Discord" – ein echtes Discord wird nicht gebraucht.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const isWin = process.platform === 'win32';
const opts = { skip: !isWin && 'nur unter Windows' };

const NOTIFY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\com.squirrel.Discord.Discord';

function regEnabled() {
  try {
    const out = execFileSync('reg', ['query', NOTIFY_KEY, '/v', 'Enabled'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /Enabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
    return m ? parseInt(m[1], 16) : null;
  } catch (_) {
    return null;
  }
}

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-win-'));
  const local = path.join(base, 'Local');
  fs.mkdirSync(path.join(local, 'Discord'), { recursive: true });
  // Leere "Update.exe" reicht, damit Discord als installiert gilt
  fs.writeFileSync(path.join(local, 'Discord', 'Update.exe'), '');
  process.env.LOCALAPPDATA = local;
  const discord = require('../src/main/discord');
  discord.init({ dataDir: path.join(base, 'data'), resourcesDir: path.join(__dirname, '..', 'resources') });
  return { base, discord };
}

test('Windows: Benachrichtigungen stumm und exakt zurückstellen', opts, async () => {
  const before = regEnabled();
  const { discord } = setup();
  try {
    const st0 = await discord.getStatus();
    assert.equal(st0.supported, true);
    assert.deepEqual(st0.installed, ['Discord']);

    const mute = await discord.setMuted(true, { toasts: true, sound: true });
    assert.equal(mute.ok, true, mute.message);
    assert.equal(regEnabled(), 0);
    const st1 = await discord.getStatus();
    assert.equal(st1.muted.toasts, true);
    assert.equal(st1.muted.sound, true);

    const unmute = await discord.setMuted(false, {});
    assert.equal(unmute.ok, true, unmute.message);
    // vorher fehlte der Wert -> wieder entfernt, vorher 1 -> wieder 1
    assert.equal(regEnabled(), before === 0 ? 1 : before);
    const st2 = await discord.getStatus();
    assert.equal(st2.muted.toasts, false);
    assert.equal(st2.muted.sound, false);
  } finally {
    if (before === null) {
      try { execFileSync('reg', ['delete', NOTIFY_KEY, '/v', 'Enabled', '/f'], { stdio: 'ignore' }); } catch (_) { /* war schon weg */ }
    } else {
      execFileSync('reg', ['add', NOTIFY_KEY, '/v', 'Enabled', '/t', 'REG_DWORD', '/d', String(before), '/f'], { stdio: 'ignore' });
    }
  }
});

test('Windows: PowerShell-Hilfsskript für Discord-Töne läuft unter Windows PowerShell 5.1', opts, () => {
  const script = path.join(__dirname, '..', 'resources', 'scripts', 'DiscordAudio.ps1');
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-cache-'));
  for (let round = 0; round < 2; round++) {
    let code = 0;
    let out = '';
    try {
      out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'query', '-CacheDir', cache], { encoding: 'utf8', windowsHide: true });
    } catch (err) {
      code = err.status;
      out = String(err.stdout || '') + String(err.stderr || '');
    }
    // 0 = Sitzungen gefunden, 2 = Discord spielt gerade nichts ab. Alles andere wäre ein Fehler im Skript.
    assert.ok(code === 0 || code === 2, 'Exit-Code ' + code + ': ' + out);
  }
  // Beim ersten Lauf wird die DLL angelegt und beim zweiten wiederverwendet
  assert.ok(fs.existsSync(path.join(cache, 'DiscordAudio-v1.dll')), 'DLL-Zwischenspeicher fehlt');
});

test('Windows: laufendes "Discord" wird erkannt und beendet', opts, async () => {
  const { base, discord } = setup();
  // Kopie von node.exe unter dem Namen Discord.exe, die einfach wartet
  const fake = path.join(base, 'Discord.exe');
  fs.copyFileSync(process.execPath, fake);
  const child = spawn(fake, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await discord.getStatus();
    assert.equal(st.running, true);
    const res = await discord.stop();
    assert.equal(res.ok, true, res.message);
    const after = await discord.getStatus();
    assert.equal(after.running, false);
  } finally {
    try { child.kill(); } catch (_) { /* schon beendet */ }
  }
});

test('Windows: Konten-Wechsel beendet den laufenden Launcher und startet ihn neu', opts, async () => {
  const epic = require('../src/main/epic');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-epic-win-'));
  const ini = path.join(base, 'Config', 'GameUserSettings.ini');
  fs.mkdirSync(path.dirname(ini), { recursive: true });
  fs.writeFileSync(ini, '[RememberMe]\r\nEnable=True\r\nData=EINS\r\nEmail=eins@beispiel.de\r\n', 'utf8');
  // Kopie von node.exe unter dem Namen des Launchers, die einfach wartet
  const fake = path.join(base, 'EpicGamesLauncher.exe');
  fs.copyFileSync(process.execPath, fake);
  // Eigener Test-Schlüssel in der Registry: der echte Epic-Schlüssel des Testrechners bleibt unberührt
  const TEST_KEY = 'HKCU\\Software\\Konto-Retter-Test\\Identifiers';
  const setRegId = (id) => execFileSync('reg', ['add', TEST_KEY, '/v', 'AccountId', '/t', 'REG_SZ', '/d', id, '/f'], { stdio: 'ignore', windowsHide: true });
  const getRegId = () => {
    try {
      const out = execFileSync('reg', ['query', TEST_KEY, '/v', 'AccountId'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /AccountId\s+REG_SZ\s+(\S+)/i.exec(out);
      return m ? m[1] : null;
    } catch (_) {
      return null;
    }
  };
  const ID_A = 'a'.repeat(32);
  const ID_B = 'b'.repeat(32);
  setRegId(ID_A);
  epic.init({ dataDir: path.join(base, 'data'), crypto: null, ini, exe: fake, regKey: TEST_KEY });
  const child = spawn(fake, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await epic.saveCurrent('A')).ok, true);
    const st = await epic.getStatus();
    assert.equal(st.running, true);
    assert.equal(st.launcherInstalled, true);
    assert.equal(st.diag.accountId, ID_A, 'Konto-ID aus der Registry nicht gelesen');
    // Zweites Konto anmelden (der Launcher schreibt dann auch dessen Konto-ID) und zurück zum ersten wechseln
    fs.writeFileSync(ini, '[RememberMe]\r\nEnable=True\r\nData=ZWEI\r\nEmail=zwei@beispiel.de\r\n', 'utf8');
    setRegId(ID_B);
    const a = st.accounts[0];
    const res = await epic.switchTo(a.id);
    assert.equal(res.ok, true, res.message);
    assert.match(fs.readFileSync(ini, 'utf8'), /Data=EINS/);
    assert.equal(getRegId(), ID_A, 'Konto-ID in der Registry wurde beim Wechsel nicht zurückgestellt');
    // Der wartende Prozess wurde beendet (der Neustart startet die Kopie ohne Argumente, die sofort endet)
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(child.exitCode !== null || child.killed, true, 'Launcher-Prozess läuft noch');
    // "Launcher beenden" aus der Konten-Ansicht: erst höflich, dann hart – der Prozess ist danach weg
    const child2 = spawn(fake, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal((await epic.getStatus()).running, true);
      const closed = await epic.closeLauncher();
      assert.equal(closed.ok, true, closed.message);
      assert.equal((await epic.getStatus()).running, false);
      assert.equal((await epic.closeLauncher()).ok, true, 'nochmal beenden ist harmlos');
    } finally {
      try { child2.kill(); } catch (_) { /* schon beendet */ }
    }
  } finally {
    try { child.kill(); } catch (_) { /* schon beendet */ }
    try { execFileSync('taskkill', ['/IM', 'EpicGamesLauncher.exe', '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) { /* nichts mehr da */ }
    try { execFileSync('reg', ['delete', 'HKCU\\Software\\Konto-Retter-Test', '/f'], { stdio: 'ignore', windowsHide: true }); } catch (_) { /* schon weg */ }
  }
});
