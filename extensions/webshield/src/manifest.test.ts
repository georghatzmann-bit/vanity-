import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeDomain } from './lib/domains';
import { categoryFrom } from './lib/rules';

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8'));

interface Manifest {
  manifest_version: number;
  permissions: string[];
  host_permissions: string[];
  content_security_policy: { extension_pages: string };
  content_scripts: { matches: string[]; all_frames: boolean }[];
  web_accessible_resources: { resources: string[] }[];
  externally_connectable?: unknown;
  declarative_net_request: { rule_resources: { path: string }[] };
}

describe('Manifest', () => {
  const m = read('manifest.json') as Manifest;

  it('MV3 mit knappen Rechten', () => {
    expect(m.manifest_version).toBe(3);
    expect([...m.permissions].sort()).toEqual(
      [
        'alarms',
        'declarativeNetRequest',
        'downloads',
        'notifications',
        'storage',
        'webNavigation',
      ].sort(),
    );
    // Keine Rechte für Verlauf, Cookies, Tabs-Inhalte, Skripte einschleusen oder Native Messaging.
    for (const forbidden of [
      'history',
      'cookies',
      'tabs',
      'scripting',
      'nativeMessaging',
      'webRequest',
    ]) {
      expect(m.permissions).not.toContain(forbidden);
    }
    expect(m.externally_connectable).toBeUndefined();
  });

  it('kein fremder Code, Inhaltsskript nur im Hauptrahmen', () => {
    const csp = m.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe|https?:/);
    expect(m.content_scripts.every((c) => !c.all_frames)).toBe(true);
    expect(m.web_accessible_resources.flatMap((w) => w.resources)).not.toContain('options.html');
  });

  it('mitgelieferte Regeln sind gültig', () => {
    const [resource] = m.declarative_net_request.rule_resources;
    const rules = read(resource?.path ?? '') as {
      id: number;
      action: { type: string; redirect?: { extensionPath: string } };
      condition: { requestDomains: string[]; resourceTypes: string[] };
    }[];
    expect(rules.length).toBeGreaterThan(0);
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    let total = 0;
    for (const r of rules) {
      expect(r.action.type).toBe('redirect');
      const path = r.action.redirect?.extensionPath ?? '';
      expect(path.startsWith('/warn.html?')).toBe(true);
      expect(categoryFrom(path.slice('/warn.html'.length))).not.toBeNull();
      expect(r.condition.resourceTypes).toEqual(['main_frame']);
      for (const d of r.condition.requestDomains) {
        expect(normalizeDomain(d)).toBe(d);
      }
      total += r.condition.requestDomains.length;
    }
    expect(total).toBeGreaterThan(5000);
  });
});
