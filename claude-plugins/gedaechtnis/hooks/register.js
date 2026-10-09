// Gedächtnis über Sitzungen: Zu Beginn jeder Sitzung weiß Claude, woran ihr zuletzt gearbeitet habt (in diesem
// Ordner und anderswo) und was du ihm gesagt hast ("Merk dir ..."). Fragst du später "Wie letztes Mal ...?",
// sucht das Gedächtnis die passenden Sitzungen heraus. Alles liegt im Speicher von Claude Code auf diesem PC
// ($.store), es läuft kein Hintergrunddienst und es geht nichts ins Netz.

const KEEP_DAYS = 180
const MAX_SESSIONS = 300
const MAX_NOTES = 300
const MAX_PROMPTS = 5 // so viele Anfragen je Sitzung bleiben wörtlich stehen
const CONTEXT_CHARS = 3500
const DAY = 24 * 60 * 60 * 1000

// "Wie letztes Mal", "Weißt du noch": dann sucht das Gedächtnis auch mitten in der Sitzung
const RECALL = /\b(letzte[ns]? mal|letztes mal|neulich|gestern|vorgestern|wei(ß|ss)t du noch|erinnerst du dich|wie besprochen|wo waren wir|wo sind wir stehen geblieben|wie letzte woche|wie beim letzten)\b/i
// Passwörter, Schlüssel und Zugangsdaten landen nie im Gedächtnis
const SECRET = /(passw(or)?t|password|kennwort|zugangsdaten|\btoken\b|api[-_ ]?key|secret|\bpin\b|\biban\b|kreditkarte|sk-[a-z0-9]{8}|sk_[a-z0-9]{8}|gsk_|ghp_|github_pat_|xox[bp]-|akia[0-9a-z]{8}|-----begin)/i
const STOP = new Set(('aber alle alles also auch dann dass dein deine denn diese dieser dieses doch eine einen einer '
  + 'etwas habe haben hast hier immer jetzt kann kannst machen mach mache mehr mein meine mich mir noch nicht oder schon '
  + 'sein sich sind soll sollst über unter wann warum weiß weißt welche wenn wieder wird wurde zwischen bitte danke '
  + 'letzte letzten letztes neulich gestern erinnerst besprochen woche waren stehen geblieben').split(' '))
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

let current = null // die laufende Sitzung
let primed = false // hat Claude das Gedächtnis in dieser Sitzung schon bekommen?
let fallbackId = ''

export function register(on) {
  on('session.start', async ($, e, next) => {
    current = null
    primed = false
    await prune($)
    try {
      await $.tool.register({
        name: 'merken',
        description: 'Merkt sich etwas über den Nutzer oder seine Projekte dauerhaft, auch für spätere Sitzungen ' +
          '("Merk dir, dass ich Tabs statt Leerzeichen will"). Ein kurzer Satz. Nie Passwörter oder Schlüssel.',
        inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Der Fakt in einem kurzen Satz' } }, required: ['text'] },
      })
      await $.tool.register({
        name: 'erinnern',
        description: 'Sucht im Gedächtnis: gemerkte Fakten und frühere Sitzungen (was der Nutzer wollte, was herauskam). ' +
          'Nimm es, wenn der Nutzer auf etwas Früheres anspielt, das nicht im Kontext steht.',
        inputSchema: { type: 'object', properties: { suche: { type: 'string', description: 'Stichwörter' } }, required: ['suche'] },
      })
      await $.tool.register({
        name: 'vergessen',
        description: 'Löscht gemerkte Fakten, in denen alle diese Wörter vorkommen ("Vergiss das mit dem Umzug").',
        inputSchema: { type: 'object', properties: { suche: { type: 'string', description: 'Wörter aus dem Fakt' } }, required: ['suche'] },
      })
      await $.command.register({ name: 'gedaechtnis', description: 'Zeigt, was sich Claude gemerkt hat (mit Suchwort: nur Passendes)', argumentHint: '[suche]' })
    } catch {
      // Name schon vergeben (zweites Gedächtnis-Plugin): dann ohne Befehl, das Gedächtnis selbst läuft weiter
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const text = String(e.text || '').trim()
    if (!text || text.startsWith('/')) return next(e)
    const id = await sessionId($)
    if (!current || current.id !== id) {
      current = await openSession($, id)
      primed = false // nach /clear eine neue Sitzung: das Gedächtnis noch einmal mitgeben
    }
    const extra = []
    if (!primed) {
      primed = true
      const memory = await overview($, current)
      if (memory) extra.push(memory)
    } else if (RECALL.test(text)) {
      const found = await recall($, text, current.id)
      if (found) extra.push(found)
    }
    await remember($, text)
    if (!extra.length) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...extra] })
  })

  on('turn.complete', async ($, e, next) => {
    if (current && !e.agentId && !e.isAborted) {
      const answer = clip(e.answer, 400)
      if (answer && !SECRET.test(answer)) current.zuletzt = answer
      current.ende = await $.clock.now()
      await $.store.set('s:' + current.id, current)
    }
    return next(e)
  })

  on('tool.call', { tool: 'mcp__gedaechtnis__merken' }, async ($, e) => {
    return { result: await addNote($, e.text) }
  })

  on('tool.call', { tool: 'mcp__gedaechtnis__erinnern' }, async ($, e) => {
    return { result: (await search($, e.suche, current ? current.id : '')) || 'Dazu ist nichts gespeichert.' }
  })

  on('tool.call', { tool: 'mcp__gedaechtnis__vergessen' }, async ($, e) => {
    const removed = await forget($, e.suche)
    return { result: removed ? `${removed} ${removed === 1 ? 'Eintrag' : 'Einträge'} vergessen.` : 'Dazu war nichts gemerkt.' }
  })

  on('command.run', { command: 'gedaechtnis' }, async ($, e) => {
    const query = String(e.args || '').trim()
    if (query) return { text: (await search($, query, '')) || `Zu „${query}“ ist nichts gespeichert.` }
    const notes = await loadNotes($)
    const sessions = await loadSessions($, '')
    if (!notes.length && !sessions.length) return { text: 'Noch nichts gespeichert. Sag zum Beispiel: „Merk dir, dass ich kurze Antworten mag.“' }
    const lines = []
    lines.push(notes.length ? `Gemerkt (${notes.length}):` : 'Noch nichts ausdrücklich gemerkt.')
    for (const note of notes.slice(-20)) lines.push(`- ${note.text}`)
    if (sessions.length) {
      lines.push(`Letzte Sitzungen (${sessions.length} gespeichert):`)
      for (const s of sessions.slice(0, 6)) lines.push(`- ${describe(s, true)}`)
    }
    lines.push('Löschen: „Vergiss …“. Alles liegt nur auf diesem PC.')
    return { text: lines.join('\n') }
  })
}

// ---------------------------------------------------------------------- Sitzungen

async function sessionId($) {
  try {
    const id = await $.session.id()
    if (id) return String(id)
  } catch {
    // ältere Fassung ohne Sitzungs-ID
  }
  if (!fallbackId) fallbackId = 'x' + Math.random().toString(36).slice(2, 10)
  return fallbackId
}

async function openSession($, id) {
  const saved = await $.store.get('s:' + id)
  if (saved && typeof saved === 'object') return saved // fortgesetzte Sitzung (--resume)
  let ort = ''
  try {
    ort = String((await $.session.cwd()) || '')
  } catch {
    ort = ''
  }
  const now = await $.clock.now()
  return { id, ort, start: now, ende: now, anfragen: [], zahl: 0, zuletzt: '' }
}

async function remember($, text) {
  current.zahl = (current.zahl || 0) + 1
  if (!SECRET.test(text) && text.length >= 6 && current.anfragen.length < MAX_PROMPTS) {
    current.anfragen.push(clip(text, 240))
  }
  current.ende = await $.clock.now()
  await $.store.set('s:' + current.id, current)
}

async function loadSessions($, skipId) {
  const keys = await $.store.keys()
  const found = []
  for (const key of keys || []) {
    if (!String(key).startsWith('s:') || key === 's:' + skipId) continue
    const s = await $.store.get(key)
    if (s && typeof s === 'object' && (s.anfragen || []).length) found.push(s)
  }
  return found.sort((a, b) => (b.ende || 0) - (a.ende || 0))
}

async function prune($) {
  const keys = await $.store.keys()
  const now = await $.clock.now()
  const sessions = []
  for (const key of keys || []) {
    if (!String(key).startsWith('s:')) continue
    const s = await $.store.get(key)
    if (!s || typeof s !== 'object' || now - (s.ende || 0) > KEEP_DAYS * DAY) await $.store.delete(key)
    else sessions.push([key, s.ende || 0])
  }
  sessions.sort((a, b) => b[1] - a[1])
  for (const [key] of sessions.slice(MAX_SESSIONS)) await $.store.delete(key)
}

// ---------------------------------------------------------------------- Für Claude

async function overview($, session) {
  const notes = await loadNotes($)
  const sessions = await loadSessions($, session.id)
  if (!notes.length && !sessions.length) return ''
  const here = sessions.filter((s) => same(s.ort, session.ort)).slice(0, 3)
  const elsewhere = sessions.filter((s) => !same(s.ort, session.ort)).slice(0, 2)
  const lines = ['<gedaechtnis>', 'Aus früheren Sitzungen mit dem Nutzer (Plugin Gedächtnis, nur auf diesem PC). Nutze es unaufdringlich, ohne es aufzuzählen.']
  if (notes.length) {
    lines.push('Gemerkt:')
    for (const note of notes.slice(-30)) lines.push(`- ${note.text}`)
  }
  if (here.length) {
    lines.push(`Zuletzt in diesem Ordner (${folderName(session.ort)}):`)
    for (const s of here) lines.push(`- ${describe(s, false)}`)
  }
  if (elsewhere.length) {
    lines.push('Zuletzt anderswo:')
    for (const s of elsewhere) lines.push(`- ${describe(s, true)}`)
  }
  lines.push('Sagt der Nutzer „Merk dir …“, nimm das Werkzeug merken. Ältere Sitzungen findet das Werkzeug erinnern.')
  lines.push('</gedaechtnis>')
  return fit(lines)
}

async function recall($, text, skipId) {
  const found = await search($, text, skipId)
  return found ? `<gedaechtnis>\nDazu aus früheren Sitzungen:\n${found}\n</gedaechtnis>` : ''
}

async function search($, query, skipId) {
  const words = keywords(query)
  if (!words.length) return ''
  const notes = (await loadNotes($)).filter((n) => words.some((w) => n.text.toLowerCase().includes(w)))
  const sessions = (await loadSessions($, skipId))
    .map((s) => [hits(s, words), s])
    .filter(([score]) => score > 0)
    .sort((a, b) => b[0] - a[0] || (b[1].ende || 0) - (a[1].ende || 0))
    .slice(0, 4)
    .map(([, s]) => s)
  const lines = []
  for (const note of notes.slice(-6)) lines.push(`- Gemerkt: ${note.text}`)
  for (const s of sessions) lines.push(`- ${describe(s, true)}`)
  return lines.join('\n')
}

function hits(session, words) {
  const text = [...(session.anfragen || []), session.zuletzt || ''].join(' ').toLowerCase()
  return words.filter((w) => text.includes(w)).length
}

function describe(session, withFolder) {
  const when = new Date(session.start || session.ende || 0)
  const stamp = `${WEEKDAYS[when.getDay()]} ${when.getDate()}.${when.getMonth() + 1}. ${pad(when.getHours())}:${pad(when.getMinutes())}`
  const count = session.zahl > 1 ? `, ${session.zahl} Anfragen` : ''
  const folder = withFolder && session.ort ? ` in ${folderName(session.ort)}` : ''
  const asked = (session.anfragen || []).slice(0, 3).map((a) => `„${clip(a, 120)}“`).join('; ')
  const result = session.zuletzt ? ` Ergebnis: ${clip(session.zuletzt, 220)}` : ''
  return `${stamp}${folder}${count}: ${asked}.${result}`
}

// ---------------------------------------------------------------------- Gemerktes

async function loadNotes($) {
  const keys = await $.store.keys()
  const notes = []
  for (const key of keys || []) {
    if (!String(key).startsWith('n:')) continue
    const note = await $.store.get(key)
    if (note && typeof note === 'object' && note.text) notes.push({ ...note, key })
  }
  return notes.sort((a, b) => (a.seit || 0) - (b.seit || 0))
}

async function addNote($, raw) {
  const text = clip(String(raw || '').replace(/\s+/g, ' ').trim(), 300)
  if (text.length < 3) return 'Was soll ich mir merken? Bitte als kurzen Satz.'
  if (SECRET.test(text)) return 'Passwörter, Schlüssel und Zugangsdaten merke ich mir nicht. Dafür ist ein Passwort-Manager da.'
  const now = await $.clock.now()
  const notes = await loadNotes($)
  const known = notes.find((n) => normal(n.text) === normal(text))
  if (known) {
    await $.store.set(known.key, { text: known.text, seit: now, ort: known.ort || '' })
    return `Wusste ich schon: ${known.text}`
  }
  let ort = ''
  try {
    ort = String((await $.session.cwd()) || '')
  } catch {
    ort = ''
  }
  await $.store.set(`n:${now}-${Math.random().toString(36).slice(2, 6)}`, { text, seit: now, ort })
  for (const old of notes.slice(0, Math.max(0, notes.length + 1 - MAX_NOTES))) await $.store.delete(old.key)
  return `Gemerkt: ${text}`
}

async function forget($, query) {
  const words = String(query || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []
  if (!words.length) return 0
  let removed = 0
  for (const note of await loadNotes($)) {
    const text = note.text.toLowerCase()
    if (words.every((w) => text.includes(w))) {
      await $.store.delete(note.key)
      removed += 1
    }
  }
  return removed
}

// ---------------------------------------------------------------------- Kleinigkeiten

function keywords(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]{3,}/gu) || []
  return [...new Set(words.filter((w) => !STOP.has(w)))].slice(0, 12)
}

function clip(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1).trimEnd() + '…'
}

function fit(lines) {
  const out = []
  let size = 0
  for (const line of lines) {
    if (size + line.length > CONTEXT_CHARS && line !== '</gedaechtnis>') continue
    out.push(line)
    size += line.length + 1
  }
  return out.join('\n')
}

function normal(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function same(a, b) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return Boolean(a) && norm(a) === norm(b)
}

function folderName(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || String(path || '')
}

function pad(n) {
  return String(n).padStart(2, '0')
}
