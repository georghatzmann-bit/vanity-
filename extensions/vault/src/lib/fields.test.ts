// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { fill, passwordFields, usernameFor } from './fields';

/** jsdom kennt kein Layout: alle Felder gelten als 200×30 oben links. */
const rect = () => ({ top: 10, left: 10, bottom: 40, right: 210, width: 200, height: 30 });

beforeEach(() => {
  document.body.replaceChildren();
});

function form(html: string): void {
  const wrap = document.createElement('div');
  // Nur Testaufbau mit festen, harmlosen Feldern.
  wrap.innerHTML = html;
  document.body.append(wrap);
}

describe('Login-Felder', () => {
  it('findet Benutzername vor dem Passwort im selben Formular', () => {
    form(`<form id="a"><input name="q" type="search"><input id="u" type="email"><input id="p" type="password"></form>
          <form><input id="other" type="text"></form>`);
    const [p] = passwordFields(document);
    expect(p?.id).toBe('p');
    expect(p && usernameFor(p)?.id).toBe('u');
  });

  it('bevorzugt autocomplete=username, übergeht versteckte und gesperrte Felder', () => {
    form(`<form><input id="n" autocomplete="username"><input id="x" type="text">
          <input id="h" type="text" style="display:none"><input type="password" disabled>
          <input id="p" type="password"></form>`);
    const fields = passwordFields(document);
    expect(fields.map((f) => f.id)).toEqual(['p']);
    expect(fields[0] && usernameFor(fields[0])?.id).toBe('n');
  });

  it('füllt aus und meldet input/change', () => {
    form(`<form><input id="u" type="text"><input id="p" type="password"></form>`);
    const events: string[] = [];
    const p = passwordFields(document)[0];
    expect(p).toBeDefined();
    if (p === undefined) {
      return;
    }
    p.addEventListener('input', () => events.push('input'));
    p.addEventListener('change', () => events.push('change'));
    expect(fill(p, 'anna', 'geheim', rect)).toBe(true);
    expect((document.getElementById('u') as HTMLInputElement).value).toBe('anna');
    expect(p.value).toBe('geheim');
    expect(events).toEqual(['input', 'change']);
  });

  it('ohne Benutzernamen bleibt das Feld unberührt', () => {
    form(`<form><input id="u" type="text" value="vorher"><input id="p" type="password"></form>`);
    const p = passwordFields(document)[0];
    if (p !== undefined) {
      fill(p, '', 'geheim', rect);
    }
    expect((document.getElementById('u') as HTMLInputElement).value).toBe('vorher');
  });

  it('füllt nie in unsichtbare, winzige oder entfernte Felder', () => {
    form(
      `<form><input id="u" type="text"><div style="opacity:0.2"><input id="p" type="password"></div></form>`,
    );
    const p = document.getElementById('p') as HTMLInputElement;
    expect(fill(p, 'anna', 'geheim', rect)).toBe(false);
    expect(p.value).toBe('');
    p.parentElement?.setAttribute('style', '');
    const tiny = () => ({ top: 0, left: 0, bottom: 1, right: 1, width: 1, height: 1 });
    expect(fill(p, 'anna', 'geheim', tiny)).toBe(false);
    const away = () => ({ top: -500, left: 10, bottom: -470, right: 210, width: 200, height: 30 });
    expect(fill(p, 'anna', 'geheim', away)).toBe(false);
    expect(p.value).toBe('');
    expect(fill(p, 'anna', 'geheim', rect)).toBe(true);
  });
});
