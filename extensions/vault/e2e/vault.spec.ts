import AxeBuilder from '@axe-core/playwright';
import { EXTENSION_ID, expect, test } from './fixtures';

test('Alt+↓ im Passwortfeld: Login wählen und ausfüllen – Adresse kommt vom Browser', async ({
  context,
  port,
  hostLog,
}) => {
  const page = await context.newPage();
  await page.goto(`http://bank.test:${port}/login`);
  await page.locator('#p').focus();
  await expect(page.locator('[data-hint]')).toHaveCount(1);
  expect(hostLog()).toEqual([]); // Fokus allein fragt AEGIS nicht.
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => hostLog().length).toBe(1);
  // Erst wenn die Liste da ist, liegt der Fokus im AEGIS-Menü (Wirt mit data-hint).
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-hint') ?? false))
    .toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('#p')).toHaveValue('nur-ein-testwert');
  await expect(page.locator('#u')).toHaveValue('anna@example.test');
  expect(hostLog()).toEqual([
    { type: 'logins', origin: `http://bank.test:${port}` },
    { type: 'fill', id: 'a1', origin: `http://bank.test:${port}` },
  ]);
});

test('Klick auf den Knopf öffnet das Menü; andere Seite bekommt keinen Login', async ({
  context,
  port,
  hostLog,
}) => {
  const page = await context.newPage();
  await page.goto(`http://andere.test:${port}/login`);
  await page.locator('#u').focus();
  const box = await page.locator('#p').boundingBox();
  expect(box).not.toBeNull();
  if (box === null) {
    return;
  }
  await page.mouse.click(box.x + box.width - 17, box.y + box.height / 2);
  await expect
    .poll(() => hostLog())
    .toEqual([{ type: 'logins', origin: `http://andere.test:${port}` }]);
  await expect(page.locator('#p')).toHaveValue('');
});

test('Seite kann nichts auslösen: synthetische Tasten und Unterrahmen bleiben ohne Abfrage', async ({
  context,
  port,
  hostLog,
}) => {
  const page = await context.newPage();
  await page.goto(`http://bank.test:${port}/login`);
  await page.evaluate(() => {
    const p = document.getElementById('p');
    p?.focus();
    p?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
    );
  });
  await page.goto(`http://boese.test:${port}/frame`);
  const frame = page.frameLocator('iframe');
  await frame.locator('#p').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await page.waitForTimeout(500);
  expect(hostLog()).toEqual([]);
  await expect(frame.locator('#p')).toHaveValue('');
});

test('Untergeschobene Klicks: durchsichtige oder veränderte Anzeige löst nichts aus', async ({
  context,
  port,
  hostLog,
}) => {
  const page = await context.newPage();
  await page.goto(`http://bank.test:${port}/login`);
  await page.locator('#p').focus();
  await expect(page.locator('[data-hint]')).toHaveCount(1);
  const box = await page.locator('#p').boundingBox();
  expect(box).not.toBeNull();
  if (box === null) {
    return;
  }
  // Seite macht alles fast unsichtbar und lässt den Nutzer „irgendwo“ klicken.
  await page.evaluate(() => {
    document.documentElement.style.opacity = '0.01';
  });
  await page.mouse.click(box.x + box.width - 17, box.y + box.height / 2);
  await page.waitForTimeout(300);
  expect(hostLog()).toEqual([]);
  // Seite verändert den Wirt der Anzeige → alles wird geschlossen.
  await page.evaluate(() => {
    document.documentElement.style.opacity = '';
    document.querySelector('[data-hint]')?.setAttribute('style', 'opacity:0');
  });
  await expect(page.locator('[data-hint]')).toHaveCount(0);
  await page.mouse.click(box.x + box.width - 17, box.y + box.height / 2);
  await page.waitForTimeout(300);
  expect(hostLog()).toEqual([]);
  await expect(page.locator('#p')).toHaveValue('');
});

test('Speichern? nach dem Anmelden: erst Prüfsumme, Klartext nur nach „Speichern“', async ({
  context,
  port,
  hostLog,
}) => {
  const page = await context.newPage();
  await page.goto(`http://bank.test:${port}/login`);
  await page.locator('#u').fill('bert@example.test');
  await page.locator('#p').fill('ein-neues-testpasswort');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect.poll(() => hostLog().map((m) => m.type)).toEqual(['check']);
  const [check] = hostLog();
  expect(check?.username).toBe('bert@example.test');
  expect(check?.origin).toBe(`http://bank.test:${port}`);
  expect(JSON.stringify(hostLog())).not.toContain('ein-neues-testpasswort');
  // Die Frage erscheint auf der Folgeseite; per Tastatur hinein und „Speichern“.
  await expect(page.locator('[data-hint]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Anmelden' }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect.poll(() => hostLog().map((m) => m.type)).toEqual(['check', 'save']);
  expect(hostLog()[1]).toEqual({
    type: 'save',
    origin: `http://bank.test:${port}`,
    username: 'bert@example.test',
    password: 'ein-neues-testpasswort',
    id: null,
  });
});

test('Schon gespeicherter Login: keine Frage', async ({ context, port, hostLog }) => {
  const page = await context.newPage();
  await page.goto(`http://bank.test:${port}/login`);
  await page.locator('#u').fill('anna@example.test');
  await page.locator('#p').fill('nur-ein-testwert');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect.poll(() => hostLog().map((m) => m.type)).toEqual(['check']);
  await page.waitForTimeout(1500);
  await expect(page.locator('[data-hint]')).toHaveCount(0);
});

test('Popup ohne Webseite erklärt ehrlich und ist barrierefrei', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  await expect(page.getByRole('heading', { name: 'AEGIS Tresor' })).toBeVisible();
  await expect(
    page.getByText('Auf dieser Seite kann die Erweiterung nicht ausfüllen'),
  ).toBeVisible();
  await expect(page.getByText('Die Erweiterung speichert nichts')).toBeVisible();
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations).toEqual([]);
});
