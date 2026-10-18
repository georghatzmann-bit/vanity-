'use strict';
// Ping-Tester: misst die Antwortzeit zu allen Fortnite-Regionen und zeigt den besten Server.
// Methode 1 (Windows): Ping (ICMP) über PowerShell System.Net.NetworkInformation.Ping – sprachneutral.
// Methode 2 (Ausweg, jedes System): Dauer des TCP-Verbindungsaufbaus (Port 443) mit Node.
// Es werden nur Antwortzeiten gemessen – keine Daten gesendet, nichts am Spiel oder an Fortnites UDP-Test nachgeahmt.

const net = require('node:net');
const dns = require('node:dns').promises;
const { HelixError } = require('../../sys/exec');
const logic = require('../../tools/ping-logic');

const ID = 'ping';
const STATE = 'tool-ping';

let current = null; // laufende Messung: { signal, kill }

function isWindows(ctx) {
  return ctx.exec && typeof ctx.exec.IS_WIN === 'boolean' ? ctx.exec.IS_WIN : process.platform === 'win32';
}

// ---------- ICMP über PowerShell ----------

/** PowerShell-Skript: pingt die Ziele rundenweise, je Runde in Gruppen parallel, eine JSON-Zeile pro Antwort. */
function icmpScript(targets, { samples, timeoutMs, batch }) {
  const cfg = {
    samples, timeout: timeoutMs, batch,
    targets: targets.filter((t) => logic.HOST_RE.test(t.host)).map((t) => ({ id: t.id, host: t.host })),
  };
  const b64 = Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64');
  return String.raw`
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | ConvertFrom-Json
$targets = @($cfg.targets)
$n = [int]$cfg.samples; $to = [int]$cfg.timeout; $bs = [int]$cfg.batch
$ok = @{}
foreach ($t in $targets) { $ok[[string]$t.id] = 0 }
function Out-Line($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
for ($r = 0; $r -lt $n; $r++) {
  if ($r -eq 3) {
    foreach ($t in $targets) { if ($ok[[string]$t.id] -eq 0) { Out-Line @{ type = 'skip'; id = [string]$t.id; count = ($n - 3) } } }
  }
  $active = @($targets | Where-Object { -not ($r -ge 3 -and $ok[[string]$_.id] -eq 0) })
  for ($b = 0; $b -lt $active.Count; $b += $bs) {
    $chunk = @($active[$b..([Math]::Min($b + $bs, $active.Count) - 1)])
    $jobs = @(foreach ($t in $chunk) {
      $p = New-Object System.Net.NetworkInformation.Ping
      $task = $null
      try { $task = $p.SendPingAsync([string]$t.host, $to) } catch { $task = $null }
      [pscustomobject]@{ id = [string]$t.id; p = $p; task = $task }
    })
    foreach ($j in $jobs) {
      $ms = $null; $st = 'Error'
      if ($j.task) {
        try {
          $rep = $j.task.GetAwaiter().GetResult()
          $st = [string]$rep.Status
          if ($rep.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) { $ms = [double]$rep.RoundtripTime; $ok[$j.id]++ }
        } catch { $st = 'NoHost' }
      }
      $j.p.Dispose()
      Out-Line @{ type = 'sample'; id = $j.id; round = $r; ms = $ms; status = $st }
    }
  }
  Start-Sleep -Milliseconds 120
}
Out-Line @{ type = 'done' }
`;
}

/** Startet den PowerShell-Ping als Datenstrom und sammelt die Werte. */
function icmpRunner(ctx) {
  return (targets, opts, onSample, signal) => new Promise((resolve, reject) => {
    const map = {};
    for (const t of targets) map[t.id] = [];
    let finished = false;
    let kill = () => {};
    let watchdog = null;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      try { kill(); } catch { /* schon beendet */ }
      if (err && !Object.values(map).some((v) => v.length)) reject(err);
      else resolve(map);
    };
    const onObj = (raw) => {
      const line = logic.parseIcmpLine(raw);
      if (!line) return;
      if (line.type === 'done') { finish(); return; }
      if (!map[line.id]) return;
      if (line.type === 'skip') {
        for (let i = 0; i < line.count; i++) map[line.id].push(null);
        onSample(line.id, null, { skipped: line.count });
      } else {
        map[line.id].push(line.ms);
        onSample(line.id, line.ms, {});
      }
    };
    try {
      kill = ctx.exec.powershellStream(icmpScript(targets, opts), onObj, (code) => {
        finish(code === 0 ? null : new HelixError('PING_FAILED', 'Windows konnte den Ping nicht ausführen.'));
      });
    } catch (e) {
      finish(e);
      return;
    }
    if (signal) signal.kill = () => finish();
    const rounds = Math.ceil(targets.length / Math.max(1, opts.batch));
    watchdog = setTimeout(() => finish(new HelixError('PING_TIMEOUT', 'Der Ping hat zu lange gebraucht.')), opts.samples * rounds * (opts.timeoutMs + 400) + 20000);
  });
}

// ---------- TCP mit Node ----------

/** Dauer des TCP-Verbindungsaufbaus in ms (ein Hin und Zurück), null bei Fehler/Zeitüberschreitung. */
function tcpConnect(address, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const end = (v) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs);
    const t0 = process.hrtime.bigint();
    s.once('connect', () => end(Number(process.hrtime.bigint() - t0) / 1e6));
    s.once('timeout', () => end(null));
    s.once('error', () => end(null));
    s.connect(port, address);
  });
}

const defaultTcpDeps = { lookup: (host, o) => dns.lookup(host, o), connect: tcpConnect };
let deps = { icmp: null, tcp: null }; // für Tests austauschbar

// ---------- Zustand ----------

async function readState(ctx) {
  const st = await ctx.core.readState(STATE, {}).catch(() => ({}));
  return st && typeof st === 'object' ? st : {};
}

function publicSettings(st) {
  const s = st.settings || {};
  return { method: logic.normMethod(s.method), samples: logic.clampSamples(s.samples ?? logic.LIMITS.defaultSamples) };
}

module.exports = {
  id: ID,
  dispose() {
    if (current?.signal) {
      current.signal.cancelled = true;
      try { current.signal.kill?.(); } catch { /* egal */ }
    }
  },
  handlers: {
    async summary(_a, ctx) {
      return { text: logic.summaryText(await readState(ctx)) };
    },

    /** Server-Liste, Einstellungen, letzte Messung und Verlauf. */
    async info(_a, ctx) {
      const st = await readState(ctx);
      const history = Array.isArray(st.history) ? st.history.slice(-logic.HISTORY_MAX) : [];
      return {
        platform: { icmp: isWindows(ctx), tcp: true },
        regions: logic.catalog(),
        settings: publicSettings(st),
        last: st.last || null,
        history,
        running: !!current,
      };
    },

    /** Misst alle Regionen. Fortschritt kommt als Ereignis "ping.progress", das Ergebnis zusätzlich als "ping.done". */
    async measure(a, ctx) {
      if (current) throw new HelixError('BUSY', 'Es läuft schon eine Messung. Bitte kurz warten.');
      const method = logic.normMethod(a.method);
      const samples = logic.clampSamples(a.samples ?? logic.LIMITS.defaultSamples);
      const canIcmp = isWindows(ctx);
      if (method === 'icmp' && !canIcmp) {
        throw new HelixError('NOT_WINDOWS', 'Ping (ICMP) misst HELIX nur unter Windows. Wähle „Automatisch“ oder „TCP-Verbindung“.');
      }
      const signal = { cancelled: false, kill: null };
      current = { signal };
      try {
        const rep = await logic.measureAll({
          method, samples, canIcmp, signal,
          icmp: deps.icmp || icmpRunner(ctx),
          tcpDeps: deps.tcp || defaultTcpDeps,
          gapMs: deps.gapMs,
          onProgress: (p) => ctx.emit?.('ping.progress', p),
        });
        if (!rep.cancelled) {
          try {
            let st = await readState(ctx);
            st = logic.appendHistory(st, rep);
            st.settings = { method, samples };
            st.last = rep;
            st.lastProxyAt = rep.proxy.suspect ? rep.at : null;
            await ctx.core.writeState(STATE, st);
          } catch (e) {
            ctx.log?.('warn', 'ping: Verlauf nicht gespeichert', e && e.message);
          }
        }
        ctx.emit?.('ping.done', rep);
        return rep;
      } finally {
        current = null;
      }
    },

    /** Bricht eine laufende Messung ab. */
    async cancel() {
      if (!current) return { cancelled: false };
      current.signal.cancelled = true;
      try { current.signal.kill?.(); } catch { /* egal */ }
      return { cancelled: true };
    },

    async clearHistory(_a, ctx) {
      const st = await readState(ctx);
      st.history = [];
      st.last = null;
      st.lastProxyAt = null;
      await ctx.core.writeState(STATE, st);
      return { cleared: true };
    },
  },
  _test: {
    icmpScript,
    icmpRunner,
    tcpConnect,
    setDeps(d) { deps = { icmp: null, tcp: null, ...d }; },
    reset() { deps = { icmp: null, tcp: null }; current = null; },
  },
};
