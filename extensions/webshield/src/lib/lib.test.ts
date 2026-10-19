import { describe, expect, it } from 'vitest';
import { hostOf, normalizeDomain, parseList, withinDomain } from './domains';
import { downloadRisks } from './downloads';
import { texts } from './i18n';
import { deconfuse, registrable, signals } from './lookalike';
import {
  ALLOW_BASE,
  allowRule,
  blockRules,
  categories,
  categoryFrom,
  DOMAINS_PER_RULE,
} from './rules';
import {
  DEFAULT_SETTINGS,
  EMPTY_STATUS,
  isMessage,
  readSettings,
  readStatus,
  updateDue,
} from './settings';
import { categoryBase, SOURCES } from './sources';

describe('Domains', () => {
  it('normalisiert und verwirft Ungültiges', () => {
    expect(normalizeDomain(' Example.COM. ')).toBe('example.com');
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('1.2.3.4')).toBeNull();
    expect(normalizeDomain('-bad.com')).toBeNull();
    expect(normalizeDomain('a..b')).toBeNull();
    expect(normalizeDomain(`${'a'.repeat(64)}.com`)).toBeNull();
  });

  it('liest Hosts-, Adblock- und Domain-Zeilen', () => {
    const text = [
      '# Kommentar',
      '0.0.0.0 evil.example',
      '||phish.example^',
      'scam.example # dahinter',
      '! Adblock-Kommentar',
      '127.0.0.1 localhost',
      'printer.local',
      'evil.example',
      'kaputt',
    ].join('\r\n');
    expect(parseList(text)).toEqual(['evil.example', 'phish.example', 'scam.example']);
    expect(parseList(text, 1)).toEqual(['evil.example']);
  });

  it('Host und Subdomains', () => {
    expect(hostOf('https://Shop.Example.com/x')).toBe('shop.example.com');
    expect(hostOf('chrome-extension://abc/warn.html')).toBeNull();
    expect(hostOf('kein url')).toBeNull();
    expect(withinDomain('a.example.com', 'example.com')).toBe(true);
    expect(withinDomain('badexample.com', 'example.com')).toBe(false);
  });
});

describe('Regeln', () => {
  it('teilt große Listen und leitet nur Seitenaufrufe um', () => {
    const domains = Array.from({ length: DOMAINS_PER_RULE + 5 }, (_, i) => `d${i}.example`);
    const rules = blockRules('phishing', domains, 1000);
    expect(rules.map((r) => r.id)).toEqual([1000, 1001]);
    expect(rules[1]?.condition.requestDomains).toHaveLength(5);
    for (const r of rules) {
      expect(r.condition.resourceTypes).toEqual(['main_frame']);
      expect(r.action).toEqual({
        type: 'redirect',
        redirect: { extensionPath: '/warn.html?c=phishing' },
      });
    }
    expect(blockRules('scam', [], 1)).toEqual([]);
  });

  it('Ausnahme hat Vorrang, Kategorie wird geprüft', () => {
    const allow = allowRule('ok.example', ALLOW_BASE);
    expect(allow.priority).toBeGreaterThan(1);
    expect(allow.action.type).toBe('allow');
    expect(categoryFrom('?c=scam')).toBe('scam');
    expect(categoryFrom('?c=<script>')).toBeNull();
    expect(categoryFrom('')).toBeNull();
  });

  it('Kennungsbereiche überschneiden sich nicht', () => {
    const bases = categories.map(categoryBase);
    expect(new Set(bases).size).toBe(bases.length);
    for (const b of bases) {
      expect(b + 1000).toBeLessThanOrEqual(ALLOW_BASE);
    }
    for (const s of SOURCES) {
      expect(s.url.startsWith('https://')).toBe(true);
      expect(categories).toContain(s.category);
    }
  });
});

describe('Betrugsmerkmale', () => {
  it('erkennt fremde Domains mit Markennamen', () => {
    expect(signals('paypal-login.example', 'https:', false)).toEqual(['brand']);
    expect(signals('secure.paypa1.example', 'https:', false)).toEqual(['brand']);
    expect(signals('www.paypal.com', 'https:', true)).toEqual([]);
    expect(signals('signin.amazon.de', 'https:', true)).toEqual([]);
    expect(signals('news.example', 'https:', false)).toEqual([]);
  });

  it('Punycode und Passwort ohne HTTPS', () => {
    expect(signals('xn--pypal-4ve.com', 'https:', false)).toEqual(['punycode']);
    expect(signals('forum.example', 'http:', true)).toEqual(['insecure_password']);
    expect(signals('forum.example', 'http:', false)).toEqual([]);
  });

  it('Hilfsfunktionen', () => {
    expect(deconfuse('rnicr0soft')).toBe('microsoft');
    expect(registrable('a.b.example.co.uk')).toBe('example.co.uk');
    expect(registrable('a.b.example.com')).toBe('example.com');
  });
});

describe('Downloads', () => {
  it('markiert riskante Dateien', () => {
    expect(downloadRisks('C:\\Users\\a\\Downloads\\setup.exe', 'https://x.example/s.exe')).toEqual([
      'executable',
    ]);
    expect(downloadRisks('rechnung.pdf.exe', 'http://x.example/r')).toEqual([
      'executable',
      'double_extension',
      'insecure_source',
    ]);
    expect(downloadRisks('tabelle.xlsm', 'https://x.example')).toEqual(['macro']);
    expect(downloadRisks('foto.jpg', 'http://x.example')).toEqual([]);
    expect(downloadRisks('ohne-endung', 'https://x.example')).toEqual([]);
  });
});

describe('Einstellungen und Status', () => {
  it('liest tolerant', () => {
    expect(readSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings({ updateLists: false, pageHints: 'ja' })).toEqual({
      ...DEFAULT_SETTINGS,
      updateLists: false,
    });
    expect(readStatus(null)).toEqual(EMPTY_STATUS);
    expect(
      readStatus({
        updatedAt: 5,
        domains: 3,
        sources: [
          { id: 'a', domains: 3, ok: true },
          { id: 'b', domains: 0, ok: false, error: 'HTTP 500' },
          { id: 7 },
          null,
        ],
      }),
    ).toEqual({
      updatedAt: 5,
      domains: 3,
      sources: [
        { id: 'a', domains: 3, ok: true },
        { id: 'b', domains: 0, ok: false, error: 'HTTP 500' },
      ],
    });
  });

  it('Fälligkeit und Nachrichten', () => {
    const day = 24 * 60;
    expect(updateDue(EMPTY_STATUS, Date.now(), day)).toBe(true);
    const now = 10 * day * 60_000;
    expect(updateDue({ ...EMPTY_STATUS, updatedAt: now - 1000 }, now, day)).toBe(false);
    expect(updateDue({ ...EMPTY_STATUS, updatedAt: now + 1000 }, now, day)).toBe(true);
    expect(isMessage({ type: 'allow-once' })).toBe(true);
    expect(isMessage({ type: 'delete-everything' })).toBe(false);
    expect(isMessage('allow-once')).toBe(false);
  });

  it('Texte in beiden Sprachen vollständig', () => {
    const de = texts('de-DE');
    const en = texts('en-US');
    expect(de.warnTitle).not.toBe(en.warnTitle);
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    expect(texts('fr').warnTitle).toBe(en.warnTitle);
    for (const c of categories) {
      expect(de.category[c].length).toBeGreaterThan(0);
    }
  });
});
