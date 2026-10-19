import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { join } from 'node:path';
import {
  attachProbe,
  readProbe,
  seedSettings,
  waitForHome,
  waitForPageSettled,
} from './support.ts';

/** Alle Seiten der App (Adresse = Dateiname des Bildschirmfotos). */
const routes = [
  'dashboard',
  'reports',
  'scan',
  'realtime',
  'quarantine',
  'lab',
  'hardening',
  'defender',
  'network',
  'vault',
  'tools',
  'settings',
  'about',
] as const;

const themes = ['dark', 'light'] as const;

/** WCAG 2.0/2.1/2.2 A + AA und bewährte Praktiken. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/** Prüft die Seite mit axe: keine ernsten/kritischen Verstöße; Rest als Hinweis im Bericht. */
async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  // Gegenprobe: axe hat wirklich geprüft (unter der CSP der App).
  expect(results.passes.length, label).toBeGreaterThan(10);
  const serious = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  for (const violation of results.violations) {
    test.info().annotations.push({
      type: `axe (${violation.impact ?? '?'})`,
      description: `${label}: ${violation.id} – ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
    });
  }
  expect(
    serious.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    })),
    label,
  ).toEqual([]);
  // Auch kleinere Verstöße sollen nicht unbemerkt bleiben.
  expect(
    results.violations.map((violation) => violation.id),
    `${label} (alle Schweregrade)`,
  ).toEqual([]);
}

/** Bildschirmfoto nach test-results/screens/<name>.png (zur Sichtprüfung, kein Bildvergleich). */
async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = join(testInfo.project.outputDir, 'screens', `${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test.beforeEach(async ({ page }) => {
  await attachProbe(page);
});

for (const theme of themes) {
  test.describe(`Barrierefreiheit und Bildschirmfotos – ${theme === 'dark' ? 'dunkel' : 'hell'}`, () => {
    test.beforeEach(async ({ page }) => {
      await seedSettings(page, { bootAnimation: false, theme });
    });

    test('jede Seite: axe ohne Verstöße, Bildschirmfoto', async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
          errors.push(message.text());
        }
      });
      page.on('pageerror', (error) => errors.push(error.message));

      await page.goto('/');
      await waitForHome(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const route of routes) {
        await page.goto(`/#/${route}`);
        await expect(
          page.getByTestId('main').locator(`[data-transition-key="${route}"]`),
        ).toBeVisible();
        await waitForPageSettled(page);
        await expectAccessible(page, `${route} (${theme})`);
        await screenshot(page, testInfo, `${route}-${theme}`);
      }
      expect((await readProbe(page)).cspViolations).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('Overlays: Befehlspalette, eingeklappte Navigation, Englisch', async ({
      page,
    }, testInfo) => {
      await page.goto('/');
      await waitForHome(page);

      await page.keyboard.press('Control+k');
      await expect(page.getByRole('dialog', { name: 'Befehlspalette' })).toBeVisible();
      await page.waitForTimeout(300);
      await expectAccessible(page, `palette (${theme})`);
      await screenshot(page, testInfo, `palette-${theme}`);
      await page.keyboard.type('hell');
      await expectAccessible(page, `palette-search (${theme})`);
      await page.keyboard.type('xyz-nichts');
      await expectAccessible(page, `palette-empty (${theme})`);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Navigation einklappen' }).click();
      await waitForPageSettled(page);
      await expectAccessible(page, `collapsed (${theme})`);
      await screenshot(page, testInfo, `collapsed-${theme}`);
      await page.getByRole('button', { name: 'Navigation ausklappen' }).click();

      await page.goto('/#/settings');
      await page.getByRole('radio', { name: 'English' }).click();
      await page.goto('/#/dashboard');
      await waitForPageSettled(page);
      await expectAccessible(page, `english (${theme})`);
      await screenshot(page, testInfo, `dashboard-en-${theme}`);
    });
  });
}

test.describe('Kleinstes Fenster (1024 × 680)', () => {
  test.use({ viewport: { width: 1024, height: 680 } });

  test('Dashboard und Einstellungen bleiben bedienbar, ohne waagerechtes Scrollen', async ({
    page,
  }, testInfo) => {
    await seedSettings(page, { bootAnimation: false });
    for (const route of ['dashboard', 'settings', 'scan'] as const) {
      await page.goto(`/#/${route}`);
      await waitForHome(page);
      await waitForPageSettled(page);
      const overflow = await page.evaluate(() => {
        const main = document.querySelector('[data-testid="main"]');
        return {
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          main: main === null ? -1 : main.scrollWidth - main.clientWidth,
        };
      });
      expect(overflow, route).toEqual({ document: 0, main: 0 });
      await expectAccessible(page, `${route} (1024)`);
      await screenshot(page, testInfo, `${route}-1024`);
    }
  });
});

test.describe('Bewegung reduzieren (System)', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('Dashboard ohne Animationen, axe ohne Verstöße', async ({ page }, testInfo) => {
    await seedSettings(page, { bootAnimation: false });
    await page.goto('/');
    await waitForHome(page);
    await waitForPageSettled(page);
    await expectAccessible(page, 'reduced-motion');
    await screenshot(page, testInfo, 'dashboard-reduced-motion');
  });
});
