// Lernen (wie Task Observer aus dem Video): Korrigierst du Claude ("Nein, nicht so", "Das war zu lang") oder sagst du,
// was du willst ("Bitte immer auf Deutsch") oder was gut war ("Genau so"), merkt sich das Plugin die Stelle samt der
// Antwort davor. Mit /lernen:auswerten geht Claude die Beobachtungen mit dir durch und macht daraus Regeln oder
// bessere Skills, aber nur mit deinem Ja. Bestätigte Regeln bekommt Claude zu Beginn jeder Sitzung mit.
// Alles liegt im Speicher von Claude Code auf diesem PC ($.store).

const MAX_OBSERVATIONS = 400
const MAX_RULES = 80
const NUDGE_COUNT = 8 // ab so vielen neuen Beobachtungen ...
const NUDGE_DAYS = 7 // ... und so vielen Tagen seit der letzten Auswertung bietet Claude sie einmal an
const DAY = 24 * 60 * 60 * 1000

const CORRECTION = /^(nein|nee|ne|nö|falsch|stopp|stop|halt|moment)\b|\b(das ist falsch|stimmt nicht|nicht so|so nicht|das war nicht|du hast vergessen|hast du vergessen|du sollst nicht|mach das nicht|nicht schon wieder|wieder falsch|ich hab doch gesagt|ich habe doch gesagt|wie gesagt|das wollte ich nicht|das meinte ich nicht|lass das|zu lang|zu kurz|zu kompliziert|viel zu)\b/i
const PREFERENCE = /\b(immer|nie|niemals|ab jetzt|ab sofort|in zukunft|künftig|bitte nicht|lieber|stattdessen|bevorzug\w*|ich mag|ich will|ich möchte|ich hätte gern|grundsätzlich|jedes mal)\b/i
const PRAISE = /^(perfekt|super|klasse|genial|top|sehr gut|genau so|richtig so|stark|toll)\b|\b(genau so|genau richtig|das ist perfekt|gut gemacht|super gemacht|so ist es gut|gefällt mir)\b/i
const SECRET = /(passw(or)?t|password|kennwort|zugangsdaten|\btoken\b|api[-_ ]?key|secret|\bpin\b|\biban\b|kreditkarte|sk-[a-z0-9]{8}|ghp_|github_pat_|-----begin)/i
const KINDS = { korrektur: 'Korrektur', vorliebe: 'Vorliebe', lob: 'Lob' }

let sessionKey = ''
let lastAnswer = ''

export function register(on) {
  on('session.start', async ($, e, next) => {
    sessionKey = ''
    lastAnswer = ''
    try {
      await $.tool.register({
        name: 'beobachtungen',
        description: 'Die neuen Beobachtungen des Plugins Lernen: wo der Nutzer korrigiert, gelobt oder eine Vorliebe ' +
          'genannt hat, jeweils mit der Antwort davor. Für /lernen:auswerten.',
        inputSchema: { type: 'object', properties: { alle: { type: 'boolean', description: 'auch schon ausgewertete' } } },
      })
      await $.tool.register({
        name: 'regel',
        description: 'Speichert eine Regel, die der Nutzer ausdrücklich bestätigt hat ("Antworte immer auf Deutsch"). ' +
          'Claude bekommt sie in jeder neuen Sitzung. Nie ohne sein Ja.',
        inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Die Regel in einem Satz' } }, required: ['text'] },
      })
      await $.tool.register({
        name: 'regeln',
        description: 'Zeigt alle bestätigten Regeln des Plugins Lernen.',
        inputSchema: { type: 'object', properties: {} },
      })
      await $.tool.register({
        name: 'regel_loeschen',
        description: 'Löscht Regeln, in denen alle diese Wörter vorkommen.',
        inputSchema: { type: 'object', properties: { suche: { type: 'string' } }, required: ['suche'] },
      })
      await $.tool.register({
        name: 'erledigt',
        description: 'Markiert Beobachtungen als ausgewertet (die Schlüssel aus beobachtungen).',
        inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
      })
      await $.command.register({ name: 'lernen', description: 'Zeigt, was das Plugin Lernen beobachtet hat und welche Regeln gelten' })
    } catch {
      // Name schon vergeben: ohne Befehl weiter
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const text = String(e.text || '').trim()
    if (!text || text.startsWith('/')) return next(e)
    const extra = []
    const id = await sessionId($)
    if (id !== sessionKey) {
      sessionKey = id
      lastAnswer = ''
      const rules = await rulesText($)
      if (rules) extra.push(rules)
      const nudge = await nudgeText($)
      if (nudge) extra.push(nudge)
    }
    await observe($, text)
    if (!extra.length) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...extra] })
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && !e.isAborted) lastAnswer = clip(e.answer, 300)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__lernen__beobachtungen' }, async ($, e) => {
    const list = (await loadObservations($)).filter((o) => e.alle || o.neu)
    if (!list.length) return { result: 'Keine neuen Beobachtungen.' }
    const lines = list.slice(-60).map((o) => `[${o.key}] ${KINDS[o.art] || o.art}: „${o.text}“` +
      (o.vorher ? ` (Antwort davor: „${clip(o.vorher, 200)}“)` : '') + (o.ort ? ` in ${folderName(o.ort)}` : ''))
    return { result: lines.join('\n') }
  })

  on('tool.call', { tool: 'mcp__lernen__regel' }, async ($, e) => {
    return { result: await addRule($, e.text) }
  })

  on('tool.call', { tool: 'mcp__lernen__regeln' }, async ($) => {
    const rules = await loadRules($)
    return { result: rules.length ? rules.map((r) => `- ${r.text}`).join('\n') : 'Noch keine Regeln.' }
  })

  on('tool.call', { tool: 'mcp__lernen__regel_loeschen' }, async ($, e) => {
    const words = String(e.suche || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []
    let removed = 0
    for (const rule of words.length ? await loadRules($) : []) {
      const text = rule.text.toLowerCase()
      if (words.every((w) => text.includes(w))) {
        await $.store.delete(rule.key)
        removed += 1
      }
    }
    return { result: removed ? `${removed} Regel(n) gelöscht.` : 'Keine passende Regel gefunden.' }
  })

  on('tool.call', { tool: 'mcp__lernen__erledigt' }, async ($, e) => {
    const ids = new Set((e.ids || []).map(String))
    let done = 0
    for (const o of await loadObservations($)) {
      if (o.neu && ids.has(o.key)) {
        const { key, ...rest } = o
        await $.store.set(key, { ...rest, neu: false })
        done += 1
      }
    }
    await $.store.set('lernen:meta', { ausgewertet: await $.clock.now() })
    await trim($)
    return { result: `${done} Beobachtung(en) als ausgewertet markiert.` }
  })

  on('command.run', { command: 'lernen' }, async ($) => {
    const fresh = (await loadObservations($)).filter((o) => o.neu)
    const rules = await loadRules($)
    const count = (art) => fresh.filter((o) => o.art === art).length
    const lines = []
    if (fresh.length) {
      lines.push(`${fresh.length} neue Beobachtung(en): ${count('korrektur')} Korrektur(en), ${count('vorliebe')} Vorliebe(n), ` +
        `${count('lob')} Lob. Mit /lernen:auswerten gehen wir sie durch.`)
    } else {
      lines.push('Keine neuen Beobachtungen. Korrigier mich einfach, wenn etwas nicht passt, das merke ich mir.')
    }
    lines.push(rules.length ? `Regeln (${rules.length}):` : 'Noch keine Regeln.')
    for (const rule of rules) lines.push(`- ${rule.text}`)
    return { text: lines.join('\n') }
  })
}

// ---------------------------------------------------------------------- Beobachten

async function observe($, text) {
  const art = classify(text, Boolean(lastAnswer))
  if (!art || SECRET.test(text)) return
  const now = await $.clock.now()
  let ort = ''
  try {
    ort = String((await $.session.cwd()) || '')
  } catch {
    ort = ''
  }
  await $.store.set(`b:${now}-${Math.random().toString(36).slice(2, 6)}`,
    { art, text: clip(text, 400), vorher: art === 'vorliebe' ? '' : lastAnswer, zeit: now, ort, neu: true })
  await trim($)
}

function classify(text, answered) {
  if (answered && text.length <= 600 && CORRECTION.test(text)) return 'korrektur'
  if (text.length <= 300 && PREFERENCE.test(text)) return 'vorliebe'
  if (answered && text.length <= 200 && PRAISE.test(text)) return 'lob'
  return ''
}

async function loadObservations($) {
  const out = []
  for (const key of (await $.store.keys()) || []) {
    if (!String(key).startsWith('b:')) continue
    const o = await $.store.get(key)
    if (o && typeof o === 'object' && o.text) out.push({ ...o, key })
  }
  return out.sort((a, b) => (a.zeit || 0) - (b.zeit || 0))
}

async function trim($) {
  const all = await loadObservations($)
  const old = all.filter((o) => !o.neu)
  for (const o of old.slice(0, Math.max(0, all.length - MAX_OBSERVATIONS))) await $.store.delete(o.key)
}

async function nudgeText($) {
  const fresh = (await loadObservations($)).filter((o) => o.neu)
  if (fresh.length < NUDGE_COUNT) return ''
  const meta = (await $.store.get('lernen:meta')) || {}
  const since = meta.ausgewertet || fresh[0].zeit || 0
  if ((await $.clock.now()) - since < NUDGE_DAYS * DAY) return ''
  return `Hinweis vom Plugin Lernen: Es gibt ${fresh.length} neue Beobachtungen, wo der Nutzer korrigiert oder gelobt hat. ` +
    'Biete am Ende deiner ersten Antwort in einem kurzen Satz an, sie mit /lernen:auswerten durchzugehen. Nur einmal.'
}

// ---------------------------------------------------------------------- Regeln

async function loadRules($) {
  const out = []
  for (const key of (await $.store.keys()) || []) {
    if (!String(key).startsWith('r:')) continue
    const rule = await $.store.get(key)
    if (rule && typeof rule === 'object' && rule.text) out.push({ ...rule, key })
  }
  return out.sort((a, b) => (a.seit || 0) - (b.seit || 0))
}

async function addRule($, raw) {
  const text = clip(String(raw || '').replace(/\s+/g, ' ').trim(), 240)
  if (text.length < 4) return 'Bitte die Regel als kurzen Satz.'
  if (SECRET.test(text)) return 'Zugangsdaten gehören nicht in Regeln.'
  const rules = await loadRules($)
  if (rules.some((r) => normal(r.text) === normal(text))) return `Gibt es schon: ${text}`
  if (rules.length >= MAX_RULES) return `Schon ${MAX_RULES} Regeln. Bitte erst eine alte löschen (regel_loeschen).`
  const now = await $.clock.now()
  await $.store.set(`r:${now}-${Math.random().toString(36).slice(2, 6)}`, { text, seit: now })
  return `Regel gespeichert: ${text}`
}

async function rulesText($) {
  const rules = await loadRules($)
  if (!rules.length) return ''
  return ['<gelernt>', 'Was der Nutzer dir beigebracht und bestätigt hat (Plugin Lernen). Halte dich daran, ohne es zu erwähnen:',
    ...rules.map((r) => `- ${r.text}`), '</gelernt>'].join('\n')
}

// ---------------------------------------------------------------------- Kleinigkeiten

async function sessionId($) {
  try {
    const id = await $.session.id()
    if (id) return String(id)
  } catch {
    // ältere Fassung: eine Sitzung pro Laden des Plugins
  }
  return 'sitzung'
}

function clip(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1).trimEnd() + '…'
}

function normal(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function folderName(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || ''
}
