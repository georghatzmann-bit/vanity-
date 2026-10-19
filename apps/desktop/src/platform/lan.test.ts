import { describe, expect, it } from 'vitest';
import { deviceKey, loadKnownDevices, parseLanReport, saveKnownDevices } from './lan.ts';

describe('Heimnetz-Ergebnis', () => {
  it('liest tolerant und verwirft Unbrauchbares', () => {
    const r = parseLanReport({
      available: true,
      network: '192.168.1.0/24',
      scanned: 253,
      devices: [
        {
          ip: '192.168.1.1',
          mac: 'AA:BB:CC:DD:EE:FF',
          gateway: true,
          open_ports: [23, -1, 'x', 70000],
        },
        { mac: 'ohne ip' },
        null,
      ],
      wifi: [{ ssid: 'Heim', security: 'wpa2' }, { ssid: 7 }],
      upnp: 'ja',
      hints: [
        { id: 'router_telnet', severity: 'danger', target: '192.168.1.1' },
        { id: 'x', severity: 'kritisch' },
      ],
    });
    expect(r.available).toBe(true);
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]?.openPorts).toEqual([23]);
    expect(r.devices[0]?.gateway).toBe(true);
    expect(r.wifi).toEqual([{ ssid: 'Heim', security: 'wpa2', tkip: false }]);
    expect(r.upnp).toBeNull();
    expect(r.hints).toHaveLength(1);
    expect(parseLanReport('Murks').available).toBe(false);
  });

  it('merkt bekannte Geräte robust', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    expect(loadKnownDevices(storage)).toBeNull();
    saveKnownDevices(storage, ['AA:BB:CC:DD:EE:FF', '192.168.1.5']);
    expect(loadKnownDevices(storage)).toEqual(new Set(['AA:BB:CC:DD:EE:FF', '192.168.1.5']));
    data.set('aegis.lan.known', '{kaputt');
    expect(loadKnownDevices(storage)).toBeNull();
    const failing = {
      setItem: () => {
        throw new Error('voll');
      },
    };
    expect(() => saveKnownDevices(failing, ['x'])).not.toThrow();
    expect(
      deviceKey({
        ip: '1.2.3.4',
        mac: null,
        privateMac: false,
        gateway: false,
        thisDevice: false,
        rttMs: null,
        openPorts: [],
      }),
    ).toBe('1.2.3.4');
  });
});
