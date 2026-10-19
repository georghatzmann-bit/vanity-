import { describe, expect, it } from 'vitest';
import { ACTIVITY_LIMIT, createActivityLog } from '../activity/activityLog.ts';
import { createTranslator } from '../i18n/translator.ts';
import { describeSettingValue, settingLabelKeys } from './describe.ts';
import { applyDocumentPreferences, resolvePreferences } from './preferences.ts';
import { defaultSettings, settingKeys } from './schema.ts';

const system = { colorScheme: 'light', languages: ['en-GB'], reducedMotion: false } as const;

describe('resolvePreferences', () => {
  it('„System“ folgt Farbschema, Sprache und Bewegung des Systems', () => {
    expect(resolvePreferences(defaultSettings, system)).toEqual({
      language: 'en',
      locale: 'en-GB',
      colorScheme: 'light',
      reducedMotion: false,
    });
  });

  it('feste Einstellungen gehen vor; „Reduziert“ gilt unabhängig vom System', () => {
    expect(
      resolvePreferences(
        { ...defaultSettings, language: 'de', theme: 'dark', motion: 'reduced' },
        system,
      ),
    ).toEqual({ language: 'de', locale: 'de-DE', colorScheme: 'dark', reducedMotion: true });
  });

  it('wünscht das System reduzierte Bewegung, gilt sie auch bei „System“', () => {
    expect(
      resolvePreferences(defaultSettings, { ...system, reducedMotion: true }).reducedMotion,
    ).toBe(true);
  });
});

describe('applyDocumentPreferences', () => {
  it('setzt data-theme, lang und data-motion auf <html> – und entfernt data-motion wieder', () => {
    const root = document.createElement('html');
    applyDocumentPreferences(root, {
      language: 'en',
      locale: 'en-US',
      colorScheme: 'light',
      reducedMotion: true,
    });
    expect(root.dataset['theme']).toBe('light');
    expect(root.lang).toBe('en');
    expect(root.dataset['motion']).toBe('reduced');

    applyDocumentPreferences(root, {
      language: 'de',
      locale: 'de-DE',
      colorScheme: 'dark',
      reducedMotion: false,
    });
    expect(root.dataset['theme']).toBe('dark');
    expect(root.lang).toBe('de');
    expect(root.hasAttribute('data-motion')).toBe(false);
  });
});

describe('describeSettingValue', () => {
  it('beschreibt jeden Wert in der aktiven Sprache', () => {
    const { t } = createTranslator('de');
    expect(describeSettingValue(t, 'theme', 'light')).toBe('Hell');
    expect(describeSettingValue(t, 'language', 'en')).toBe('English');
    expect(describeSettingValue(t, 'motion', 'reduced')).toBe('Reduziert');
    expect(describeSettingValue(t, 'sound', false)).toBe('aus');
    expect(describeSettingValue(t, 'bootAnimation', true)).toBe('an');
    const en = createTranslator('en');
    expect(describeSettingValue(en.t, 'theme', 'system')).toBe('System');
    expect(describeSettingValue(en.t, 'closeToTray', true)).toBe('on');
  });

  it('jede Einstellung hat eine Beschriftung', () => {
    const { t } = createTranslator('de');
    for (const key of settingKeys) {
      expect(t(settingLabelKeys[key]), key).not.toBe(settingLabelKeys[key]);
    }
  });
});

describe('Live-Aktivität', () => {
  it('neueste zuerst, mit Zeitpunkt und fortlaufender ID', () => {
    let now = 1000;
    const log = createActivityLog(() => now);
    log.record({ kind: 'app-started', platform: 'browser' });
    now = 2000;
    log.record({ kind: 'boot-replayed' });
    expect(log.getSnapshot()).toEqual([
      { kind: 'boot-replayed', id: 2, at: 2000 },
      { kind: 'app-started', platform: 'browser', id: 1, at: 1000 },
    ]);
  });

  it(`hält höchstens ${ACTIVITY_LIMIT} Einträge im Arbeitsspeicher`, () => {
    const log = createActivityLog(() => 0);
    for (let index = 0; index < ACTIVITY_LIMIT + 25; index += 1) {
      log.record({ kind: 'setting-changed', setting: 'sound', value: index % 2 === 0 });
    }
    const entries = log.getSnapshot();
    expect(entries).toHaveLength(ACTIVITY_LIMIT);
    expect(entries[0]?.id).toBe(ACTIVITY_LIMIT + 25);
    expect(entries.at(-1)?.id).toBe(26);
  });

  it('meldet Änderungen; abgemeldete Empfänger nicht mehr', () => {
    const log = createActivityLog();
    const calls: number[] = [];
    const unsubscribe = log.subscribe(() => calls.push(log.getSnapshot().length));
    log.record({ kind: 'save-failed' });
    unsubscribe();
    log.record({ kind: 'save-failed' });
    expect(calls).toEqual([1]);
  });
});
