import { useToast } from '@aegis/ui';
import { useCallback } from 'react';
import { useT } from '../i18n/I18nProvider.tsx';
import type { SettingKey, Settings } from '../settings/schema.ts';
import { useServices } from './services.tsx';

/** Diese Felder sind Bedien-Komfort und erscheinen nicht in der Live-Aktivität. */
const quietSettings: ReadonlySet<SettingKey> = new Set(['sidebarCollapsed']);

/**
 * Ändert Einstellungen (wirkt sofort), vermerkt echte Änderungen in der Live-Aktivität und
 * meldet einmalig, wenn das Speichern ab jetzt nicht mehr klappt.
 */
export function useUpdateSettings(): (patch: Partial<Settings>) => void {
  const { settings, activity } = useServices();
  const toast = useToast();
  const { t } = useT();
  return useCallback(
    (patch: Partial<Settings>) => {
      const before = settings.getSnapshot().persistence;
      const { changed } = settings.update(patch);
      const after = settings.getSnapshot();
      for (const key of changed) {
        if (!quietSettings.has(key)) {
          activity.record({ kind: 'setting-changed', setting: key, value: after.settings[key] });
        }
      }
      if (changed.length > 0 && before === 'persistent' && after.persistence === 'memory-only') {
        activity.record({ kind: 'save-failed' });
        toast.show({
          id: 'settings-save-failed',
          tone: 'warn',
          title: t('settings.saveFailedToast'),
          description: t('settings.saveFailedToastDetail'),
        });
      }
    },
    [settings, activity, toast, t],
  );
}
