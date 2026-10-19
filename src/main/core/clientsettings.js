'use strict';
// Liest Tastenbelegung, Sensi und Zahlenwerte aus der lokalen Kopie von ClientSettings.Sav.
// Nur lesen – geschrieben wird hier nichts. Das Format ist nicht offiziell beschrieben,
// deshalb arbeitet der Leser vorsichtig: Er sucht Text-Einträge (Name, Typ, Wert) und
// gibt lieber "nicht lesbar" zurück als falsche Werte.

const zlib = require('node:zlib');

const MAX_INFLATE = 64 * 1024 * 1024;

/** Entpackt die Datei (Fortnite: "ECFD"-Kopf + zlib). Unbekannt -> Rohdaten. */
function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return Buffer.alloc(0);
  const tryInflate = (at) => {
    try { return zlib.inflateSync(buf.subarray(at), { maxOutputLength: MAX_INFLATE }); } catch { return null; }
  };
  if (buf.toString('latin1', 0, 4) === 'ECFD') {
    const out = tryInflate(0x10);
    if (out) return out;
  }
  // zlib-Kopf in den ersten Bytes suchen (78 01 / 78 5E / 78 9C / 78 DA)
  for (let i = 0; i < Math.min(64, buf.length - 2); i++) {
    if (buf[i] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(buf[i + 1])) {
      const out = tryInflate(i);
      if (out && out.length > 16) return out;
    }
  }
  return buf;
}

/** Alle lesbaren FStrings (int32 Länge inkl. Null + ASCII) in Reihenfolge. */
function tokens(data) {
  const out = [];
  let i = 0;
  const end = data.length - 5;
  while (i < end) {
    const len = data.readInt32LE(i);
    if (len >= 2 && len <= 512 && i + 4 + len <= data.length && data[i + 4 + len - 1] === 0) {
      let ok = true;
      for (let k = i + 4; k < i + 4 + len - 1; k++) {
        const c = data[k];
        if (c < 0x20 || c > 0x7e) { ok = false; break; }
      }
      if (ok) {
        out.push({ text: data.toString('latin1', i + 4, i + 4 + len - 1), start: i, end: i + 4 + len });
        i += 4 + len;
        continue;
      }
    }
    i++;
  }
  return out;
}

const NUM_TYPES = new Set(['FloatProperty', 'DoubleProperty', 'IntProperty']);
const NAME_TYPES = new Set(['NameProperty', 'StrProperty', 'EnumProperty', 'ByteProperty']);
const ACTION_PROPS = /^(ActionName|MappingName|InputActionName|PlayerMappableName)$/;

// Werte mit bekannter Bedeutung. pct: im Spiel als Prozent angezeigt.
const KNOWN = {
  MouseSensitivityX: { label: 'Maus-Sensi X', pct: true, group: 'sens' },
  MouseSensitivityY: { label: 'Maus-Sensi Y', pct: true, group: 'sens' },
  MouseSensitivity: { label: 'Maus-Sensi', pct: true, group: 'sens' },
  TargetingMultiplier: { label: 'Sensi beim Zielen', pct: true, group: 'sens' },
  ScopedMultiplier: { label: 'Sensi mit Zielfernrohr', pct: true, group: 'sens' },
  MouseSensitivityBuildMode: { label: 'Sensi im Baumodus', pct: true, group: 'sens' },
  MouseSensitivityEditMode: { label: 'Sensi im Bearbeitungsmodus', pct: true, group: 'sens' },
  HUDScale: { label: 'HUD-Größe', pct: true, group: 'game' },
  ColorBlindMode: { label: 'Farbenblind-Modus', group: 'game' },
  ColorBlindStrength: { label: 'Farbenblind-Stärke', group: 'game' },
  MasterVolume: { label: 'Gesamtlautstärke', pct: true, group: 'game' },
  MusicVolume: { label: 'Musiklautstärke', pct: true, group: 'game' },
  SoundFXVolume: { label: 'Effektlautstärke', pct: true, group: 'game' },
  DialogVolume: { label: 'Dialoglautstärke', pct: true, group: 'game' },
  VoiceChatVolume: { label: 'Sprachchat-Lautstärke', pct: true, group: 'game' },
  CinematicsVolume: { label: 'Filmsequenz-Lautstärke', pct: true, group: 'game' },
};

/**
 * Liest die Datei aus.
 * @returns {{ok:boolean, numbers:Object<string,number>, binds:Array<{action:string, keys:string[]}>}}
 */
function extract(buf) {
  const data = decode(buf);
  const toks = tokens(data);
  const numbers = {};
  const seen = {};
  const binds = new Map();
  let action = null;
  for (let t = 0; t < toks.length; t++) {
    const tk = toks[t];
    const next = toks[t + 1];
    // Zahlen: Name, Typ, danach 9 Byte (Größe/Index/Flags), dann der Wert
    if (next && NUM_TYPES.has(next.text) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tk.text)) {
      const at = next.end + 9;
      let v = null;
      if (next.text === 'FloatProperty' && at + 4 <= data.length) v = data.readFloatLE(at);
      else if (next.text === 'DoubleProperty' && at + 8 <= data.length) v = data.readDoubleLE(at);
      else if (next.text === 'IntProperty' && at + 4 <= data.length) v = data.readInt32LE(at);
      if (v !== null && Number.isFinite(v) && Math.abs(v) < 1e7) {
        seen[tk.text] = (seen[tk.text] || 0) + 1;
        if (seen[tk.text] === 1) numbers[tk.text] = Math.round(v * 1e6) / 1e6;
      }
      t++;
      continue;
    }
    // Aktion: "ActionName" NameProperty <Wert>
    if (ACTION_PROPS.test(tk.text) && next && NAME_TYPES.has(next.text)) {
      const val = toks.slice(t + 2, t + 5).find((x) => x.start >= next.end && !NAME_TYPES.has(x.text) && x.text !== 'None' && !/^E[A-Z]\w+$/.test(x.text));
      if (val) {
        action = val.text;
        if (!binds.has(action)) binds.set(action, []);
        t = toks.indexOf(val);
        continue;
      }
    }
    if (action && KEYS.has(tk.text)) {
      const list = binds.get(action);
      if (!list.includes(tk.text)) list.push(tk.text);
    }
  }
  // Mehrfach vorkommende Namen sind mehrdeutig (z. B. in Listen) -> weglassen
  for (const k of Object.keys(numbers)) if (seen[k] > 1 && !KNOWN[k]) delete numbers[k];
  const bindList = [...binds.entries()].map(([a, keys]) => ({ action: a, keys }));
  const ok = bindList.some((b) => b.keys.length) || Object.keys(numbers).some((k) => KNOWN[k]?.group === 'sens');
  return { ok, numbers, binds: bindList };
}

// ---------- Anzeige ----------

const KEY_LABELS = {
  LeftMouseButton: 'Linke Maustaste', RightMouseButton: 'Rechte Maustaste', MiddleMouseButton: 'Mittlere Maustaste',
  ThumbMouseButton: 'Maustaste 4', ThumbMouseButton2: 'Maustaste 5',
  MouseScrollUp: 'Mausrad hoch', MouseScrollDown: 'Mausrad runter', MouseWheelAxis: 'Mausrad',
  SpaceBar: 'Leertaste', LeftShift: 'Shift links', RightShift: 'Shift rechts', LeftControl: 'Strg links',
  RightControl: 'Strg rechts', LeftAlt: 'Alt links', RightAlt: 'Alt Gr', Tab: 'Tab', CapsLock: 'Feststelltaste',
  Enter: 'Enter', Escape: 'Esc', BackSpace: 'Rücktaste', Delete: 'Entf', Insert: 'Einfg', Home: 'Pos1', End: 'Ende',
  PageUp: 'Bild hoch', PageDown: 'Bild runter', Up: 'Pfeil hoch', Down: 'Pfeil runter', Left: 'Pfeil links', Right: 'Pfeil rechts',
  Zero: '0', One: '1', Two: '2', Three: '3', Four: '4', Five: '5', Six: '6', Seven: '7', Eight: '8', Nine: '9',
  Tilde: '^', Hyphen: 'ß', Equals: '´', LeftBracket: 'Ü', RightBracket: '+', Backslash: '#', Semicolon: 'Ö',
  Apostrophe: 'Ä', Comma: ',', Period: '.', Slash: '-',
  Ae: 'Ä', Oe: 'Ö', Ue: 'Ü', Section: '§',
  Multiply: 'Num *', Add: 'Num +', Subtract: 'Num -', Decimal: 'Num ,', Divide: 'Num /',
  Pause: 'Pause', ScrollLock: 'Rollen', NumLock: 'Num',
};
const NUM_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const KEYS = new Set([
  ...Object.keys(KEY_LABELS),
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...NUM_WORDS.map((w) => `NumPad${w}`),
]);

function keyLabel(k) {
  if (KEY_LABELS[k]) return KEY_LABELS[k];
  const np = /^NumPad(\w+)$/.exec(k);
  if (np) return `Num ${NUM_WORDS.indexOf(np[1])}`;
  return k;
}

const WORDS = {
  Wall: 'Wand', Floor: 'Boden', Stair: 'Treppe', Stairs: 'Treppe', Roof: 'Dach', Cone: 'Dach', Trap: 'Falle',
  Edit: 'Bearbeiten', Jump: 'Springen', Crouch: 'Ducken', Reload: 'Nachladen', Fire: 'Schießen', Shoot: 'Schießen',
  Targeting: 'Zielen', Aim: 'Zielen', Harvest: 'Spitzhacke', Harvesting: 'Spitzhacke', Pickaxe: 'Spitzhacke', Tool: 'Werkzeug',
  Interact: 'Benutzen', Use: 'Benutzen', Map: 'Karte', Inventory: 'Inventar', Sprint: 'Sprinten', Repair: 'Reparieren',
  Rotate: 'Drehen', Reset: 'Zurücksetzen', Confirm: 'Bestätigen', Select: 'Auswählen', Slot: 'Platz', Weapon: 'Waffe',
  Build: 'Bauen', Building: 'Bauen', Combat: 'Kampf', Mode: 'Modus', Forward: 'Vorwärts', Backward: 'Rückwärts',
  Move: 'Bewegen', Left: 'links', Right: 'rechts', Up: 'hoch', Down: 'runter', Next: 'nächste', Previous: 'vorherige',
  Prev: 'vorherige', Toggle: 'umschalten', Quick: 'Schnell', Bar: 'leiste', Emote: 'Emote', Ping: 'Markieren',
  Place: 'Setzen', Marker: 'Markierung', Push: 'Drücken', To: '', Talk: 'Sprechen', Chat: 'Chat', Crafting: 'Herstellen',
  Consumable: 'Verbrauchsgegenstand', Squad: 'Team', Auto: 'Auto', Run: 'Laufen', Walk: 'Gehen', Turn: 'Drehen',
  Look: 'Umsehen', Swap: 'Wechseln', Switch: 'Wechseln', Scoreboard: 'Punktetafel', Menu: 'Menü', Game: 'Spiel', Mute: 'Stumm',
};

function actionLabel(a) {
  const raw = String(a).replace(/^(IA_|IMC_|Fort|Athena)/, '').replace(/[_.]+/g, ' ');
  const words = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/\s+/).filter(Boolean);
  const out = words.map((w) => (w in WORDS ? WORDS[w] : w)).filter(Boolean).join(' ').trim();
  return out ? out[0].toUpperCase() + out.slice(1) : String(a);
}

function fmtNumber(name, v) {
  if (v === undefined || v === null) return '–';
  const k = KNOWN[name];
  if (k?.pct) return `${(Math.round(v * 1000) / 10).toLocaleString('de-DE')} %`;
  return (Math.round(v * 1000) / 1000).toLocaleString('de-DE');
}

/** Lesbare Form für die Oberfläche. */
function view(x) {
  if (!x?.ok) return { ok: false, sens: [], binds: [], other: [] };
  const sens = [];
  const other = [];
  for (const [name, v] of Object.entries(x.numbers)) {
    const row = { name, label: KNOWN[name]?.label || name, value: fmtNumber(name, v) };
    if (KNOWN[name]?.group === 'sens' || (!KNOWN[name] && /Sensitivity|Multiplier/.test(name))) sens.push(row);
    else other.push(row);
  }
  const binds = x.binds.filter((b) => b.keys.length).map((b) => ({ action: b.action, label: actionLabel(b.action), keys: b.keys.map(keyLabel) }));
  binds.sort((a, b) => a.label.localeCompare(b.label, 'de'));
  return { ok: true, sens, binds, other };
}

/** Unterschiede: was im Spiel geändert werden muss, damit es zum Profil passt. */
function diff(current, wanted) {
  if (!current?.ok || !wanted?.ok) return null;
  const sens = [];
  const other = [];
  for (const name of Object.keys(wanted.numbers)) {
    const a = current.numbers[name];
    const b = wanted.numbers[name];
    if (a === undefined || Math.abs(a - b) < 1e-4) continue;
    const row = { name, label: KNOWN[name]?.label || name, from: fmtNumber(name, a), to: fmtNumber(name, b) };
    if (KNOWN[name]?.group === 'sens' || (!KNOWN[name] && /Sensitivity|Multiplier/.test(name))) sens.push(row);
    else other.push(row);
  }
  const cur = new Map(current.binds.map((b) => [b.action, b.keys]));
  const binds = [];
  for (const b of wanted.binds) {
    const before = cur.get(b.action);
    if (!before) continue;
    const same = before.length === b.keys.length && before.every((k) => b.keys.includes(k));
    if (!same) binds.push({ action: b.action, label: actionLabel(b.action), from: before.map(keyLabel), to: b.keys.map(keyLabel) });
  }
  binds.sort((a, b) => a.label.localeCompare(b.label, 'de'));
  return { sens, binds, other, count: sens.length + binds.length + other.length };
}

module.exports = { decode, tokens, extract, view, diff, keyLabel, actionLabel };
