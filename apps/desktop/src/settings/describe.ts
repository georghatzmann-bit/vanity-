import type { TextKey, Translator } from '../i18n/translator.ts';
import { settingValidators, type SettingKey, type Settings } from './schema.ts';

/** Beschriftung einer Einstellung (wie auf der Einstellungsseite). */
export const settingLabelKeys: Readonly<Record<SettingKey, TextKey>> = {
  language: 'settings.language.label',
  theme: 'settings.theme.label',
  sound: 'settings.sound.label',
  motion: 'settings.motion.label',
  bootAnimation: 'settings.boot.label',
  closeToTray: 'settings.closeToTray.label',
  sidebarCollapsed: 'nav.collapse',
};

/** Wert einer Einstellung als Text der aktiven Sprache, z. B. „Hell“ oder „an“. */
export function describeSettingValue(
  t: Translator['t'],
  key: SettingKey,
  value: Settings[SettingKey],
): string {
  if (typeof value === 'boolean') {
    return t(value ? 'settings.state.on' : 'settings.state.off');
  }
  if (key === 'language' && settingValidators.language(value)) {
    return t(`settings.language.${value}`);
  }
  if (key === 'theme' && settingValidators.theme(value)) {
    return t(`settings.theme.${value}`);
  }
  if (key === 'motion' && settingValidators.motion(value)) {
    return t(`settings.motion.${value}`);
  }
  return value;
}
