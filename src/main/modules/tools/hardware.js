'use strict';
// Hardware-Überblick: Temperaturen, Auslastung und Arbeitsspeicher live – nur lesend, kein Overlay.
//
// Ein einziges, dauerhaft laufendes PowerShell-Skript liefert alle 2 Sekunden eine JSON-Zeile mit
// sprachneutralen CIM-Leistungsdaten (funktioniert auch auf deutschem Windows), nvidia-smi und den
// Prozess-Werten von Fortnite (wie im Task-Manager). Das Spiel selbst wird nie berührt:
// kein Speicherlesen, keine Priorität, keine Änderung am Prozess.
// Prozessor und Arbeitsspeicher kommen zusätzlich aus Node (os) – das geht auf jedem System.
//
// Die Messung läuft nur, solange die Ansicht offen ist – oder (wenn eingeschaltet) solange Fortnite läuft.

const os = require('node:os');
const logic = require('../../tools/hardware-logic');

const ID = 'hardware';
const STATE = 'tool-hardware';
const INTERVAL_MS = 2000;
const VIEW_TIMEOUT_MS = 90000; // Ansicht meldet sich alle 30 s; danach gilt sie als geschlossen
const MAX_RESTARTS = 3;
const PERSIST_EVERY_MS = 60000;

// Nur lesende Abfragen: Get-CimInstance, Get-ItemProperty, Get-Process (Statistik), nvidia-smi.
// Endet von selbst, wenn HELIX nicht mehr läuft (Ausgabe geschlossen oder Elternprozess weg).
const PS_SAMPLER = String.raw`
$parentId = $null
try { $parentId = [int](Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop).ParentProcessId } catch { }
$nv = $null
try { $c = Get-Command -Name 'nvidia-smi.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1; if ($c) { $nv = [string]$c.Source } } catch { }
if (-not $nv) {
  foreach ($p in @((Join-Path ([string]$env:ProgramFiles) 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'), (Join-Path ([string]$env:SystemRoot) 'System32\nvidia-smi.exe'))) {
    if ($p -and (Test-Path -LiteralPath $p)) { $nv = $p; break }
  }
}
$gpuNames = @()
try { $gpuNames = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop | ForEach-Object { [string]$_.Name }) } catch { }
$vt = @()
try {
  $cls = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
  foreach ($k in @(Get-ChildItem -Path $cls -ErrorAction SilentlyContinue)) {
    if ($k.PSChildName -notmatch '^\d{4}$') { continue }
    try {
      $pr = Get-ItemProperty -Path $k.PSPath -ErrorAction Stop
      $q = $pr.'HardwareInformation.qwMemorySize'
      if ($q -is [byte[]]) { $b = New-Object byte[] 8; [Array]::Copy($q, $b, [Math]::Min(8, $q.Length)); $q = [BitConverter]::ToUInt64($b, 0) }
      if ($q) { $vt += [double]$q }
    } catch { }
  }
} catch { }
$tick = 0
while ($true) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $o = [ordered]@{ v = 1; tick = $tick; nvp = [bool]$nv; gpus = $gpuNames; vt = $vt }
  try { $o.cpu = [double](Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop).PercentProcessorTime } catch { $o.cpu = $null }
  try { $o.eng = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop | Where-Object { $_.Name -like '*engtype_3D' -and $_.UtilizationPercentage -gt 0 } | ForEach-Object { [pscustomobject]@{ n = [string]$_.Name; u = [double]$_.UtilizationPercentage } }) } catch { $o.eng = $null }
  try { $o.mem = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ n = [string]$_.Name; d = [double]$_.DedicatedUsage } }) } catch { $o.mem = $null }
  try { $o.tz = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ n = [string]$_.Name; hp = [double]$_.HighPrecisionTemperature; t = [double]$_.Temperature } }) } catch { $o.tz = $null }
  if ($nv) {
    try { $o.nv = @(& $nv '--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,clocks.gr' '--format=csv,noheader,nounits' 2>$null | ForEach-Object { [string]$_ }) } catch { $o.nv = $null }
  }
  $o.fn = $null
  try {
    $fp = @(Get-Process -Name 'FortniteClient-Win64-Shipping' -ErrorAction SilentlyContinue)
    if ($fp.Count -gt 0) {
      $ws = 0.0; $cs = 0.0
      foreach ($p in $fp) {
        $ws += [double]$p.WorkingSet64
        try { $cs += [double]$p.TotalProcessorTime.TotalSeconds } catch { $cs = -1.0 }
      }
      $o.fn = [pscustomobject]@{ ws = $ws; cpu = $cs; n = $fp.Count }
    }
  } catch { $o.fn = $null }
  try { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() } catch { exit }
  if ($parentId -and -not (Get-Process -Id $parentId -ErrorAction SilentlyContinue)) { exit }
  $tick++
  $rest = 2000 - [int]$sw.ElapsedMilliseconds
  if ($rest -lt 200) { $rest = 200 }
  Start-Sleep -Milliseconds $rest
}
`;

function isWindows(ctx) {
  return ctx.exec && typeof ctx.exec.IS_WIN === 'boolean' ? ctx.exec.IS_WIN : process.platform === 'win32';
}

const DEFAULT_STATE = () => ({ settings: { background: false }, sessions: [], current: null, last: null });

class HardwareMonitor {
  /**
   * @param {object} ctx  HELIX-Kontext (exec, core, emit, log)
   * @param {object} [deps] für Tests: { os, now, setInterval, clearInterval, setTimeout, isWin, intervalMs }
   */
  constructor(ctx, deps = {}) {
    this.ctx = ctx;
    this.os = deps.os || os;
    this.now = deps.now || Date.now;
    this.setIntervalFn = deps.setInterval || setInterval;
    this.clearIntervalFn = deps.clearInterval || clearInterval;
    this.setTimeoutFn = deps.setTimeout || setTimeout;
    this.isWin = typeof deps.isWin === 'boolean' ? deps.isWin : isWindows(ctx);
    this.intervalMs = deps.intervalMs || INTERVAL_MS;
    this.consumers = new Set();
    this.history = [];
    this.timer = null;
    this.kill = null;
    this.stream = this.isWin ? 'off' : 'unsupported';
    this.restarts = 0;
    this.lastPs = null;
    this.lastPsAt = 0;
    this.buildState = {};
    this.caps = { windows: this.isWin, nvidiaSmi: null, vendor: null, gpuNames: [], gpuLoad: null, gpuMemory: null, thermal: null };
    this.viewSeenAt = 0;
    this.session = null;
    this.state = null; // geladener Zustand (tool-hardware)
    this.queue = Promise.resolve();
    this.lastPersist = 0;
    this.disposed = false;
  }

  // ---------- Zustand ----------

  async load() {
    if (this.state) return this.state;
    const st = await this.ctx.core.readState(STATE, DEFAULT_STATE()).catch(() => DEFAULT_STATE());
    this.state = { ...DEFAULT_STATE(), ...(st || {}) };
    this.state.settings = { background: false, ...(this.state.settings || {}) };
    if (!Array.isArray(this.state.sessions)) this.state.sessions = [];
    return this.state;
  }

  /** Schreibzugriffe nacheinander, damit sich nichts überschneidet. */
  save(mutate) {
    const run = this.queue.then(async () => {
      const st = await this.load();
      if (mutate) mutate(st);
      await this.ctx.core.writeState(STATE, st);
      return st;
    });
    this.queue = run.catch((e) => this.ctx.log?.('warn', 'hardware: Zustand nicht gespeichert', e && e.message));
    return run;
  }

  // ---------- Messung starten / stoppen ----------

  acquire(who) {
    if (this.disposed) return;
    this.consumers.add(who);
    if (who === 'view') this.viewSeenAt = this.now();
    this.ensureRunning();
  }

  release(who) {
    this.consumers.delete(who);
    if (!this.consumers.size) this.halt();
  }

  ensureRunning() {
    if (this.timer) {
      // Skript war ausgefallen: beim nächsten Start (z. B. "Erneut versuchen") neu probieren
      if (this.isWin && !this.kill && this.stream === 'failed') { this.restarts = 0; this.startStream(); }
      return;
    }
    // Neuer Start: alte Werte von früher nicht als "live" oder "letzte 2 Minuten" zeigen
    this.history = [];
    this.lastPs = null;
    this.lastPsAt = 0;
    this.buildState = {};
    this.buildState.prevCpu = logic.cpuTimes(this.safeCpus());
    this.timer = this.setIntervalFn(() => this.onTimer(), this.intervalMs);
    if (this.isWin) this.startStream();
  }

  halt() {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
    this.stopStream();
    if (this.isWin) this.stream = 'off';
    this.restarts = 0;
    this.persistLast();
  }

  startStream() {
    if (this.kill || !this.isWin) return;
    this.stream = 'starting';
    let killedByUs = false;
    let stop = null;
    const wrapped = () => { killedByUs = true; try { if (stop) stop(); } catch { /* schon beendet */ } };
    this.kill = wrapped;
    try {
      stop = this.ctx.exec.powershellStream(PS_SAMPLER, (obj) => { if (this.kill === wrapped) this.onPs(obj); }, () => {
        if (killedByUs || this.kill !== wrapped) return;
        this.kill = null;
        this.onStreamExit();
      });
    } catch (e) {
      this.kill = null;
      this.stream = e && e.code === 'NOT_WINDOWS' ? 'unsupported' : 'failed';
      this.ctx.log?.('warn', 'hardware: Messung nicht gestartet', e && e.message);
    }
  }

  stopStream() {
    const k = this.kill;
    this.kill = null;
    if (k) k();
  }

  onStreamExit() {
    if (!this.timer) return;
    if (this.restarts >= MAX_RESTARTS) {
      this.stream = 'failed';
      this.ctx.log?.('warn', 'hardware: Mess-Skript mehrfach beendet, nur Grundwerte');
      return;
    }
    this.restarts += 1;
    this.stream = 'starting';
    this.setTimeoutFn(() => { if (this.timer && !this.kill) this.startStream(); }, 3000 * this.restarts);
  }

  onPs(obj) {
    if (!obj || typeof obj !== 'object' || !this.timer) return;
    this.lastPs = obj;
    this.lastPsAt = this.now();
    this.stream = 'ok';
    this.caps = { ...logic.capsFromPs(obj, this.caps), windows: true };
    this.tick();
  }

  onTimer() {
    const now = this.now();
    // Ansicht hat sich lange nicht gemeldet (z. B. Fenster neu geladen) -> als geschlossen werten
    if (this.consumers.has('view') && now - this.viewSeenAt > VIEW_TIMEOUT_MS) {
      this.release('view');
      if (!this.timer) return;
    }
    // Mit Windows-Skript: Messung kommt mit jeder Skript-Zeile. Der Zeitgeber springt nur ein, wenn sie
    // länger ausbleibt (eine langsame Zeile unter Last ist noch frisch und darf nicht verworfen werden).
    if (this.isWin && this.stream === 'ok' && logic.isFresh(this.lastPsAt, now)) return;
    this.tick();
  }

  safeCpus() {
    try { return this.os.cpus(); } catch { return []; }
  }

  tick() {
    const now = this.now();
    let node = null;
    try { node = { cpus: this.safeCpus(), totalmem: this.os.totalmem(), freemem: this.os.freemem() }; } catch { node = null; }
    const ps = this.lastPs && logic.isFresh(this.lastPsAt, now) ? this.lastPs : null;
    if (ps === this.lastPs) this.lastPs = null; // jede Skript-Zeile nur einmal verwenden
    const sample = logic.buildSample({ ps, node, now, state: this.buildState, logical: node && node.cpus ? node.cpus.length : 1 });
    sample.stream = this.stream;
    logic.pushHistory(this.history, sample);
    if (sample.gpuTemp != null) this.lastGpu = { at: now, gpuTemp: sample.gpuTemp };
    if (this.session) {
      logic.addToAggregate(this.session, sample);
      if (now - this.lastPersist > PERSIST_EVERY_MS) {
        this.lastPersist = now;
        const snap = JSON.parse(JSON.stringify(this.session));
        this.save((st) => { st.current = snap; });
      }
    }
    if (this.consumers.has('view')) {
      try { this.ctx.emit('hardware.sample', { ...sample, caps: this.caps }); } catch { /* Fenster zu */ }
    }
    return sample;
  }

  persistLast() {
    if (!this.lastGpu) return;
    const last = this.lastGpu;
    this.save((st) => { st.last = last; }).catch(() => {});
  }

  // ---------- Hintergrund-Aufzeichnung (solange Fortnite läuft) ----------

  async onFortnite(running) {
    const st = await this.load();
    if (running && st.settings.background && !this.session && !this.disposed) {
      this.session = logic.newAggregate(this.now());
      this.lastPersist = this.now();
      this.acquire('background');
    } else if (!running && this.session) {
      await this.finishSession();
      this.release('background');
    }
  }

  async finishSession() {
    const agg = this.session;
    this.session = null;
    if (!agg) return null;
    const done = logic.finishAggregate(agg, this.now());
    await this.save((st) => {
      st.current = null;
      if (done) st.sessions = logic.pushSession(st.sessions, done);
    });
    return done;
  }

  async setBackground(on) {
    await this.save((st) => { st.settings.background = !!on; });
    if (on && this.ctx.core?.fortniteState?.running) await this.onFortnite(true);
    if (!on && this.session) {
      await this.finishSession();
      this.release('background');
    }
    return this.state.settings;
  }

  /** Nach einem Absturz: halb aufgezeichnete Runde abschließen. */
  async recover() {
    const st = await this.load();
    if (!st.current) return null;
    const done = logic.finishAggregate(st.current, st.current.lastAt);
    await this.save((s) => {
      s.current = null;
      if (done) s.sessions = logic.pushSession(s.sessions, { ...done, recovered: true });
    });
    return done;
  }

  publicStatus() {
    return {
      unsupported: !this.isWin,
      windows: this.isWin,
      running: !!this.timer,
      stream: this.stream,
      intervalMs: this.intervalMs,
      caps: this.caps,
      settings: this.state ? this.state.settings : { background: false },
      recording: !!this.session,
      history: this.history.slice(),
    };
  }

  async dispose() {
    this.disposed = true;
    if (this.session) await this.finishSession().catch(() => {});
    this.consumers.clear();
    this.halt();
    await this.queue;
  }
}

let monitor = null;
function getMonitor(ctx) {
  if (!monitor) monitor = new HardwareMonitor(ctx);
  return monitor;
}

module.exports = {
  id: ID,
  async init(ctx) {
    const m = getMonitor(ctx);
    await m.load();
    await m.recover().catch(() => {});
    ctx.core.onFortniteState((running) => { m.onFortnite(running).catch(() => {}); });
    if (ctx.core.fortniteState?.running) m.onFortnite(true).catch(() => {});
  },
  async dispose() {
    if (monitor) await monitor.dispose();
    monitor = null;
  },
  handlers: {
    /** Aktueller Stand ohne die Messung zu starten. */
    async status(_a, ctx) {
      const m = getMonitor(ctx);
      await m.load();
      return m.publicStatus();
    },
    /** Ansicht geöffnet: Messung starten (alle 2 Sekunden kommt "hardware.sample"). */
    async start(_a, ctx) {
      const m = getMonitor(ctx);
      await m.load();
      m.acquire('view');
      return m.publicStatus();
    },
    /** Ansicht ist noch offen (alle 30 s). */
    async ping(_a, ctx) {
      const m = getMonitor(ctx);
      if (m.consumers.has('view')) m.viewSeenAt = m.now();
      else m.acquire('view');
      return { running: !!m.timer, stream: m.stream };
    },
    /** Ansicht geschlossen: Messung stoppen (außer die Hintergrund-Aufzeichnung läuft). */
    async stop(_a, ctx) {
      const m = getMonitor(ctx);
      m.release('view');
      return { running: !!m.timer };
    },
    async setBackground(a, ctx) {
      const m = getMonitor(ctx);
      const settings = await m.setBackground(!!a.on);
      return { settings, recording: !!m.session };
    },
    async sessions(_a, ctx) {
      const m = getMonitor(ctx);
      const st = await m.load();
      return { sessions: st.sessions.slice().reverse(), recording: !!m.session, settings: st.settings };
    },
    async clearSessions(_a, ctx) {
      const m = getMonitor(ctx);
      const st = await m.load();
      const n = st.sessions.length;
      await m.save((s) => { s.sessions = []; });
      return { cleared: n };
    },
    async summary(_a, ctx) {
      const m = getMonitor(ctx);
      const st = await m.load().catch(() => null);
      const text = logic.summaryText(m.lastGpu || (st && st.last));
      return text ? { text } : null;
    },
  },
  _test: { HardwareMonitor, PS_SAMPLER, reset: () => { monitor = null; } },
};
