import { describe, expect, it } from 'vitest';
import { isCi, TEST_TIMEOUT_MS, testSettings } from '../vitest.settings.ts';

describe('Vitest-Einstellungen (CI)', () => {
  it('gibt jedem Test genug Zeit für langsame CI-Runner (kalter jsdom auf Windows)', ({ task }) => {
    // Der Standard von 5 s ließ CI auf windows-latest scheitern (5,4 s für den ersten Test).
    expect(TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
    // … und genau dieses Limit gilt im laufenden Testlauf.
    expect(task.timeout).toBe(TEST_TIMEOUT_MS);
    const settings = testSettings({});
    expect(settings.testTimeout).toBe(TEST_TIMEOUT_MS);
    expect(settings.hookTimeout).toBe(TEST_TIMEOUT_MS);
  });

  it('erzwingt in CI die Abdeckungs-Untergrenzen (Freigabe-Dialog ≥ 95 %), lokal nur auf Wunsch', () => {
    expect(isCi({ CI: 'true' })).toBe(true);
    expect(isCi({ CI: '1' })).toBe(true);
    expect(isCi({ CI: 'false' })).toBe(false);
    expect(isCi({ CI: '0' })).toBe(false);
    expect(isCi({ CI: '' })).toBe(false);
    expect(isCi({})).toBe(false);

    const ci = testSettings({ CI: 'true' }).coverage;
    expect(ci?.enabled).toBe(true);
    expect(ci?.thresholds).toMatchObject({
      lines: 80,
      'src/components/ConsentDialog/**': { statements: 95, branches: 95, functions: 95, lines: 95 },
    });
    expect(testSettings({}).coverage?.enabled).toBe(false);
  });
});
