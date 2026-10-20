import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, chromium, type BrowserContext } from '@playwright/test';

const dist = resolve(import.meta.dirname, '../dist');
export const EXTENSION_ID = 'mfhpbiifllddbcddpanidjedgmbglhon';

/** Harmlose Testseiten: Login-Formular, Formular im Unterrahmen, Seite ohne Passwortfeld. */
function page(url: string, port: number): string {
  if (url.startsWith('/frame')) {
    return `<!doctype html><html lang="de"><head><title>Rahmen</title></head><body><h1>Rahmen</h1><iframe title="Anmeldung" src="http://bank.test:${port}/login"></iframe></body></html>`;
  }
  if (url.startsWith('/plain')) {
    return '<!doctype html><html lang="de"><head><title>Ohne Formular</title></head><body><h1>Ohne Formular</h1></body></html>';
  }
  return `<!doctype html><html lang="de"><head><title>Anmeldung</title></head><body><main><h1>Harmlose Testanmeldung</h1>
<form><label>Benutzer <input id="u" type="email"></label><label>Passwort <input id="p" type="password"></label><button>Anmelden</button></form></main></body></html>`;
}

/**
 * Harmloser Native-Messaging-Host statt AEGIS: kennt nur einen erfundenen Login für
 * `http://bank.test:<port>` und schreibt jede Anfrage in ein Protokoll – so prüft der Test, dass
 * die Adresse vom Browser kommt.
 */
function fakeHost(dir: string, port: number): string {
  const log = join(dir, 'host.log');
  const script = join(dir, 'fake-host.mjs');
  writeFileSync(
    script,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const origin = 'http://bank.test:${port}';
let buf = Buffer.alloc(0);
function reply(o) {
  const body = Buffer.from(JSON.stringify(o));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([len, body]));
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) return;
    const msg = JSON.parse(buf.subarray(4, 4 + n).toString());
    buf = buf.subarray(4 + n);
    appendFileSync(${JSON.stringify(log)}, JSON.stringify(msg) + '\\n');
    if (msg.type === 'logins') {
      reply({ type: 'logins', logins: msg.origin === origin ? [{ id: 'a1', title: 'Testbank', username: 'anna@example.test' }] : [] });
    } else if (msg.type === 'fill') {
      reply(msg.origin === origin && msg.id === 'a1'
        ? { type: 'fill', username: 'anna@example.test', password: 'nur-ein-testwert' }
        : { type: 'error', code: 'no_match' });
    } else {
      reply({ type: 'error', code: 'invalid' });
    }
  }
});
`,
  );
  chmodSync(script, 0o755);
  return script;
}

interface Fixtures {
  port: number;
  profile: string;
  context: BrowserContext;
  hostLog: () => { type: string; origin?: string; id?: string }[];
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  port: async ({}, provide) => {
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(req.url ?? '', (server.address() as AddressInfo).port));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    await provide((server.address() as AddressInfo).port);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  },
  // eslint-disable-next-line no-empty-pattern
  profile: async ({}, provide) => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-vault-'));
    await provide(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  context: async ({ profile, port }, provide) => {
    // Chromium sucht Hosts des Nutzers im Profilordner unter NativeMessagingHosts/.
    const hosts = join(profile, 'NativeMessagingHosts');
    mkdirSync(hosts, { recursive: true });
    writeFileSync(
      join(hosts, 'com.aegis.vault.json'),
      JSON.stringify({
        name: 'com.aegis.vault',
        description: 'Test-Host',
        path: fakeHost(profile, port),
        type: 'stdio',
        allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
      }),
    );
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      locale: 'de-DE',
      args: [
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
        '--no-proxy-server',
        '--host-resolver-rules=MAP * 127.0.0.1',
      ],
    });
    const [existing] = context.serviceWorkers();
    const worker = existing ?? (await context.waitForEvent('serviceworker'));
    if (new URL(worker.url()).host !== EXTENSION_ID) {
      throw new Error('falsche Erweiterungs-ID');
    }
    await provide(context);
    await context.close();
  },
  hostLog: async ({ profile }, provide) => {
    await provide(() => {
      const file = join(profile, 'host.log');
      return existsSync(file)
        ? readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .filter((l) => l !== '')
            .map((l) => JSON.parse(l) as { type: string; origin?: string; id?: string })
        : [];
    });
  },
});

export const expect = test.expect;
