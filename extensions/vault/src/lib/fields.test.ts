// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { fill, passwordFields, usernameFor } from './fields';

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
    fill(p, 'anna', 'geheim');
    expect((document.getElementById('u') as HTMLInputElement).value).toBe('anna');
    expect(p.value).toBe('geheim');
    expect(events).toEqual(['input', 'change']);
  });

  it('ohne Benutzernamen bleibt das Feld unberührt', () => {
    form(`<form><input id="u" type="text" value="vorher"><input id="p" type="password"></form>`);
    const p = passwordFields(document)[0];
    if (p !== undefined) {
      fill(p, '', 'geheim');
    }
    expect((document.getElementById('u') as HTMLInputElement).value).toBe('vorher');
  });
});
