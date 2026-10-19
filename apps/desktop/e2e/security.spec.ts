import { expect, test } from '@playwright/test';
import {
  attachProbe,
  expectedCsp,
  isLocalUrl,
  loadAllFontFaces,
  readProbe,
  waitForHome,
} from './support.ts';

test.beforeEach(async ({ page }) => {
  await attachProbe(page);
});

test.describe('Sicherheit und Datenschutz', () => {
  test('keine Konsolenfehler, keine Seitenfehler, keine CSP-Verstöße', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const response = await page.goto('/');
    // Die Vorschau sendet exakt die CSP aus tauri.conf.json.
    expect(response?.headers()['content-security-policy']).toBe(expectedCsp);

    await waitForHome(page);
    // Alle Schriftschnitte unter der CSP laden – auch selten genutzte Unicode-Bereiche,
    // damit z. B. eingebettete data:-Schriften (font-src 'self') auffallen würden.
    const fonts = await loadAllFontFaces(page);
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.filter((face) => !face.loaded)).toEqual([]);
    await page.waitForLoadState('networkidle');

    const probe = await readProbe(page);
    expect(probe.cspViolations).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('CSP greift wirklich: Inline-Skripte werden blockiert (Gegenprobe)', async ({ page }) => {
    await page.goto('/');
    await waitForHome(page);

    const executed = await page.evaluate(async () => {
      const scope = window as Window & { __aegisInlineRan?: boolean };
      const script = document.createElement('script');
      script.textContent = 'window.__aegisInlineRan = true;';
      document.head.append(script);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return scope.__aegisInlineRan === true;
    });
    expect(executed).toBe(false);

    await expect
      .poll(async () => (await readProbe(page)).cspViolations.map((v) => v.directive))
      .toContain('script-src-elem');
  });

  test('alle Anfragen bleiben lokal (keine CDNs, keine Telemetrie)', async ({ page }) => {
    const requests: string[] = [];
    const sockets: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    page.on('websocket', (socket) => sockets.push(socket.url()));

    await page.goto('/');
    await waitForHome(page);
    // Auch Schriften für seltene Zeichen anfordern, damit jede mögliche Quelle auftaucht.
    await loadAllFontFaces(page);
    await page.waitForLoadState('networkidle');

    expect(requests.length).toBeGreaterThan(1);
    expect(requests.filter((url) => !isLocalUrl(url))).toEqual([]);
    expect(sockets.filter((url) => !isLocalUrl(url))).toEqual([]);
  });
});
