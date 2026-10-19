import { describe, expect, it, vi } from 'vitest';
import { leakErrorCode, parseEmailResult, parseRange, pwnedCount, sha1Hex } from './leak.ts';

describe('Leck-Check', () => {
  it('SHA-1 wie erwartet', async () => {
    expect(await sha1Hex('password')).toBe('5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8');
  });

  it('gibt nur fünf Zeichen weiter und vergleicht lokal', async () => {
    const fetchRange = vi.fn((prefix: string) => {
      expect(prefix).toBe('5BAA6');
      return Promise.resolve([{ suffix: '1E4C9B93F3F0682250B6CF8331B7EE68FD8', count: 42 }]);
    });
    expect(await pwnedCount('password', fetchRange)).toBe(42);
    expect(fetchRange).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchRange.mock.calls)).not.toContain('password');
    expect(await pwnedCount('anderes', () => Promise.resolve([]))).toBe(0);
  });

  it('Parser verwerfen Unbrauchbares', () => {
    expect(
      parseRange([
        { suffix: '1E4C9B93F3F0682250B6CF8331B7EE68FD8', count: 1 },
        { suffix: 'kurz', count: 1 },
        { suffix: '1E4C9B93F3F0682250B6CF8331B7EE68FD8', count: 0 },
        null,
      ]),
    ).toHaveLength(1);
    expect(parseRange('x')).toEqual([]);
    const found = parseEmailResult({
      status: 'found',
      breaches: [
        { name: 'A', title: 'A-Shop', breach_date: '2020-01-01', data_classes: ['Passwords'] },
        { title: 'ohne Name' },
      ],
    });
    expect(found.status).toBe('found');
    expect(found.status === 'found' ? found.breaches : []).toHaveLength(1);
    expect(parseEmailResult({ status: 'not_found' })).toEqual({ status: 'not_found' });
    expect(parseEmailResult({ status: 'error', code: 'invalid_key' })).toEqual({
      status: 'error',
      code: 'invalid_key',
    });
    expect(parseEmailResult(null)).toEqual({ status: 'error', code: 'bad_response' });
    expect(leakErrorCode('rate_limited')).toBe('rate_limited');
    expect(leakErrorCode(new Error('x'))).toBe('unavailable');
  });
});
