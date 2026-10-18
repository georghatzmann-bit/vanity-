'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const logic = require('../../src/main/tools/ping-logic');
const ping = require('../../src/main/modules/tools/ping');

const VIEW = path.join(__dirname, '..', '..', 'src', 'renderer', 'js', 'lib', 'ping-view.mjs');

// Typische Werte aus Deutschland (Median in ms)
const BASE = { de: 17, fr: 24, gb: 26, il: 63, bah: 118, mum: 128, va: 96, oh: 104, ia: 117, tx: 128, mx: 148, ncal: 158, or: 162, sao: 201, tok: 238, syd: 289 };

/** ICMP-Messung ohne Netzwerk: liefert feste Werte, optional ohne Antwort für einzelne Ziele. */
function fakeIcmp({ silent = [], values = BASE } = {}) {
  const calls = [];
  const fn = async (targets, opts, onSample) => {
    calls.push({ targets: targets.map((t) => t.id), opts });
    const map = {};
    for (const t of targets) {
      map[t.id] = [];
      for (let i = 0; i < opts.samples; i++) {
        const v = silent.includes(t.id) ? null : values[t.id] + (i % 3);
        map[t.id].push(v);
        onSample(t.id, v, {});
      }
    }
    return map;
  };
  fn.calls = calls;
  return fn;
}

/** TCP ohne Netzwerk: lookup/connect mit Protokoll. */
function fakeTcp({ values = BASE, fail = [] } = {}) {
  const log = { lookups: [], connects: [] };
  return {
    log,
    lookup: async (host, o) => {
      log.lookups.push({ host, o });
      if (fail.includes(host)) throw new Error('ENOTFOUND');
      return { address: `10.0.0.${log.lookups.length}`, family: 4 };
    },
    connect: async (address, port, timeout) => {
      log.connects.push({ address, port, timeout });
      const host = log.lookups.find((l, i) => `10.0.0.${i + 1}` === address).host;
      const t = logic.TARGETS.find((x) => x.tcp === host);
      return values[t.id] + 3;
    },
  };
}

function fakeCtx({ win = true, state = {} } = {}) {
  const store = { 'tool-ping': JSON.parse(JSON.stringify(state)) };
  const events = [];
  return {
    store,
    events,
    exec: { IS_WIN: win, powershellStream: () => { throw new Error('nicht in Tests'); } },
    core: {
      readState: async (n, fb) => (n in store ? JSON.parse(JSON.stringify(store[n])) : fb),
      writeState: async (n, o) => { store[n] = JSON.parse(JSON.stringify(o)); },
    },
    emit: (name, payload) => events.push({ name, payload }),
    log: () => {},
  };
}

// ---------------------------------------------------------------- Server-Liste
test('Server-Liste: 16 aktuelle Unterregionen, nur Epic-Ping-Hosts und regionale TCP-Ziele', () => {
  assert.equal(logic.TARGETS.length, 16);
  const ids = logic.TARGETS.map((t) => t.id).sort();
  assert.deepEqual(ids, ['bah', 'de', 'fr', 'gb', 'ia', 'il', 'mum', 'mx', 'ncal', 'oh', 'or', 'sao', 'syd', 'tok', 'tx', 'va']);
  for (const t of logic.TARGETS) {
    assert.match(t.host, /^ping-[a-z]+\.ds\.on\.epicgames\.com$/, t.id);
    assert.equal(t.host, `ping-${t.id}.ds.on.epicgames.com`);
    if (t.tcp) assert.match(t.tcp, logic.TCP_RE, t.id);
  }
  // Iowa (Google) und Texas (AWS Local Zone) haben kein TCP-Ziel, Bahrain ist nur eine Schätzung
  assert.equal(logic.TARGET_BY_ID.get('ia').tcp, null);
  assert.equal(logic.TARGET_BY_ID.get('tx').tcp, null);
  assert.equal(logic.TARGET_BY_ID.get('bah').tcpEstimate, true);
  assert.equal(logic.TARGET_BY_ID.get('de').tcp, 'dynamodb.eu-central-1.amazonaws.com');
  assert.equal(logic.TARGET_BY_ID.get('va').tcp, 'dynamodb.us-east-1.amazonaws.com');
  // Namen für die Oberfläche
  assert.equal(logic.TARGET_BY_ID.get('de').name, 'Deutschland');
  assert.equal(logic.TARGET_BY_ID.get('ncal').name, 'Nordkalifornien');
  assert.equal(logic.TARGET_BY_ID.get('de').region, 'Europa');
  const cat = logic.catalog();
  assert.equal(cat.find((g) => g.id === 'NA').subs.length, 7);
  assert.equal(cat[0].subs[0].lat, undefined, 'Koordinaten bleiben intern');
});

// ---------------------------------------------------------------- Statistik
test('Statistik: Minimum, Median, Schwankung und Verlust', () => {
  const s = logic.computeStats([20, 22, null, 18, 30]);
  assert.equal(s.sent, 5);
  assert.equal(s.received, 4);
  assert.equal(s.minMs, 18);
  assert.equal(s.medianMs, 21); // (20+22)/2
  assert.equal(s.maxMs, 30);
  assert.equal(s.lossPct, 20);
  // Schwankung: |22-20| + |18-22| + |30-18| = 2+4+12 = 18 / 3 = 6
  assert.equal(s.jitterMs, 6);
  assert.equal(logic.computeStats([5, 7, 9]).medianMs, 7);
  assert.equal(logic.computeStats([5]).jitterMs, null, 'eine Antwort: keine Schwankung');
});

test('Statistik: keine Antworten und leere Liste', () => {
  const s = logic.computeStats([null, null, null]);
  assert.equal(s.lossPct, 100);
  assert.equal(s.medianMs, null);
  assert.equal(s.minMs, null);
  const e = logic.computeStats([]);
  assert.equal(e.sent, 0);
  assert.equal(e.lossPct, null);
  assert.equal(logic.computeStats([12.345, 12.35]).medianMs, 12.3);
  assert.equal(logic.computeStats([1, -5, NaN, 'x']).received, 1, 'ungültige Werte zählen als verloren');
});

test('Anzahl Messungen wird begrenzt (3 bis 20, sonst 8)', () => {
  assert.equal(logic.clampSamples(1), 3);
  assert.equal(logic.clampSamples(500), 20);
  assert.equal(logic.clampSamples('abc'), 8);
  assert.equal(logic.clampSamples(8), 8);
  assert.equal(logic.normMethod('udp'), 'auto', 'unbekannte Messart -> automatisch');
});

// ---------------------------------------------------------------- Proxy / VPN
test('Proxy/VPN: unmöglich schnelle Werte zu weit entfernten Regionen werden erkannt', () => {
  const r = logic.detectProxy([{ id: 'de', minMs: 1 }, { id: 'va', minMs: 1.2 }, { id: 'syd', minMs: 1.5 }]);
  assert.equal(r.suspect, true);
  assert.equal(r.message, 'Proxy/VPN erkannt, Werte nicht aussagekräftig');
  assert.ok(r.ids.includes('de') && r.ids.includes('va'));
  // Zwei nahe Rechenzentren mit sehr kleinen Werten: Frankfurt-Paris ≈ 480 km -> mindestens ≈ 4,8 ms zusammen
  assert.equal(logic.detectProxy([{ id: 'de', minMs: 0.8 }, { id: 'fr', minMs: 0.9 }]).suspect, true);
});

test('Proxy/VPN: normale Werte aus Deutschland lösen keinen Alarm aus', () => {
  const normal = Object.entries(BASE).map(([id, ms]) => ({ id, minMs: ms - 1 }));
  assert.equal(logic.detectProxy(normal).suspect, false);
  // Wohnung direkt in Frankfurt: 2 ms nach DE, 9 ms nach FR ist möglich
  assert.equal(logic.detectProxy([{ id: 'de', minMs: 2 }, { id: 'fr', minMs: 9 }, { id: 'va', minMs: 85 }]).suspect, false);
  // nur ein Wert -> nichts zu vergleichen
  assert.equal(logic.detectProxy([{ id: 'de', minMs: 0.5 }]).suspect, false);
  assert.equal(logic.detectProxy([]).suspect, false);
});

test('Physik: Entfernung Frankfurt–Virginia passt (≈ 6500 km)', () => {
  const d = logic.distanceKm(logic.TARGET_BY_ID.get('de'), logic.TARGET_BY_ID.get('va'));
  assert.ok(d > 6300 && d < 6800, String(d));
  assert.ok(logic.minRttBetweenMs(logic.TARGET_BY_ID.get('de'), logic.TARGET_BY_ID.get('va')) > 60);
});

// ---------------------------------------------------------------- Bester Server
test('Bester Server: kleinster Median, hoher Verlust zählt nicht', () => {
  const best = logic.pickBest([
    { id: 'de', medianMs: 15, lossPct: 50, jitterMs: 1 },
    { id: 'fr', medianMs: 22, lossPct: 0, jitterMs: 1 },
    { id: 'gb', medianMs: 25, lossPct: 0, jitterMs: 1 },
    { id: 'ia', medianMs: null, lossPct: 100 },
  ]);
  assert.equal(best.id, 'fr');
  // Gleichstand: weniger Verlust, dann weniger Schwankung gewinnt
  assert.equal(logic.pickBest([{ id: 'a', medianMs: 20, lossPct: 12.5, jitterMs: 1 }, { id: 'b', medianMs: 20, lossPct: 0, jitterMs: 5 }]).id, 'b');
  // Nur schlechte Server -> trotzdem der schnellste
  assert.equal(logic.pickBest([{ id: 'x', medianMs: 40, lossPct: 60 }, { id: 'y', medianMs: 30, lossPct: 80 }]).id, 'y');
  assert.equal(logic.pickBest([{ id: 'z', medianMs: null }]), null);
});

// ---------------------------------------------------------------- Ablauf
test('Messung "Automatisch" unter Windows: Ping für alle, TCP nur für stumme Server mit TCP-Ziel', async () => {
  const icmp = fakeIcmp({ silent: ['de', 'tx'] });
  const tcp = fakeTcp();
  const progress = [];
  const rep = await logic.measureAll({ method: 'auto', samples: 5, canIcmp: true, icmp, tcpDeps: tcp, gapMs: 0, onProgress: (p) => progress.push(p) });
  assert.equal(icmp.calls.length, 1);
  assert.equal(icmp.calls[0].targets.length, 16);
  assert.equal(icmp.calls[0].opts.timeoutMs, 1000);
  assert.equal(icmp.calls[0].opts.samples, 5);
  const de = rep.results.find((r) => r.id === 'de');
  assert.equal(de.method, 'tcp');
  assert.equal(de.host, 'dynamodb.eu-central-1.amazonaws.com');
  assert.equal(de.medianMs, 20);
  const tx = rep.results.find((r) => r.id === 'tx');
  assert.equal(tx.noFallback, true, 'Texas hat kein TCP-Ziel');
  assert.equal(tx.unreachable, true);
  assert.equal(rep.results.find((r) => r.id === 'fr').method, 'icmp');
  assert.equal(rep.method, 'mixed');
  // TCP: Name einmal auflösen (zählt nicht mit), dann 5 Verbindungen auf Port 443
  assert.deepEqual(tcp.log.lookups.map((l) => l.host), ['dynamodb.eu-central-1.amazonaws.com']);
  assert.equal(tcp.log.lookups[0].o.family, 4);
  assert.equal(tcp.log.connects.length, 5);
  assert.ok(tcp.log.connects.every((c) => c.port === 443));
  assert.equal(rep.best.id, 'de', 'Deutschland über TCP (20 ms) schlägt Frankreich über Ping (Median 25 ms)');
  assert.ok(progress.some((p) => p.phase === 'icmp') && progress.some((p) => p.phase === 'tcp'));
  assert.equal(progress.filter((p) => p.phase === 'icmp').pop().done, 80);
});

test('Messung "TCP": Iowa und Texas bleiben leer, Bahrain ist als Schätzung markiert', async () => {
  const tcp = fakeTcp();
  const rep = await logic.measureAll({ method: 'tcp', samples: 4, canIcmp: true, icmp: () => { throw new Error('darf nicht'); }, tcpDeps: tcp, gapMs: 0 });
  assert.equal(rep.method, 'tcp');
  assert.equal(tcp.log.lookups.length, 14);
  assert.equal(rep.results.find((r) => r.id === 'ia').noFallback, true);
  assert.equal(rep.results.find((r) => r.id === 'bah').estimate, true);
  assert.equal(rep.best.id, 'de');
  assert.equal(rep.best.name, 'Deutschland');
  assert.equal(rep.best.region, 'Europa');
  assert.equal(rep.proxy.suspect, false);
});

test('Ohne Windows: "Automatisch" misst über TCP, "Nur Ping" wird abgelehnt', async () => {
  const tcp = fakeTcp();
  const rep = await logic.measureAll({ method: 'auto', samples: 3, canIcmp: false, icmp: () => { throw new Error('darf nicht'); }, tcpDeps: tcp, gapMs: 0 });
  assert.equal(rep.method, 'tcp');
  await assert.rejects(logic.measureAll({ method: 'icmp', samples: 3, canIcmp: false, icmp: fakeIcmp(), tcpDeps: tcp }), (e) => e.code === 'NOT_WINDOWS');
});

test('TCP: nach 3 Fehlversuchen ohne Antwort wird aufgehört, DNS-Fehler zählt als Verlust', async () => {
  const t = logic.TARGET_BY_ID.get('de');
  let connects = 0;
  const seen = [];
  const r = await logic.tcpTarget(t, { samples: 8, gapMs: 0 }, { lookup: async () => ({ address: '1.2.3.4' }), connect: async () => { connects++; return null; } }, (id, ms, x) => seen.push(x.skipped || 1));
  assert.equal(connects, 3);
  assert.equal(r.values.length, 8);
  assert.equal(seen.reduce((a, b) => a + b, 0), 8, 'Fortschritt zählt die übersprungenen mit');
  const d = await logic.tcpTarget(t, { samples: 4, gapMs: 0 }, { lookup: async () => { throw new Error('x'); }, connect: async () => 1 }, () => {});
  assert.equal(d.error, 'DNS');
  assert.equal(logic.computeStats(d.values).lossPct, 100);
});

test('Abbrechen: TCP stoppt sofort', async () => {
  const signal = { cancelled: false };
  const tcp = fakeTcp();
  const orig = tcp.connect;
  tcp.connect = async (...a) => { signal.cancelled = true; return orig(...a); };
  const rep = await logic.measureAll({ method: 'tcp', samples: 8, canIcmp: false, tcpDeps: tcp, gapMs: 0, signal });
  assert.equal(rep.cancelled, true);
  assert.ok(tcp.log.connects.length < 14 * 8);
});

test('runPool hält die Höchstzahl gleichzeitiger Aufgaben ein', async () => {
  let now = 0;
  let max = 0;
  const out = await logic.runPool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    now++; max = Math.max(max, now);
    await new Promise((r) => setTimeout(r, 5));
    now--;
    return x * 2;
  });
  assert.equal(max, 3);
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
});

// ---------------------------------------------------------------- Verlauf
test('Verlauf: Form wie abgestimmt, höchstens 10 Einträge, neueste zuletzt', () => {
  let st = {};
  for (let i = 0; i < 12; i++) {
    st = logic.appendHistory(st, {
      at: 1000 + i, method: 'icmp', best: { id: 'de', name: 'Deutschland', region: 'Europa', ms: 17 + i },
      results: [{ id: 'de', name: 'Deutschland', region: 'Europa', host: 'ping-de.ds.on.epicgames.com', minMs: 16, medianMs: 17, jitterMs: 1, lossPct: 0, samples: [1, 2], method: 'icmp', estimate: false }],
    });
  }
  assert.equal(st.history.length, 10);
  assert.equal(st.history[9].at, 1011);
  const e = st.history[9];
  assert.deepEqual(Object.keys(e), ['at', 'method', 'best', 'results']);
  assert.deepEqual(Object.keys(e.best), ['id', 'name', 'region', 'ms']);
  assert.deepEqual(Object.keys(e.results[0]), ['id', 'name', 'region', 'host', 'minMs', 'medianMs', 'jitterMs', 'lossPct']);
});

test('Cockpit-Zeile', () => {
  assert.equal(logic.summaryText({}), 'Noch nicht gemessen – findet deinen schnellsten Server');
  const st = { history: [{ at: 5, method: 'icmp', best: { id: 'de', name: 'Deutschland', region: 'Europa', ms: 18 }, results: [] }] };
  assert.equal(logic.summaryText(st), 'Bester Server: Deutschland, 18 ms');
  assert.equal(logic.summaryText({ ...st, lastProxyAt: 5 }), 'Bester Server: Deutschland, 18 ms (unsicher: Proxy/VPN)');
  assert.equal(logic.summaryText({ history: [{ at: 1, best: null, results: [] }] }), 'Letzte Messung: kein Server erreichbar');
  assert.equal(logic.fmtMsText(4.25), '4,3 ms');
});

// ---------------------------------------------------------------- PowerShell
test('PowerShell-Ping: sprachneutral über .NET, nur Epic-Hosts, kein UDP', () => {
  const script = ping._test.icmpScript(logic.TARGETS, { samples: 8, timeoutMs: 1000, batch: 8 });
  assert.match(script, /System\.Net\.NetworkInformation\.Ping/);
  assert.match(script, /SendPingAsync/);
  assert.match(script, /ConvertTo-Json -Compress/);
  assert.doesNotMatch(script, /ping\.exe|Test-Connection|Udp|22222/i);
  const b64 = script.match(/FromBase64String\('([^']+)'\)/)[1];
  const cfg = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  assert.equal(cfg.targets.length, 16);
  assert.equal(cfg.timeout, 1000);
  assert.ok(cfg.targets.every((t) => logic.HOST_RE.test(t.host)));
  // fremde Hosts werden nie ins Skript übernommen
  const evil = ping._test.icmpScript([{ id: 'x', host: "evil.com'; Remove-Item C:\\" }], { samples: 3, timeoutMs: 1000, batch: 8 });
  const cfg2 = JSON.parse(Buffer.from(evil.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString('utf8'));
  assert.equal(cfg2.targets.length, 0);
});

test('PowerShell-Ping: JSON-Zeilen werden gelesen, Fortschritt zählt übersprungene Ziele', async () => {
  const lines = [
    { type: 'sample', id: 'de', round: 0, ms: 17, status: 'Success' },
    { type: 'sample', id: 'tx', round: 0, ms: null, status: 'TimedOut' },
    { type: 'sample', id: 'de', round: 1, ms: 18, status: 'Success' },
    { type: 'skip', id: 'tx', count: 2 },
    { type: 'sample', id: 'de', round: 2, ms: 16, status: 'Success' },
    { type: 'quatsch' },
    { type: 'done' },
  ];
  let killed = false;
  const ctx = {
    exec: {
      powershellStream: (script, onObj, onExit) => {
        setImmediate(() => { for (const l of lines) onObj(l); onExit(0); });
        return () => { killed = true; };
      },
    },
  };
  const targets = [logic.TARGET_BY_ID.get('de'), logic.TARGET_BY_ID.get('tx')];
  const seen = [];
  const map = await ping._test.icmpRunner(ctx)(targets, { samples: 3, timeoutMs: 1000, batch: 8 }, (id, ms, x) => seen.push([id, ms, x.skipped || 0]), {});
  assert.deepEqual(map.de, [17, 18, 16]);
  assert.deepEqual(map.tx, [null, null, null]);
  assert.equal(killed, true, 'PowerShell wird nach "done" beendet');
  assert.deepEqual(seen.find((s) => s[2] === 2), ['tx', null, 2]);
  assert.equal(logic.parseIcmpLine({ type: 'sample', id: 'de', ms: -3 }).ms, null);
  assert.equal(logic.parseIcmpLine(null), null);
});

// ---------------------------------------------------------------- Modul
test('Modul: Messung speichert Verlauf, Einstellungen und meldet Fortschritt', async () => {
  ping._test.reset();
  ping._test.setDeps({ icmp: fakeIcmp(), tcp: fakeTcp(), gapMs: 0 });
  const ctx = fakeCtx({ win: true });
  const rep = await ping.handlers.measure({ method: 'auto', samples: 5 }, ctx);
  assert.equal(rep.best.id, 'de');
  const st = ctx.store['tool-ping'];
  assert.equal(st.history.length, 1);
  assert.equal(st.history[0].best.name, 'Deutschland');
  assert.deepEqual(st.settings, { method: 'auto', samples: 5 });
  assert.ok(ctx.events.some((e) => e.name === 'ping.progress'));
  assert.ok(ctx.events.some((e) => e.name === 'ping.done'));
  const sum = await ping.handlers.summary({}, ctx);
  assert.equal(sum.text, 'Bester Server: Deutschland, 18 ms');
  const info = await ping.handlers.info({}, ctx);
  assert.equal(info.platform.icmp, true);
  assert.equal(info.history.length, 1);
  assert.equal(info.regions.length, 6);
  await ping.handlers.clearHistory({}, ctx);
  assert.equal(ctx.store['tool-ping'].history.length, 0);
  ping._test.reset();
});

test('Modul: "Nur Ping" ohne Windows -> NOT_WINDOWS, keine zweite Messung gleichzeitig', async () => {
  ping._test.reset();
  const ctx = fakeCtx({ win: false });
  await assert.rejects(ping.handlers.measure({ method: 'icmp' }, ctx), (e) => e.code === 'NOT_WINDOWS');
  const pending = [];
  const release = () => { while (pending.length) pending.shift()(5); };
  const slow = { lookup: async () => ({ address: '1.1.1.1' }), connect: () => new Promise((r) => { pending.push(r); }) };
  ping._test.setDeps({ tcp: slow, gapMs: 0 });
  const first = ping.handlers.measure({ method: 'tcp', samples: 3 }, ctx);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(ping.handlers.measure({ method: 'tcp' }, ctx), (e) => e.code === 'BUSY');
  const c = await ping.handlers.cancel({}, ctx);
  assert.equal(c.cancelled, true);
  release();
  ping._test.setDeps({ tcp: { lookup: async () => ({ address: '1.1.1.1' }), connect: async () => 5 }, gapMs: 0 });
  const rep = await first;
  assert.equal(rep.cancelled, true);
  assert.equal(ctx.store['tool-ping'].history, undefined, 'abgebrochene Messung kommt nicht in den Verlauf');
  ping._test.reset();
});

// ---------------------------------------------------------------- Anzeige-Logik (ES-Modul der Oberfläche)
test('Anzeige: Bewertung, Balken, Formatierung', async () => {
  const v = await import(VIEW);
  assert.equal(v.quality(18).label, 'sehr gut');
  assert.equal(v.quality(45).type, 'ok');
  assert.equal(v.quality(80).type, 'warn');
  assert.equal(v.quality(140).type, 'err');
  assert.equal(v.quality(null).label, 'keine Antwort');
  assert.equal(v.fmtMs(4.26), '4,3\u00a0ms');
  assert.equal(v.fmtMs(17.6), '18\u00a0ms');
  assert.equal(v.fmtMs(null), '–');
  assert.equal(v.fmtPct(12.5), '12,5\u00a0%');
  assert.equal(v.scaleMax([{ medianMs: 20 }]), 150);
  assert.equal(v.scaleMax([{ medianMs: 289 }]), 300);
  assert.equal(v.scaleMax([{ medianMs: 900 }]), 400);
  assert.equal(v.barPct(150, 300), 50);
  assert.equal(v.barPct(1, 300), 2, 'kleine Werte bleiben sichtbar');
  assert.equal(v.barPct(null, 300), 0);
  const ls = v.liveStats([10, null, 14, 12]);
  assert.equal(ls.medianMs, 12);
  assert.equal(ls.lossPct, 25);
  assert.equal(ls.minMs, 10);
  assert.equal(ls.jitterMs, 3);
});

test('Anzeige: Regionen nach bestem Wert sortiert, innen schnellste zuerst', async () => {
  const v = await import(VIEW);
  const results = Object.entries(BASE).map(([id, ms]) => ({ id, medianMs: ms, lossPct: 0 }));
  const groups = v.groupResults(logic.catalog(), results);
  assert.deepEqual(groups.map((g) => g.id), ['EU', 'ME', 'NA', 'BR', 'ASIA', 'OCE']);
  assert.deepEqual(groups[0].items.map((i) => i.id), ['de', 'fr', 'gb']);
  // ohne Ergebnisse: Reihenfolge der Liste
  assert.deepEqual(v.groupResults(logic.catalog(), []).map((g) => g.id), ['EU', 'NA', 'ME', 'BR', 'ASIA', 'OCE']);
});

test('Anzeige: Empfehlung nennt Region und Unterregion, bei NA auch Competitive', async () => {
  const v = await import(VIEW);
  const cat = logic.catalog();
  const results = Object.entries(BASE).map(([id, ms]) => ({ id, name: logic.TARGET_BY_ID.get(id).name, medianMs: ms, lossPct: 0 }));
  const eu = v.recommendation(cat, results, { id: 'de', name: 'Deutschland', region: 'Europa', ms: 17 });
  assert.equal(eu.text, 'Stelle in Fortnite unter Einstellungen > Spiel > Sprache und Region: Matchmaking-Region Europa, Unterregion Deutschland.');
  assert.equal(eu.competitive, null);
  assert.equal(eu.alt, null);
  const na = v.recommendation(cat, results.map((r) => ({ ...r, medianMs: { va: 12, oh: 20, tx: 38, ncal: 70, or: 74 }[r.id] ?? 200 })), { id: 'va', name: 'Virginia', region: 'Nordamerika', ms: 12 });
  assert.match(na.text, /Matchmaking-Region Nordamerika \(NA\), Unterregion Virginia\./);
  assert.match(na.competitive, /NA-West und NA-Central/);
  assert.match(na.competitive, /NA-Central \(Texas/);
  const oce = v.recommendation(cat, results, { id: 'syd', name: 'Sydney', region: 'Ozeanien', ms: 20 });
  assert.equal(oce.text, 'Stelle in Fortnite unter Einstellungen > Spiel > Sprache und Region: Matchmaking-Region Ozeanien.');
  const close = v.recommendation(cat, [{ id: 'de', name: 'Deutschland', medianMs: 17, lossPct: 0 }, { id: 'fr', name: 'Frankreich', medianMs: 19, lossPct: 0 }], { id: 'de', name: 'Deutschland', ms: 17 });
  assert.match(close.alt, /Frankreich/);
  assert.equal(v.recommendation(cat, results, null), null);
});

test('Anzeige: Verlauf und Vergleich mit der letzten Messung', async () => {
  const v = await import(VIEW);
  const h = [
    { at: 1, best: { id: 'de', name: 'Deutschland', ms: 25 }, results: [{ id: 'de', medianMs: 25 }] },
    { at: 2, best: { id: 'de', name: 'Deutschland', ms: 18 }, results: [{ id: 'de', medianMs: 18 }] },
  ];
  assert.equal(v.historyRows(h)[0].at, 2);
  assert.equal(v.trend(h).type, 'ok');
  assert.match(v.trend(h).text, /7 ms schneller/);
  assert.equal(v.trend([h[0]]), null);
  assert.equal(v.methodLabel('mixed'), 'Ping und TCP');
});

test('TCP-Verbindungszeit: echte Messung nur gegen den eigenen PC (127.0.0.1)', async () => {
  const net = require('node:net');
  const server = net.createServer((s) => s.destroy());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const ms = await ping._test.tcpConnect('127.0.0.1', port, 1000);
  assert.equal(typeof ms, 'number');
  assert.ok(ms >= 0 && ms < 1000, String(ms));
  await new Promise((r) => server.close(r));
  assert.equal(await ping._test.tcpConnect('127.0.0.1', port, 500), null, 'geschlossener Port -> keine Antwort');
});

test('Automatisch: scheitert der Ping ganz (z. B. PowerShell gesperrt), misst TCP alles', async () => {
  const tcp = fakeTcp();
  const broken = async () => { const e = new Error('gesperrt'); e.code = 'PING_FAILED'; throw e; };
  const rep = await logic.measureAll({ method: 'auto', samples: 3, canIcmp: true, icmp: broken, tcpDeps: tcp, gapMs: 0 });
  assert.equal(rep.method, 'tcp');
  assert.equal(rep.results.find((r) => r.id === 'de').method, 'tcp');
  assert.equal(rep.best.id, 'de');
  await assert.rejects(logic.measureAll({ method: 'icmp', samples: 3, canIcmp: true, icmp: broken, tcpDeps: tcp }), (e) => e.code === 'PING_FAILED');
});
