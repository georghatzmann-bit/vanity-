import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { disposeApps, fakePlatform, fakeVault, renderApp } from '../test/harness.tsx';

afterEach(() => disposeApps());

function withVault(vault: ReturnType<typeof fakeVault>, picked: readonly string[] = []) {
  const platform = fakePlatform('tauri', undefined, null, picked);
  Object.assign(platform, { vault });
  return platform;
}

describe('Tresor', () => {
  it('Vorschau: kein Tresor ohne App', async () => {
    renderApp({ platform: fakePlatform('browser'), hash: '#/vault' });
    expect(await screen.findByTestId('vault-preview')).toBeInTheDocument();
  });

  it('anlegen: Länge und Wiederholung werden geprüft', async () => {
    const vault = fakeVault({ exists: false });
    renderApp({ platform: withVault(vault), hash: '#/vault' });
    const form = await screen.findByTestId('vault-setup');
    const [first, second] = within(form).getAllByLabelText(/Master-Passwort/);
    fireEvent.change(first as HTMLElement, { target: { value: 'kurz' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Tresor anlegen' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Mindestens 12 Zeichen');
    fireEvent.change(first as HTMLElement, { target: { value: 'ein langes Master-Passwort' } });
    fireEvent.change(second as HTMLElement, { target: { value: 'ein anderes Passwort!' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Tresor anlegen' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('stimmen nicht');
    expect(vault.setup).not.toHaveBeenCalled();
    fireEvent.change(second as HTMLElement, { target: { value: 'ein langes Master-Passwort' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Tresor anlegen' }));
    expect(await screen.findByTestId('vault-main')).toBeInTheDocument();
    expect(vault.setup).toHaveBeenCalledWith('ein langes Master-Passwort');
  });

  it('entsperren: falsches Passwort, dann Liste ohne Passwörter', async () => {
    const vault = fakeVault();
    renderApp({ platform: withVault(vault), hash: '#/vault' });
    const form = await screen.findByTestId('vault-unlock');
    const field = within(form).getByLabelText('Master-Passwort');
    fireEvent.change(field, { target: { value: 'falsch' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Entsperren' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Falsches Master-Passwort');
    expect(field).toHaveValue('');
    fireEvent.change(field, { target: { value: 'ein langes Master-Passwort' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Entsperren' }));
    const rows = await screen.findAllByTestId('vault-entry');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Bank');
    expect(rows[0]).toHaveTextContent('mehrfach verwendet');
    // Kein Passwort sichtbar, bis „Anzeigen“ geklickt wird.
    expect(screen.queryByText('password')).toBeNull();
    expect(vault.reveal).not.toHaveBeenCalled();
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Anzeigen' }));
    expect(await within(rows[0] as HTMLElement).findByTestId('vault-shown')).toHaveTextContent(
      'password',
    );
    fireEvent.click(
      within(rows[0] as HTMLElement).getByRole('button', { name: 'Passwort kopieren' }),
    );
    expect(await screen.findByTestId('vault-notice')).toHaveTextContent('30 Sekunden');
    expect(vault.copy).toHaveBeenCalledWith('e1', 'password');
  });

  it('suchen, filtern, bearbeiten mit Generator, löschen mit Nachfrage', async () => {
    const vault = fakeVault({ unlocked: true });
    renderApp({ platform: withVault(vault), hash: '#/vault' });
    await screen.findAllByTestId('vault-entry');
    fireEvent.change(screen.getByLabelText('Suchen'), { target: { value: 'forum' } });
    await waitFor(() => expect(screen.getAllByTestId('vault-entry')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Suchen'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Neuer Eintrag' }));
    const editor = await screen.findByTestId('vault-editor');
    fireEvent.change(within(editor).getByLabelText('Titel'), { target: { value: 'Mail' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Erzeugen' }));
    expect(await within(editor).findByTestId('vault-strength')).toHaveTextContent('sehr stark');
    fireEvent.click(within(editor).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.getAllByTestId('vault-entry')).toHaveLength(3));
    expect(vault.entries.get('n1')?.password).toBe('Gen3riert!Sehr-Lang_2026');
    const forum = screen.getAllByTestId('vault-entry')[1] as HTMLElement;
    fireEvent.click(within(forum).getByRole('button', { name: 'Löschen …' }));
    expect(vault.remove).not.toHaveBeenCalled();
    fireEvent.click(within(forum).getByRole('button', { name: 'Ja, löschen' }));
    await waitFor(() => expect(screen.getAllByTestId('vault-entry')).toHaveLength(2));
    expect(vault.remove).toHaveBeenCalledWith('e2');
  });

  it('Leck-Check für alle markiert betroffene Einträge (nur Präfixe)', async () => {
    const vault = fakeVault({ unlocked: true });
    const platform = withVault(vault);
    renderApp({ platform, hash: '#/vault' });
    await screen.findAllByTestId('vault-entry');
    fireEvent.click(screen.getByRole('button', { name: 'Alle Passwörter auf Lecks prüfen' }));
    await waitFor(() =>
      expect(screen.getByTestId('vault-health')).toHaveTextContent('2 in Datenlecks'),
    );
    expect(platform.leakPasswordRange).toHaveBeenCalledWith('5BAA6');
    expect(
      JSON.stringify((platform.leakPasswordRange as unknown as { mock: unknown }).mock),
    ).not.toContain('password');
  });

  it('Import nur aus gewählter Datei; gesperrt → zurück zum Entsperren', async () => {
    const vault = fakeVault({ unlocked: true });
    renderApp({ platform: withVault(vault, ['C:\\Users\\a\\export.csv']), hash: '#/vault' });
    await screen.findAllByTestId('vault-entry');
    fireEvent.click(screen.getByRole('button', { name: 'CSV importieren …' }));
    expect(await screen.findByTestId('vault-notice')).toHaveTextContent('2 übernommen');
    expect(vault.importCsv).toHaveBeenCalledWith('C:\\Users\\a\\export.csv');
    fireEvent.click(screen.getByRole('button', { name: 'Sperren' }));
    expect(await screen.findByTestId('vault-unlock')).toBeInTheDocument();
  });
});
