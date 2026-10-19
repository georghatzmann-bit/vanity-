/**
 * Zwischenablage-Wächter (opt-in): schaltet ihn passend zur Einstellung ein oder aus und zeigt
 * eine Warnung, wenn eine kopierte Krypto-Adresse blitzschnell ausgetauscht wurde. Die
 * Zwischenablage wird nie verändert – der Nutzer entscheidet, was er einfügt.
 */
import { useToast } from '@aegis/ui';
import { useEffect } from 'react';
import { useServices, useSettingsSnapshot } from '../app/services.tsx';
import { useT } from '../i18n/I18nProvider.tsx';
import { listenWhileMounted } from '../platform/platform.ts';

export function useClipboardGuard(ready: boolean): void {
  const { platform } = useServices();
  const { settings } = useSettingsSnapshot();
  const { t } = useT();
  const toast = useToast();
  const enabled = settings.clipboardGuard;

  useEffect(() => {
    const set = platform.clipboardGuard;
    if (!ready || set === null) {
      return;
    }
    set(enabled).catch(() => undefined);
  }, [platform, ready, enabled]);

  useEffect(() => {
    if (!ready || !enabled) {
      return undefined;
    }
    return listenWhileMounted('clipboard-swap', () =>
      platform.onClipboardSwap((swap) => {
        toast.show({
          id: 'aegis-clipboard',
          tone: 'danger',
          title: t('devices.clipboard.alertTitle'),
          description: t('devices.clipboard.alert', {
            before: swap.before,
            after: swap.after,
            owner: swap.owner ?? t('devices.clipboard.unknownOwner'),
          }),
        });
      }),
    );
  }, [platform, ready, enabled, t, toast]);
}
