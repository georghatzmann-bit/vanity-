import { expect, test } from '@playwright/test';
import { findInlineCode } from '../src/csp.ts';
import {
  attachProbe,
  expectedCsp,
  freezesPrototype,
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
    // Die Vorschau sendet die CSP aus tauri.conf.json (dieselben Direktiven wie Tauri).
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

  test('ausgeliefertes index.html (Build) enthält keinen Inline-Code', async ({ request }) => {
    // Tauri verarbeitet dist/index.html: Inline-Skripte oder <style> darin bekämen Hashes bzw.
    // Nonces und veränderten die CSP der App gegenüber der Vorschau.
    const response = await request.get('/');
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toMatch(/<script\b[^>]*\bsrc=/);
    expect(findInlineCode(html)).toEqual([]);
  });

  test('Object.prototype ist eingefroren wie im Tauri-Fenster (freezePrototype)', async ({
    page,
  }) => {
    expect(freezesPrototype).toBe(true);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto('/');
    await waitForHome(page);

    const result = await page.evaluate(() => {
      'use strict';
      const target: Record<string, unknown> = {};
      let assignmentThrew = false;
      try {
        target['toString'] = () => 'x';
      } catch (error) {
        assignmentThrew = error instanceof TypeError;
      }
      return { frozen: Object.isFrozen(Object.prototype), assignmentThrew };
    });
    // Nachgebildet wie in der App: Überschreiben geerbter Eigenschaften scheitert.
    expect(result).toEqual({ frozen: true, assignmentThrew: true });
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

  test('CSP blockiert eingeschleuste Stile (Schutz vor UI-Überlagerung)', async ({ page }) => {
    await page.goto('/');
    await waitForHome(page);

    // Wie eine HTML-Injektion über einen Dateinamen: <style>-Element und style-Attribut.
    const applied = await page.evaluate(async () => {
      const style = document.createElement('style');
      style.textContent = '#aegis-injected-a { visibility: hidden; }';
      document.head.append(style);
      const host = document.createElement('div');
      host.innerHTML =
        '<span id="aegis-injected-a">a</span><span id="aegis-injected-b" style="visibility: hidden">b</span>';
      document.body.append(host);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const visibility = (id: string): string => {
        const element = document.getElementById(id);
        return element === null ? 'fehlt' : getComputedStyle(element).visibility;
      };
      return { element: visibility('aegis-injected-a'), attribute: visibility('aegis-injected-b') };
    });
    expect(applied).toEqual({ element: 'visible', attribute: 'visible' });

    await expect
      .poll(async () => (await readProbe(page)).cspViolations.map((v) => v.directive).sort())
      .toEqual(expect.arrayContaining(['style-src-attr', 'style-src-elem']));
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
