'use strict';
// Tiny file logger: userData/logs/phoenix-YYYYMMDD.log (+ in-memory ring buffer).
const fs = require('fs');
const path = require('path');

const RING_MAX = 3000;
const ring = [];
let file = null;
let prefix = 'ui';

function stamp() {
  return new Date().toISOString();
}

function init(name = 'ui') {
  prefix = name;
  try {
    const { app } = require('electron');
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    file = path.join(dir, `phoenix-${day}.log`);
  } catch {
    file = null;
  }
}

function fmt(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function write(level, args) {
  const line = `${stamp()} [${prefix}] ${level} ${fmt(args)}`;
  ring.push(line);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  if (file) {
    try {
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch {
      /* logging must never crash the app */
    }
  }
}

const info = (...a) => write('INFO', a);
const warn = (...a) => write('WARN', a);
const error = (...a) => write('ERROR', a);

function recent(n = 500) {
  return ring.slice(-n);
}

/** Copies the current log (or the ring buffer) to the Desktop. Returns { path }. */
function exportLog() {
  const { app } = require('electron');
  const day = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2');
  const target = path.join(app.getPath('desktop'), `Phoenix-Log-${day}.txt`);
  let body = ring.join('\r\n');
  if (file && fs.existsSync(file)) {
    try {
      body = fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n');
    } catch {
      /* fall back to ring buffer */
    }
  }
  fs.writeFileSync(target, body, 'utf8');
  return { path: target };
}

module.exports = { init, info, warn, error, recent, exportLog, get file() { return file; } };
