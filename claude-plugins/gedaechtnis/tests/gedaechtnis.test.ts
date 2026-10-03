import { expect, mock, test } from 'claude-code/testing'

// Ein Speicher wie $.store, eine Uhr und Sitzungen, die der Test umschaltet
function setup(on, start = Date.UTC(2026, 9, 2, 18, 0)) {
  const saved = new Map<string, unknown>()
  const state = { id: 'a', cwd: '/home/georg/projekte/shop', contexts: [] as string[][] }
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => { saved.set(e.key, structuredClone(e.value)); return { value: undefined } })
  on('store.delete', ($, e) => { saved.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('session.id', () => ({ value: state.id }))
  on('session.cwd', () => ({ value: state.cwd }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: state.cwd }))
  on('prompt.submit', ($, e) => { state.contexts.push(e.context ?? []); return { text: e.text } })
  on('turn.complete', () => ({ text: '' }))
  const clock = mock.clock(on, { now: start })
  return { saved, state, clock }
}

async function turn($, prompt, answer) {
  await $.prompt.submit({ text: prompt })
  await $.turn.complete({ turnId: 't', answer, durationMs: 10, isAborted: false, usage: null })
}

test('the next session knows what happened in the last one', async ($, on) => {
  const { state, clock } = setup(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: state.cwd })
  await turn($, 'Bau mir eine Produktseite für die Tassen', 'Die Produktseite liegt in tassen.html.')
  await turn($, 'Mach den Kaufen-Knopf grün', 'Der Knopf ist jetzt grün.')
  expect(state.contexts[0]).toEqual([]) // am Anfang weiß das Gedächtnis noch nichts

  await clock.advance(24 * 60 * 60 * 1000)
  state.id = 'b'
  await $.prompt.submit({ text: 'Weiter mit dem Shop' })
  const memory = state.contexts[2].join('\n')
  expect(memory).toContain('Zuletzt in diesem Ordner (shop)')
  expect(memory).toContain('„Bau mir eine Produktseite für die Tassen“')
  expect(memory).toContain('2 Anfragen')
  expect(memory).toContain('Ergebnis: Der Knopf ist jetzt grün.')

  await $.prompt.submit({ text: 'Und noch ein Bild dazu' })
  expect(state.contexts[3]).toEqual([]) // nur einmal je Sitzung
})

test('notes from merken come back in every new session', async ($, on) => {
  const { state } = setup(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: state.cwd })
  const first = await $.tool.call({ tool: 'mcp__gedaechtnis__merken', text: 'Georg will kurze Antworten auf Deutsch' })
  expect(first.result).toBe('Gemerkt: Georg will kurze Antworten auf Deutsch')
  const again = await $.tool.call({ tool: 'mcp__gedaechtnis__merken', text: 'georg will kurze Antworten auf deutsch!' })
  expect(again.result).toContain('Wusste ich schon')
  const secret = await $.tool.call({ tool: 'mcp__gedaechtnis__merken', text: 'Mein Passwort ist 1234' })
  expect(secret.result).toContain('merke ich mir nicht')

  state.id = 'c'
  state.cwd = '/home/georg/anderswo'
  await $.prompt.submit({ text: 'Hallo, neues Projekt' })
  const memory = state.contexts[0].join('\n')
  expect(memory).toContain('Gemerkt:\n- Georg will kurze Antworten auf Deutsch')
  expect(memory).not.toContain('1234')

  const gone = await $.tool.call({ tool: 'mcp__gedaechtnis__vergessen', suche: 'kurze antworten' })
  expect(gone.result).toBe('1 Eintrag vergessen.')
  const none = await $.tool.call({ tool: 'mcp__gedaechtnis__erinnern', suche: 'Antworten' })
  expect(none.result).toBe('Dazu ist nichts gespeichert.')
})

test('recall phrases search older sessions mid-session', async ($, on) => {
  const { state, clock } = setup(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: state.cwd })
  await turn($, 'Schreib einen Newsletter für die Herbst-Aktion', 'Der Newsletter steht in herbst.md.')
  await clock.advance(3 * 60 * 60 * 1000)
  state.id = 'd'
  await turn($, 'Prüf die Rechnungen', 'Alles bezahlt.')
  await $.prompt.submit({ text: 'Mach es wie letztes Mal beim Newsletter' })
  const found = state.contexts[2].join('\n')
  expect(found).toContain('Dazu aus früheren Sitzungen')
  expect(found).toContain('Newsletter für die Herbst-Aktion')
  expect(found).not.toContain('Rechnungen')
})

test('secrets, commands and subagents stay out', async ($, on) => {
  const { state, saved } = setup(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: state.cwd })
  await $.prompt.submit({ text: 'Mein API-Key ist sk-abcdefghijklmnop, trag ihn ein' })
  await $.prompt.submit({ text: '/model opus' })
  await $.turn.complete({ turnId: 'x', answer: 'Antwort vom Spezialisten', durationMs: 1, isAborted: false, usage: null, agentId: 'helfer' })
  const record = saved.get('s:a') as { anfragen: string[]; zahl: number; zuletzt: string }
  expect(record.anfragen).toEqual([])
  expect(record.zahl).toBe(1)
  expect(record.zuletzt).toBe('')
})

test('/gedaechtnis lists notes and sessions, old sessions are pruned', async ($, on) => {
  const { state, saved, clock } = setup(on)
  saved.set('s:alt', { id: 'alt', ort: '/x', start: 0, ende: 0, anfragen: ['Uralt'], zahl: 1, zuletzt: '' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: state.cwd })
  expect(saved.has('s:alt')).toBe(false)
  const empty = await $.command.run({ command: 'gedaechtnis', args: '' })
  expect(empty.text).toContain('Noch nichts gespeichert')
  await turn($, 'Plane die Woche mit drei Trainings', 'Montag, Mittwoch und Freitag.')
  await $.tool.call({ tool: 'mcp__gedaechtnis__merken', text: 'Training immer abends' })
  const list = await $.command.run({ command: 'gedaechtnis', args: '' })
  expect(list.text).toContain('Gemerkt (1):\n- Training immer abends')
  expect(list.text).toContain('Plane die Woche')
  const search = await $.command.run({ command: 'gedaechtnis', args: 'Trainings' })
  expect(search.text).toContain('Plane die Woche')
})
