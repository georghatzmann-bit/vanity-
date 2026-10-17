'use strict';
// Install pipeline logic that runs on Linux: winget args, abortable back-off, runItems cancel/repair
// path, queue log persistence + isRunning, worker connect timer (elevate.js) – with module stubs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const Module = require('module');

// --- stubs that must exist before the modules under test are loaded --------------------------------
function stubModule(file, exports) {
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  require.cache[file] = m;
}
stubModule(require.resolve('electron'), { app: { isPackaged: true, getAppPath: () => process.cwd() } });

const psStub = { runPsJson: async () => ({ ok: false, code: 1223 }) };
stubModule(require.resolve('../src/main/util/ps'), { ...require('../src/main/util/ps'), runPsJson: (...a) => psStub.runPsJson(...a) });

const log = require('../src/main/log');
const logged = [];
log.info = (...a) => logged.push(a.join(' '));
log.warn = () => {};
log.error = () => {};

const runner = require('../src/main/winget/runner');
const { classify } = require('../src/main/winget/errors');
const locate = require('../src/main/winget/locate');
const bootstrap = require('../src/main/winget/bootstrap');
const elevate = require('../src/main/install/elevate');
const { encodeMessage } = require('../src/main/install/protocol');

// --- winget args --------------------------------------------------------------------------------------
test('catalog args are passed for every accepted winget version (>= MIN_VERSION 1.6.3482)', () => {
  const dx = runner.installArgs({ id: 'Microsoft.DirectX', source: 'winget' }, locate.MIN_VERSION);
  assert.deepStrictEqual(dx.slice(-2), ['--installer-type', 'exe']);
  assert.ok(!dx.includes('--no-upgrade')); // only from 1.9.0 on
  const bnet = runner.installArgs({ id: 'Blizzard.BattleNet', source: 'winget' }, '1.6.3482');
  assert.deepStrictEqual(bnet.slice(-2), ['--location', 'C:\\Program Files (x86)\\Battle.net']);
  const modern = runner.installArgs({ id: 'Microsoft.DirectX', source: 'winget' }, '1.12.350');
  assert.ok(modern.includes('--no-upgrade'));
  assert.deepStrictEqual(modern.slice(-2), ['--installer-type', 'exe']);
});

test('INSTALL_LOCATION_REQUIRED and UNSUPPORTED_ARGUMENT have German messages', () => {
  const loc = classify(0x8a15005f);
  assert.strictEqual(loc.name, 'INSTALL_LOCATION_REQUIRED');
  assert.strictEqual(loc.status, 'failed');
  assert.match(loc.message, /Installationsordner/);
  const arg = classify(-1978335143); // signed form of 0x8A150059
  assert.strictEqual(arg.name, 'UNSUPPORTED_ARGUMENT');
  assert.strictEqual(arg.retry, null);
});

// --- back-off sleep -----------------------------------------------------------------------------------
test('back-off sleep ends as soon as the job is cancelled', async () => {
  const c = new AbortController();
  const t0 = Date.now();
  setTimeout(() => c.abort(), 30);
  await runner.sleep(60000, c.signal);
  assert.ok(Date.now() - t0 < 2000);
  const t1 = Date.now();
  await runner.sleep(60000, c.signal); // already aborted
  assert.ok(Date.now() - t1 < 100);
  const t2 = Date.now();
  await runner.sleep(40); // no signal: normal sleep
  assert.ok(Date.now() - t2 >= 35);
});

// --- runItems -----------------------------------------------------------------------------------------
test('runItems: cancelled before start -> no winget check/repair, every item cancelled', async () => {
  const { runItems } = require('../src/main/install/runItems');
  const origStatus = locate.getStatus;
  const origEnsure = bootstrap.ensureWinget;
  let touched = 0;
  locate.getStatus = async () => {
    touched++;
    return { ok: false };
  };
  bootstrap.ensureWinget = async () => {
    touched++;
    return { ok: false };
  };
  try {
    const c = new AbortController();
    c.abort();
    const events = [];
    const res = await runItems([{ key: 'winget:A', id: 'A' }, { key: 'winget:B', id: 'B' }], { emit: (e) => events.push(e), signal: c.signal });
    assert.strictEqual(touched, 0);
    assert.deepStrictEqual(res.map((r) => r.status), ['cancelled', 'cancelled']);
    assert.deepStrictEqual(events.map((e) => `${e.type}:${e.status}`), ['item-done:cancelled', 'item-done:cancelled']);
  } finally {
    locate.getStatus = origStatus;
    bootstrap.ensureWinget = origEnsure;
  }
});

test('runItems: winget repair is visible as a phase and the phase returns to installing', async () => {
  const { runItems } = require('../src/main/install/runItems');
  const origStatus = locate.getStatus;
  const origEnsure = bootstrap.ensureWinget;
  locate.getStatus = async () => ({ ok: false, version: null });
  bootstrap.ensureWinget = async ({ onProgress }) => {
    onProgress({ step: 'repair', message: 'winget wird repariert' });
    return { ok: false };
  };
  try {
    const events = [];
    const lines = [];
    await runItems([{ key: 'winget:A', id: 'A' }], { emit: (e) => events.push(e), log: (l) => lines.push(l) });
    assert.deepStrictEqual(events.map((e) => e.phase || e.status), ['winget-check', 'installing', 'failed']);
    assert.ok(lines.some((l) => /Reparatur/.test(l)));
  } finally {
    locate.getStatus = origStatus;
    bootstrap.ensureWinget = origEnsure;
  }
});

// --- queue --------------------------------------------------------------------------------------------
test('queue: winget output lines reach the log file, isRunning tracks the job', async () => {
  const runItemsMod = require('../src/main/install/runItems');
  const reg = require('../src/main/util/reg');
  const orig = { runItems: runItemsMod.runItems, isElevated: elevate.isElevated, ensure: bootstrap.ensureWinget, reg: reg.regKeysExist };
  runItemsMod.runItems = async (items, { emit }) => {
    for (const it of items) {
      emit({ type: 'log', key: it.key, line: 'Installation fehlgeschlagen mit Exitcode: 1603' });
      emit({ type: 'item-done', key: it.key, status: 'failed', rebootRequired: false, message: 'x', durationMs: 1 });
    }
  };
  elevate.isElevated = () => true; // no worker / UAC in this test
  bootstrap.ensureWinget = async () => ({ ok: true });
  reg.regKeysExist = async (keys) => keys.map(() => false);
  delete require.cache[require.resolve('../src/main/install/queue')];
  const queue = require('../src/main/install/queue');
  try {
    assert.strictEqual(queue.isRunning(), false);
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    const events = [];
    queue.startJob([{ key: 'winget:Foo.Bar', id: 'Foo.Bar', source: 'winget', name: 'Foo', elevation: 'none', scope: 'machine' }], {
      emit: (e) => {
        events.push(e);
        if (e.type === 'job-done') resolveDone(e);
      },
    });
    assert.strictEqual(queue.isRunning(), true);
    const jobDone = await done;
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(queue.isRunning(), false);
    assert.strictEqual(jobDone.summary.failed, 1);
    assert.ok(logged.some((l) => l === '[winget:Foo.Bar] Installation fehlgeschlagen mit Exitcode: 1603'), logged.join('\n'));
    assert.ok(events.some((e) => e.type === 'log' && e.key === 'winget:Foo.Bar'));
  } finally {
    runItemsMod.runItems = orig.runItems;
    elevate.isElevated = orig.isElevated;
    bootstrap.ensureWinget = orig.ensure;
    reg.regKeysExist = orig.reg;
  }
});

// --- elevate: worker connect timer --------------------------------------------------------------------
// On Linux the "\\.\pipe\..." name is just a relative Unix-socket path, so run inside a temp dir.
const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phx-elev-'));
process.chdir(sockDir);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let unhandled = 0;
process.on('unhandledRejection', () => unhandled++);

function parseArgs(argLine) {
  const a = argLine.split(' ');
  return { pipe: `\\\\.\\pipe\\${a[a.indexOf('--pipe') + 1]}`, token: a[a.indexOf('--token') + 1] };
}
function fakeWorker({ pipe, token }) {
  const sock = net.connect(pipe);
  sock.on('connect', () => sock.write(encodeMessage({ t: 'hello', token, pid: 4242, elevated: true, user: os.userInfo().username })));
  sock.on('data', (d) => {
    if (!String(d).includes('"t":"job"')) return;
    sock.write(encodeMessage({ t: 'log', line: 'winget wird repariert' }));
    sock.write(encodeMessage({ t: 'event', event: { type: 'item-done', key: 'winget:A', status: 'installed' } }));
    sock.write(encodeMessage({ t: 'bye' }));
  });
  sock.on('error', () => {});
  return sock;
}

test('elevate: a slow "Ja" in the UAC prompt does not time out the worker connection', async () => {
  let worker = null;
  psStub.runPsJson = async (_script, { env }) => {
    await sleep(300); // UAC prompt open longer than timeoutMs
    worker = fakeWorker(parseArgs(env.PHX_ELEV_ARGS));
    return { ok: true, pid: 4242 };
  };
  const handle = await elevate.launchWorker({ timeoutMs: 150 });
  assert.strictEqual(handle.pid, 4242);
  // worker log lines (e.g. the elevated winget repair) reach the install events
  const events = [];
  const res = await handle.runJob([{ key: 'winget:A' }], (e) => events.push(e));
  assert.deepStrictEqual(res, { disconnected: false });
  assert.deepStrictEqual(events.map((e) => e.type), ['log', 'item-done']);
  assert.strictEqual(events[0].line, 'winget wird repariert');
  handle.close();
  worker.destroy();
});

test('elevate: worker connecting before Process.Start returns is accepted', async () => {
  let worker = null;
  psStub.runPsJson = async (_script, { env }) => {
    worker = fakeWorker(parseArgs(env.PHX_ELEV_ARGS));
    await sleep(250);
    return { ok: true, pid: 4242 };
  };
  const handle = await elevate.launchWorker({ timeoutMs: 100 });
  assert.strictEqual(handle.elevated, true);
  handle.close();
  worker.destroy();
});

test('elevate: no hello after the prompt -> TIMEOUT; declined -> DECLINED without stray rejections', async () => {
  psStub.runPsJson = async () => ({ ok: true, pid: 1 });
  const t0 = Date.now();
  await assert.rejects(elevate.launchWorker({ timeoutMs: 120 }), (err) => err.code === 'TIMEOUT');
  assert.ok(Date.now() - t0 >= 100);

  psStub.runPsJson = async () => ({ ok: false, code: 1223, message: 'abgebrochen' });
  await assert.rejects(elevate.launchWorker({ timeoutMs: 50 }), (err) => err.code === 'DECLINED');
  psStub.runPsJson = async () => {
    throw new Error('powershell fehlt');
  };
  await assert.rejects(elevate.launchWorker({ timeoutMs: 50 }), (err) => err.code === 'FAILED');
  await sleep(200); // the old code rejected `connected` unhandled after timeoutMs
  assert.strictEqual(unhandled, 0);
});

test.after(() => {
  process.chdir(os.tmpdir());
  fs.rmSync(sockDir, { recursive: true, force: true });
});
