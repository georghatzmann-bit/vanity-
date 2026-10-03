import { expect, mock, test } from 'claude-code/testing'

function setup(on, start = Date.UTC(2026, 9, 1, 9, 0)) {
  const saved = new Map<string, unknown>()
  const state = { id: 'a', contexts: [] as string[][] }
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => { saved.set(e.key, structuredClone(e.value)); return { value: undefined } })
  on('store.delete', ($, e) => { saved.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('session.id', () => ({ value: state.id }))
  on('session.cwd', () => ({ value: 'C:\\Users\\Georg\\Projekte\\shop' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.submit', ($, e) => { state.contexts.push(e.context ?? []); return { text: e.text } })
  on('turn.complete', () => ({ text: '' }))
  const clock = mock.clock(on, { now: start })
  return { saved, state, clock }
}

async function answer($, text) {
  await $.turn.complete({ turnId: 't', answer: text, durationMs: 5, isAborted: false, usage: null })
}

function observations(saved) {
  return [...saved.entries()].filter(([k]) => k.startsWith('b:')).map(([, v]) => v as { art: string; text: string; vorher: string })
}

test('corrections, wishes and praise are noted with the answer before', async ($, on) => {
  const { saved } = setup(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'Nein, das war nicht gemeint' }) // erste Nachricht: nichts zu korrigieren
  expect(observations(saved)).toEqual([])
  await answer($, 'Hier ist ein langer Bericht mit sieben Abschnitten.')
  await $.prompt.submit({ text: 'Viel zu lang, bitte kürzer' })
  await $.prompt.submit({ text: 'Antworte ab jetzt immer auf Deutsch' })
  await answer($, 'Kurz: Alles erledigt.')
  await $.prompt.submit({ text: 'Perfekt, genau so' })
  await $.prompt.submit({ text: 'Bau mir ein Dashboard für den Shop' }) // normale Aufgabe
  const found = observations(saved)
  expect(found.map((o) => o.art)).toEqual(['korrektur', 'vorliebe', 'lob'])
  expect(found[0].vorher).toBe('Hier ist ein langer Bericht mit sieben Abschnitten.')
  expect(found[1].vorher).toBe('')
  expect(found[2].vorher).toBe('Kurz: Alles erledigt.')
})

test('confirmed rules reach every new session', async ($, on) => {
  const { state } = setup(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const saved = await $.tool.call({ tool: 'mcp__lernen__regel', text: 'Antworte auf Deutsch und kurz' })
  expect(saved.result).toBe('Regel gespeichert: Antworte auf Deutsch und kurz')
  const twice = await $.tool.call({ tool: 'mcp__lernen__regel', text: 'antworte auf deutsch und kurz.' })
  expect(twice.result).toContain('Gibt es schon')
  state.id = 'b'
  await $.prompt.submit({ text: 'Hallo' })
  expect(state.contexts[0].join('\n')).toContain('<gelernt>')
  expect(state.contexts[0].join('\n')).toContain('- Antworte auf Deutsch und kurz')
  await $.prompt.submit({ text: 'Noch was' })
  expect(state.contexts[1]).toEqual([])
  const removed = await $.tool.call({ tool: 'mcp__lernen__regel_loeschen', suche: 'deutsch kurz' })
  expect(removed.result).toBe('1 Regel(n) gelöscht.')
})

test('review: list, mark done, status command', async ($, on) => {
  const { saved } = setup(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'Schreib die Produktbeschreibung' })
  await answer($, 'Erste Antwort')
  await $.prompt.submit({ text: 'Falsch, du hast den Preis vergessen' })
  await $.prompt.submit({ text: 'Ich will lieber Tabellen statt Listen' })
  const listed = await $.tool.call({ tool: 'mcp__lernen__beobachtungen' })
  expect(listed.result).toContain('Korrektur: „Falsch, du hast den Preis vergessen“ (Antwort davor: „Erste Antwort“) in shop')
  expect(listed.result).toContain('Vorliebe: „Ich will lieber Tabellen statt Listen“')
  const status = await $.command.run({ command: 'lernen', args: '' })
  expect(status.text).toContain('2 neue Beobachtung(en): 1 Korrektur(en), 1 Vorliebe(n), 0 Lob')
  const keys = [...saved.keys()].filter((k) => k.startsWith('b:'))
  const done = await $.tool.call({ tool: 'mcp__lernen__erledigt', ids: keys })
  expect(done.result).toBe('2 Beobachtung(en) als ausgewertet markiert.')
  const after = await $.tool.call({ tool: 'mcp__lernen__beobachtungen' })
  expect(after.result).toBe('Keine neuen Beobachtungen.')
})

test('after a week with many observations Claude offers a review once', async ($, on) => {
  const { state, clock } = setup(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'Los geht es' })
  for (let i = 0; i < 8; i++) {
    await answer($, `Antwort ${i}`)
    await $.prompt.submit({ text: `Nein, nicht so ${i}` })
  }
  state.id = 'b'
  await $.prompt.submit({ text: 'Neue Sitzung' })
  expect(state.contexts.at(-1).join('\n')).not.toContain('Plugin Lernen: Es gibt') // noch keine Woche her
  await clock.advance(8 * 24 * 60 * 60 * 1000)
  state.id = 'c'
  await $.prompt.submit({ text: 'Eine Woche später' })
  expect(state.contexts.at(-1).join('\n')).toContain('Es gibt 8 neue Beobachtungen')
})

test('secrets are never noted', async ($, on) => {
  const { saved } = setup(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'Richte den Server ein' })
  await answer($, 'Fertig')
  await $.prompt.submit({ text: 'Nein, mein Passwort ist Hund123, nimm immer das' })
  expect(observations(saved)).toEqual([])
})
