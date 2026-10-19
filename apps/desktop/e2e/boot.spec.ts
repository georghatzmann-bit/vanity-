import { expect, test } from '@playwright/test';
import {
  attachProbe,
  bootLayer,
  home,
  loadAllFontFaces,
  readProbe,
  required,
  waitForBootPhase,
  waitForHome,
} from './support.ts';

/** Messwert im Bericht festhalten (Annotation), damit Reserven sichtbar bleiben. */
function note(description: string): void {
  test.info().annotations.push({ type: 'Messwert', description });
}

/** Phasen, in denen die Animation noch läuft (vor dem Ausblenden). */
const RUNNING_PHASE = /^(?:idle|draw|inner|sweep|word)$/;
/**
 * Phasen, in denen die Animation sichtbar läuft. „draw“ wird erst nach dem Effekt-Durchlauf
 * gesetzt, der auch die Tasten-Handler der Start-Ebene registriert – vorher wäre ein
 * Tastendruck ein Wettlauf mit React.
 */
const ANIMATING_PHASE = /^(?:draw|inner|sweep|word)$/;

test.beforeEach(async ({ page }) => {
  await attachProbe(page);
});

test.describe('Start-Animation', () => {
  test('läuft vollständig und gibt die Startseite innerhalb von 3 s frei', async ({ page }) => {
    await page.goto('/');

    // Zuerst die Start-Ebene; die Startseite liegt darunter, ist aber gesperrt.
    await expect(bootLayer(page)).toBeVisible();
    await expect(home(page)).toHaveAttribute('data-state', 'booting');
    await expect(home(page)).toHaveAttribute('inert', '');
    await expect(home(page)).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByRole('heading', { name: 'AEGIS Suite' })).toHaveCount(0);

    await waitForHome(page, 3_000);
    await expect(bootLayer(page)).toHaveCount(0);

    const probe = await readProbe(page);
    const shownFor =
      required(probe.homeReadyAt, 'homeReadyAt') - required(probe.bootSeenAt, 'bootSeenAt');
    // Natürlicher Ablauf (≈ 1,5 s), nicht abgebrochen und deutlich unter 3 s.
    note(`Start-Animation sichtbar: ${shownFor.toFixed(0)} ms`);
    expect(shownFor).toBeGreaterThanOrEqual(1_450);
    expect(shownFor).toBeLessThan(3_000);
    expect(probe.bootReducedMotion).toBe('false');
    expect(probe.phases).toEqual(expect.arrayContaining(['draw', 'sweep', 'word', 'exit']));
    expect(probe.phases.indexOf('draw')).toBeLessThan(probe.phases.indexOf('exit'));

    // Startseite ist bedienbar: zugänglich, fokussiert, Statuszeile eingeblendet.
    await expect(home(page)).not.toHaveAttribute('inert');
    await expect(home(page)).not.toHaveAttribute('aria-hidden');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'AEGIS Suite' })).toBeFocused();
    await expect(page.getByTestId('home-status')).toHaveText('Fundament bereit · Phase P0');
    await expect(page.getByTestId('home-status')).toHaveCSS('opacity', '1');
  });

  test('Escape überspringt schnell (< 600 ms bis zur Startseite)', async ({ page }) => {
    await page.goto('/');
    await waitForBootPhase(page, ANIMATING_PHASE);

    await page.keyboard.press('Escape');
    await waitForHome(page);

    const probe = await readProbe(page);
    const escape = probe.keys.find((record) => record.key === 'Escape');
    expect(escape?.phase, 'Escape muss während der Animation gedrückt worden sein').toMatch(
      RUNNING_PHASE,
    );
    const readyAfter = required(probe.homeReadyAt, 'homeReadyAt') - (escape?.at ?? Number.NaN);
    note(`Escape → Startseite: ${readyAfter.toFixed(0)} ms (Phase ${escape?.phase ?? '?'})`);
    expect(readyAfter).toBeGreaterThanOrEqual(0);
    expect(readyAfter).toBeLessThan(600);
    // Abgebrochen statt zu Ende gelaufen: Die Ausblend-Phase des Zeitplans kam nie.
    expect(probe.phases).not.toContain('exit');
    await expect(page.getByRole('heading', { level: 1, name: 'AEGIS Suite' })).toBeFocused();
  });

  test('Überspringen-Button per Tastatur (Tab, dann Enter)', async ({ page }) => {
    await page.goto('/');
    await waitForBootPhase(page, ANIMATING_PHASE);

    await page.keyboard.press('Tab');
    const skip = page.getByRole('button', { name: 'Überspringen' });
    await expect(skip).toBeFocused();

    await page.keyboard.press('Enter');
    await waitForHome(page);

    const probe = await readProbe(page);
    const enter = probe.keys.find((record) => record.key === 'Enter');
    expect(enter?.phase, 'Enter muss während der Animation gedrückt worden sein').toMatch(
      RUNNING_PHASE,
    );
    const readyAfter = required(probe.homeReadyAt, 'homeReadyAt') - (enter?.at ?? Number.NaN);
    note(`Enter → Startseite: ${readyAfter.toFixed(0)} ms (Phase ${enter?.phase ?? '?'})`);
    expect(readyAfter).toBeGreaterThanOrEqual(0);
    expect(readyAfter).toBeLessThan(600);
    expect(probe.phases).not.toContain('exit');
    // Fokus landet danach in der Startseite, nicht im Nichts.
    await expect(page.getByRole('heading', { level: 1, name: 'AEGIS Suite' })).toBeFocused();
  });
});

test.describe('Bewegung reduzieren', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('statisches Logo, Startseite nach weniger als 800 ms', async ({ page }) => {
    await page.goto('/');
    await waitForHome(page);

    const probe = await readProbe(page);
    expect(probe.bootReducedMotion).toBe('true');
    // Kein Zeichnen, kein Lichtstreifen – nur die statische Variante.
    expect(probe.phases).toContain('static');
    expect(probe.phases).not.toContain('draw');
    expect(probe.phases).not.toContain('sweep');
    const shownFor =
      required(probe.homeReadyAt, 'homeReadyAt') - required(probe.bootSeenAt, 'bootSeenAt');
    note(`Start-Ebene (reduziert) sichtbar: ${shownFor.toFixed(0)} ms`);
    expect(shownFor).toBeLessThan(800);
    await expect(page.getByRole('heading', { level: 1, name: 'AEGIS Suite' })).toBeFocused();
  });
});

test.describe('Startseite', () => {
  test('Bildschirmfoto (Start-Animation und Startseite)', async ({ page }, testInfo) => {
    await page.goto('/');

    // Momentaufnahme mitten in der Animation (zur Sichtprüfung, ohne Bildvergleich).
    await waitForBootPhase(page, /^(?:word|exit)$/);
    const bootShot = testInfo.outputPath('boot.png');
    await page.screenshot({ path: bootShot });
    await testInfo.attach('start-animation', { path: bootShot, contentType: 'image/png' });

    await waitForHome(page);
    await expect(page.getByTestId('home-status')).toHaveCSS('opacity', '1');
    const fonts = await loadAllFontFaces(page);
    expect(fonts.filter((face) => !face.loaded)).toEqual([]);

    const homeShot = testInfo.outputPath('home.png');
    await page.screenshot({ path: homeShot, animations: 'disabled' });
    await testInfo.attach('startseite', { path: homeShot, contentType: 'image/png' });
  });
});
