import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

interface Manifest {
  manifest_version: number;
  key: string;
  permissions: string[];
  host_permissions?: string[];
  optional_permissions?: string[];
  content_security_policy: { extension_pages: string };
  content_scripts: { matches: string[]; all_frames: boolean }[];
  web_accessible_resources?: unknown;
  externally_connectable?: unknown;
}

/** Erweiterungs-ID aus dem öffentlichen Schlüssel (SHA-256, erste 16 Bytes, Ziffern a–p). */
function extensionId(key: string): string {
  const hash = createHash('sha256').update(Buffer.from(key, 'base64')).digest();
  return [...hash.subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join('');
}

describe('Manifest', () => {
  const m = read('public/manifest.json') as Manifest;

  it('nur Native Messaging – kein Speicher, keine Tabs, keine Host-Rechte', () => {
    expect(m.manifest_version).toBe(3);
    expect(m.permissions).toEqual(['nativeMessaging']);
    expect(m.host_permissions).toBeUndefined();
    expect(m.optional_permissions).toBeUndefined();
    expect(m.externally_connectable).toBeUndefined();
    expect(m.web_accessible_resources).toBeUndefined();
  });

  it('kein fremder Code, Inhaltsskript nur im Hauptrahmen von Webseiten', () => {
    const csp = m.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe|https?:/);
    for (const c of m.content_scripts) {
      expect(c.all_frames).toBe(false);
      expect(c.matches.every((x) => /^https?:\/\/\*\/\*$/.test(x))).toBe(true);
    }
  });

  it('feste ID passt zum Host-Manifest und zum Host', () => {
    const id = extensionId(m.key);
    expect(id).toBe('mfhpbiifllddbcddpanidjedgmbglhon');
    const host = read('host/com.aegis.vault.json') as {
      name: string;
      type: string;
      allowed_origins: string[];
    };
    expect(host.name).toBe('com.aegis.vault');
    expect(host.type).toBe('stdio');
    expect(host.allowed_origins).toEqual([`chrome-extension://${id}/`]);
    const rust = readFileSync(
      new URL('../../../crates/vault-host/src/lib.rs', import.meta.url),
      'utf8',
    );
    expect(rust).toContain(`"${id}"`);
  });
});
