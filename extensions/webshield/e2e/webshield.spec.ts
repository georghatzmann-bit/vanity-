import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';

/** Eine Domain aus der mitgelieferten Liste (wird nur auf 127.0.0.1 aufgelöst). */
function bundledDomain(category: string): string {
  const rules = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../public/rules/bundled.json'), 'utf8'),
  ) as {
    action: { redirect: { extensionPath: string } };
    condition: { requestDomains: string[] };
  }[];
  const rule = rules.find((r) => r.action.redirect.extensionPath.endsWith(`c=${category}`));
  const domain = rule?.condition.requestDomains[0];
  if (domain === undefined) {
    throw new Error(`keine Domain für ${category}`);
  }
  return domain;
}

test('gelistete Seite landet auf der Warnseite, Freigabe nur nach Bestätigung', async ({
  context,
  extensionId,
  port,
}) => {
  const domain = bundledDomain('scam');
  const page = await context.newPage();
  await page.goto(`http://${domain}:${port}/start`);
  await expect(page).toHaveURL(
    new RegExp(`^chrome-extension://${extensionId}/warn\\.html\\?c=scam`),
  );
  await expect(page.getByRole('heading', { name: 'Diese Seite wurde angehalten' })).toBeVisible();
  await expect(page.getByText(domain, { exact: true })).toBeVisible();
  await expect(page.getByText(/Betrug/)).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);

  const open = page.getByRole('button', { name: /Trotzdem öffnen/ });
  await expect(open).toBeDisabled();
  await page.getByLabel(/Ich verstehe das Risiko/).check();
  await open.click();
  await expect(page).toHaveURL(`http://${domain}:${port}/start`);
  await expect(page.getByRole('heading', { name: 'Harmlose Testseite' })).toBeVisible();
});

test('dynamische Regel (Phishing) greift, normale Seiten bleiben frei', async ({
  context,
  worker,
  port,
}) => {
  await worker.evaluate(async () => {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [
        {
          id: 1000,
          priority: 1,
          action: {
            type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
            redirect: { extensionPath: '/warn.html?c=phishing' },
          },
          condition: {
            requestDomains: ['phish.test'],
            resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
          },
        },
      ],
    });
  });
  const page = await context.newPage();
  await page.goto(`http://login.phish.test:${port}/`);
  await expect(page.getByText(/Phishing/)).toBeVisible();
  await page.goto(`http://harmlos.test:${port}/`);
  await expect(page.getByRole('heading', { name: 'Harmlose Testseite' })).toBeVisible();
});

test('Hinweis bei Markennamen in fremder Domain mit Passwortfeld', async ({ context, port }) => {
  const page = await context.newPage();
  await page.goto(`http://paypal-konto.test:${port}/?pw`);
  await expect(page.locator('aegis-webshield-hint')).toHaveCount(1);
  await page.goto(`http://harmlos.test:${port}/`);
  await page.waitForLoadState('load');
  await page.waitForTimeout(300);
  await expect(page.locator('aegis-webshield-hint')).toHaveCount(0);
});

test('Optionen: Schalter bleiben gespeichert, Fehler beim Laden ehrlich angezeigt', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.getByRole('heading', { name: 'AEGIS Web-Schutz' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);

  const hints = page.getByLabel('Hinweise bei riskanten Downloads');
  await expect(hints).toBeChecked();
  await hints.uncheck();
  await page.reload();
  await expect(page.getByLabel('Hinweise bei riskanten Downloads')).not.toBeChecked();

  // Netz ist im Test auf 127.0.0.1 umgebogen: alle Quellen scheitern, nichts wird gelöscht.
  await page.getByRole('button', { name: 'Jetzt aktualisieren' }).click();
  await expect(page.getByText(/nicht erreichbar/)).toHaveCount(3, { timeout: 30_000 });
});
