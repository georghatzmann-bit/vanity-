import { describe, expect, it } from 'vitest';
import { parseDefender } from './service.ts';

describe('Defender-Antwort', () => {
  it('liest Status, Möglichkeiten und Protokoll tolerant', () => {
    const state = parseDefender({
      type: 'defender',
      state: {
        status: {
          available: true,
          realtime: true,
          tamper: true,
          cloud: 'ja',
          running_mode: 'Normal',
          signature_age_days: 2,
          actions: { low: 9, moderate: 9, high: 9, severe: 9 },
          preferences: true,
        },
        admin: true,
        options: [
          ['realtime_off', 'tamper'],
          ['realtime_on', 'already_there'],
          ['report_only_on', 'erfunden'],
          ['firewall_off', null],
        ],
        log: [{ at: '2026-10-19T10:00:00Z', title: 'Microsoft Defender: …' }, 7],
      },
    });
    expect(state.status.realtime).toBe(true);
    expect(state.status.cloud).toBeNull();
    expect(state.status.reportOnly).toBe(true);
    expect(state.options.realtime_off).toBe('tamper');
    expect(state.options.report_only_on).toBe('unavailable');
    // Nicht gemeldete Änderungen gelten als nicht möglich.
    expect(state.options.report_only_off).toBe('unavailable');
    expect(state.log).toHaveLength(1);
    expect(() => parseDefender({ type: 'firewall' })).toThrow();
    const unread = parseDefender({ type: 'defender', state: { status: { available: true } } });
    expect(unread.status.reportOnly).toBeNull();
  });
});
