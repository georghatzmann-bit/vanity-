import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';

const dist = resolve(import.meta.dirname, '../dist');

/** Harmlose Testseiten; `?pw` liefert ein Passwortfeld. */
function page(url: string): string {
  const password = url.includes('pw') ? '<input type="password" aria-label="Passwort">' : '';
  return `<!doctype html><html lang="de"><head><title>Testseite</title></head><body><h1>Harmlose Testseite</h1>${password}</body></html>`;
}

interface Fixtures {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  port: number;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  port: async ({}, provide) => {
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(req.url ?? ''));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    await provide((server.address() as AddressInfo).port);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  },
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, provide) => {
    const profile = mkdtempSync(join(tmpdir(), 'aegis-webshield-'));
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
    await provide(context);
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  },
  worker: async ({ context }, provide) => {
    const [existing] = context.serviceWorkers();
    await provide(existing ?? (await context.waitForEvent('serviceworker')));
  },
  extensionId: async ({ worker }, provide) => {
    await provide(new URL(worker.url()).host);
  },
});

export const expect = test.expect;
