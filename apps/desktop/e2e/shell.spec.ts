import { expect, test, type Page } from '@playwright/test';
import {
  attachProbe,
  readProbe,
  readSettings,
  seedSettings,
  waitForBootPhase,
  waitForHome,
  waitForPageSettled,
} from './support.ts';

/** Alle Seiten in Reihenfolge der Seitenleiste (Beschriftung, Adresse, Phase). */
const pages = [
  { nav: 'Dashboard', route: 'dashboard', heading: 'Dashboard', phase: null },
  { nav: 'Berichte', route: 'reports', heading: 'Berichte', phase: null },
  { nav: 'Scan', route: 'scan', heading: 'Scan', phase: null },
  { nav: 'Echtzeit-Wächter', route: 'realtime', heading: 'Echtzeit-Wächter', phase: null },
  { nav: 'Quarantäne', route: 'quarantine', heading: 'Quarantäne', phase: null },
  { nav: 'Datei-Safe', route: 'safe', heading: 'Datei-Safe', phase: null },
  { nav: 'Labor', route: 'lab', heading: 'Labor', phase: null },
  { nav: 'Härtung', route: 'hardening', heading: 'Härtung', phase: 'P6' },
  { nav: 'Netzwerk', route: 'network', heading: 'Netzwerk', phase: 'P7' },
  { nav: 'Tresor', route: 'vault', heading: 'Tresor', phase: 'P9' },
  { nav: 'Tools', route: 'tools', heading: 'Tools', phase: 'P10' },
  { nav: 'Einstellungen', route: 'settings', heading: 'Einstellungen', phase: null },
  { nav: 'Über AEGIS', route: 'about', heading: 'Über AEGIS', phase: null },
] as const;

function navigation(page: Page) {
  return page.getByRole('navigation', { name: 'Hauptnavigation' });
}

function heading(page: Page) {
  return page.getByRole('heading', { level: 1 });
}

/** Fehler im Browser sammeln (Konsole, Seitenfehler) – am Ende muss die Liste leer sein. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      errors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

test.beforeEach(async ({ page }) => {
  await attachProbe(page);
});

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await seedSettings(page, { bootAnimation: false });
  });

  test('alle Seiten per Maus erreichbar, mit ehrlichem Platzhalter samt Phase', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForHome(page);
    await expect(page).toHaveURL(/#\/dashboard$/);

    for (const entry of pages) {
      await navigation(page)
        .getByRole('link', { name: new RegExp(`^${entry.nav}`) })
        .click();
      await expect(page).toHaveURL(new RegExp(`#/${entry.route}$`));
      await expect(heading(page)).toHaveText(entry.heading);
      await expect(
        navigation(page).getByRole('link', { name: new RegExp(`^${entry.nav}`) }),
      ).toHaveAttribute('aria-current', 'page');
      const placeholder = page.getByTestId('module-placeholder');
      if (entry.phase === null) {
        await expect(placeholder).toHaveCount(0);
      } else {
        await expect(placeholder).toHaveAttribute('data-phase', entry.phase);
        await expect(placeholder.getByText(`Folgt in ${entry.phase}`)).toBeVisible();
      }
    }
    expect((await readProbe(page)).cspViolations).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('alle Seiten per Tastatur: ein Tab-Stopp, Pfeiltasten, Enter, Fokus bleibt sichtbar', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForHome(page);
    await expect(heading(page)).toBeFocused();

    // Von der Überschrift rückwärts in die Navigation (ein Tab-Stopp: die aktive Seite).
    const dashboardLink = navigation(page).getByRole('link', { name: 'Dashboard' });
    await dashboardLink.focus();
    await expect(dashboardLink).toBeFocused();

    for (const [index, entry] of pages.entries()) {
      if (index > 0) {
        await page.keyboard.press('ArrowDown');
      }
      const link = navigation(page).getByRole('link', { name: new RegExp(`^${entry.nav}`) });
      await expect(link).toBeFocused();
      // Sichtbarer Fokusring (WCAG 2.4.7).
      expect(await link.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
        'solid',
      );
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`#/${entry.route}$`));
      await expect(heading(page)).toHaveText(entry.heading);
      // Der Fokus bleibt in der Navigation; die Seite wird angesagt.
      await expect(link).toBeFocused();
      await expect(page.getByTestId('route-announcement')).toHaveText(`Seite: ${entry.heading}`);
    }

    await page.keyboard.press('Home');
    await expect(dashboardLink).toBeFocused();
    await page.keyboard.press('End');
    await expect(navigation(page).getByRole('link', { name: 'Über AEGIS' })).toBeFocused();
  });

  test('Seitenwechsel außerhalb der Seitenleiste: Fokus auf die Überschrift, keine alte Ansage', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForHome(page);
    const announcement = page.getByTestId('route-announcement');
    const reports = navigation(page).getByRole('link', { name: /^Berichte/ });
    await reports.click();
    await expect(heading(page)).toHaveText('Berichte');
    await expect(reports).toBeFocused();
    await expect(announcement).toHaveText('Seite: Berichte');

    // Strg+, aus der Navigation heraus.
    await page.keyboard.press('Control+,');
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(heading(page)).toHaveText('Einstellungen');
    await expect(heading(page)).toBeFocused();
    await expect(announcement).toHaveText('');

    // Befehlspalette aus der Navigation heraus (sie gibt den Fokus erst zurück, dann navigiert sie).
    await navigation(page).getByRole('link', { name: 'Dashboard' }).focus();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Labor');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/lab$/);
    await expect(heading(page)).toHaveText('Labor');
    await expect(heading(page)).toBeFocused();

    // Zurück im Verlauf mit Fokus in der Navigation.
    await navigation(page)
      .getByRole('link', { name: /^Tresor/ })
      .click();
    await expect(heading(page)).toHaveText('Tresor');
    await expect(announcement).toHaveText('Seite: Tresor');
    await page.goBack();
    await expect(heading(page)).toHaveText('Labor');
    await expect(heading(page)).toBeFocused();
    await expect(announcement).toHaveText('');
  });

  test('Zurück und Vor im Verlauf wechseln die Seite', async ({ page }) => {
    await page.goto('/#/scan');
    await waitForHome(page);
    await expect(heading(page)).toHaveText('Scan');
    await navigation(page)
      .getByRole('link', { name: /^Tresor/ })
      .click();
    await expect(heading(page)).toHaveText('Tresor');
    await page.goBack();
    await expect(heading(page)).toHaveText('Scan');
    await page.goForward();
    await expect(heading(page)).toHaveText('Tresor');
  });

  test('unbekannte Adresse führt aufs Dashboard', async ({ page }) => {
    await page.goto('/#/gibt-es-nicht');
    await waitForHome(page);
    await expect(page).toHaveURL(/#\/dashboard$/);
    await expect(heading(page)).toHaveText('Dashboard');
  });

  test('Browser-Vorschau: keine Fensterknöpfe, ehrliches Abzeichen', async ({ page }) => {
    await page.goto('/');
    await waitForHome(page);
    await expect(page.getByTestId('preview-badge')).toHaveText(/Browser-Vorschau/);
    await expect(page.getByRole('group', { name: 'Fenster' })).toHaveCount(0);
  });

  test('Seitenleiste einklappen: nur Symbole, Namen als Tooltip, bleibt nach Neuladen', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForHome(page);
    await page.getByRole('button', { name: 'Navigation einklappen' }).click();
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'true');
    const hardening = navigation(page).getByRole('link', { name: 'Härtung, folgt in P6' });
    await hardening.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Härtung · Folgt in P6');
    await page.reload();
    await waitForHome(page);
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'true');
  });
});

test.describe('Befehlspalette', () => {
  test.beforeEach(async ({ page }) => {
    await seedSettings(page, { bootAnimation: false });
  });

  test('Strg+K öffnet, Suche + Enter navigiert, Fokus auf der Überschrift', async ({ page }) => {
    await page.goto('/');
    await waitForHome(page);
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Befehlspalette' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('combobox')).toBeFocused();
    await page.keyboard.type('quarant');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/#\/quarantine$/);
    await expect(heading(page)).toHaveText('Quarantäne');
    await expect(heading(page)).toBeFocused();
  });

  test('„/“ öffnet, Escape schließt und gibt den Fokus zurück', async ({ page }) => {
    await page.goto('/');
    await waitForHome(page);
    await page.keyboard.press('/');
    const dialog = page.getByRole('dialog', { name: 'Befehlspalette' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(heading(page)).toBeFocused();
  });

  test('Suchknopf der Titelleiste öffnet die Palette mit Kürzel-Hinweisen', async ({ page }) => {
    await page.goto('/');
    await waitForHome(page);
    await page.getByTestId('palette-trigger').click();
    const dialog = page.getByRole('dialog', { name: 'Befehlspalette' });
    await expect(dialog.getByRole('option', { name: /Einstellungen/ })).toContainText('Strg');
    await expect(dialog.getByRole('option', { name: /Notfall-Scan/ })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});

test.describe('Einstellungen bleiben erhalten', () => {
  test('Darstellung: Hell bleibt nach dem Neuladen', async ({ page }) => {
    await seedSettings(page, { bootAnimation: false });
    await page.goto('/#/settings');
    await waitForHome(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('radio', { name: 'Hell' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await readSettings(page)).toMatchObject({ theme: 'light' });

    await page.reload();
    await waitForHome(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByRole('radio', { name: 'Hell' })).toHaveAttribute('aria-checked', 'true');
  });

  test('Darstellung „System“ folgt dem Farbschema des Systems live', async ({ page }) => {
    await seedSettings(page, { bootAnimation: false, theme: 'system' });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await waitForHome(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('Sprache: Englisch per Palette, bleibt nach dem Neuladen', async ({ page }) => {
    await seedSettings(page, { bootAnimation: false });
    await page.goto('/');
    await waitForHome(page);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Sprache');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(await readSettings(page)).toMatchObject({ language: 'en' });

    await page.reload();
    await waitForHome(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(
      page.getByText('Not rated yet – the system checks are coming in P6.'),
    ).toBeVisible();
    await expect(page.getByTestId('honesty-kernel')).toContainText('AEGIS has no kernel driver.');
  });

  test('Bewegung „Reduziert“ schaltet die Start-Animation ab (statisch, < 800 ms)', async ({
    page,
  }) => {
    // System ohne Wunsch nach reduzierter Bewegung – nur die App-Einstellung zählt.
    await seedSettings(page, { bootAnimation: true, motion: 'reduced' });
    await page.goto('/');
    await waitForHome(page);
    const probe = await readProbe(page);
    expect(probe.bootReducedMotion).toBe('true');
    expect(probe.phases).toContain('static');
    expect(probe.phases).not.toContain('draw');
    expect(probe.phases).not.toContain('sweep');
    const shownFor = (probe.homeReadyAt ?? Number.NaN) - (probe.bootSeenAt ?? Number.NaN);
    expect(shownFor).toBeLessThan(800);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    // Auch CSS-Übergänge sind abgeschaltet.
    const duration = await page
      .getByRole('link', { name: 'Dashboard' })
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(duration).toBe('1e-05s');
  });

  test('Start-Animation aus: keine Start-Ebene beim nächsten Start; erneut abspielen geht', async ({
    page,
  }) => {
    await seedSettings(page, { bootAnimation: true });
    await page.goto('/#/settings');
    await waitForHome(page);
    await page.getByRole('switch', { name: 'Start-Animation beim Start zeigen' }).click();
    await page.reload();
    await waitForHome(page);
    expect((await readProbe(page)).bootSeenAt).toBeNull();

    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page.getByTestId('replay-boot').click();
    await waitForBootPhase(page, /^(?:draw|inner|sweep|word|exit)$/);
    await waitForHome(page);
    await expect(heading(page)).toBeFocused();
    await expect(page.getByTestId('activity-list')).toContainText('Start-Animation abgespielt');
  });
});

test.describe('Fehlerfreiheit', () => {
  test('alle Seiten in beiden Sprachen: keine Konsolenfehler, keine CSP-Verstöße', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await seedSettings(page, { bootAnimation: false });
    for (const language of ['de', 'en'] as const) {
      await page.goto('/#/settings');
      await waitForHome(page);
      await page.getByRole('radio', { name: language === 'de' ? 'Deutsch' : 'English' }).click();
      for (const entry of pages) {
        await page.goto(`/#/${entry.route}`);
        await waitForPageSettled(page);
      }
    }
    expect((await readProbe(page)).cspViolations).toEqual([]);
    expect(errors).toEqual([]);
  });
});
