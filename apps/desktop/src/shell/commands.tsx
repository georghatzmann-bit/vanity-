import {
  IconMoon,
  IconPanic,
  IconPlay,
  IconSliders,
  IconSoundOff,
  IconSoundOn,
  IconSun,
  IconGlobe,
  type CommandItem,
} from '@aegis/ui';
import { de } from '../i18n/de.ts';
import { en } from '../i18n/en.ts';
import type { Translator } from '../i18n/translator.ts';
import type { RouteId } from '../router/routes.ts';
import { routePhases } from '../router/routes.ts';
import type { EffectivePreferences } from '../settings/preferences.ts';
import type { Settings } from '../settings/schema.ts';
import { navGroups, navLabelKey, routeIcons } from './navigation.ts';
import { requestEmergencyScan } from '../pages/emergencyRequest.ts';
import { modifierKeys } from './shortcuts.ts';

export interface CommandContext {
  readonly t: Translator['t'];
  readonly settings: Settings;
  readonly preferences: EffectivePreferences;
  readonly navigate: (route: RouteId) => void;
  readonly update: (patch: Partial<Settings>) => void;
  readonly replayBoot: () => void;
}

/** Suchbegriffe in beiden Sprachen, damit „settings“ auch auf Deutsch trifft. */
function pageKeywords(route: RouteId): string[] {
  return [
    route,
    de.pages[route].nav,
    en.pages[route].nav,
    de.pages[route].title,
    en.pages[route].title,
  ];
}

/**
 * Einträge der Befehlspalette: alle Seiten und die Schnellschalter (Darstellung, Sprache,
 * Klang, Bewegung, Start-Animation). Beschriftungen zeigen, was der Eintrag *bewirkt*.
 */
export function buildCommands(context: CommandContext): CommandItem[] {
  const { t, settings, preferences, navigate, update, replayBoot } = context;
  const pagesGroup = t('palette.groups.pages');
  const actionsGroup = t('palette.groups.actions');

  const pages = navGroups.flatMap((group) =>
    group.routes.map((route): CommandItem => {
      const Icon = routeIcons[route];
      const phase = routePhases[route];
      return {
        id: `page-${route}`,
        label: t(navLabelKey(route)),
        group: pagesGroup,
        keywords: pageKeywords(route),
        icon: <Icon />,
        hint: phase === undefined ? undefined : t('phase.comingIn', { phase }),
        shortcut: route === 'settings' ? modifierKeys(t, ',') : undefined,
        onSelect: () => navigate(route),
      };
    }),
  );

  const toLight = preferences.colorScheme === 'dark';
  const toEnglish = preferences.language === 'de';
  const actions: CommandItem[] = [
    {
      id: 'action-theme',
      label: toLight ? t('palette.themeToLight') : t('palette.themeToDark'),
      group: actionsGroup,
      keywords: ['theme', 'darstellung', 'hell', 'dunkel', 'light', 'dark', 'farbschema'],
      icon: toLight ? <IconSun /> : <IconMoon />,
      onSelect: () => update({ theme: toLight ? 'light' : 'dark' }),
    },
    {
      id: 'action-language',
      label: t('palette.languageSwitch'),
      group: actionsGroup,
      keywords: ['language', 'sprache', 'english', 'englisch', 'deutsch', 'german'],
      icon: <IconGlobe />,
      onSelect: () => update({ language: toEnglish ? 'en' : 'de' }),
    },
    {
      id: 'action-sound',
      label: settings.sound ? t('palette.soundOff') : t('palette.soundOn'),
      group: actionsGroup,
      keywords: ['sound', 'klang', 'ton', 'stumm', 'mute', 'audio'],
      icon: settings.sound ? <IconSoundOff /> : <IconSoundOn />,
      onSelect: () => update({ sound: !settings.sound }),
    },
    {
      id: 'action-motion',
      label: settings.motion === 'reduced' ? t('palette.motionSystem') : t('palette.motionReduce'),
      group: actionsGroup,
      keywords: ['motion', 'bewegung', 'animation', 'reduziert', 'reduce'],
      icon: <IconSliders />,
      onSelect: () => update({ motion: settings.motion === 'reduced' ? 'system' : 'reduced' }),
    },
    {
      id: 'action-boot',
      label: t('palette.replayBoot'),
      group: actionsGroup,
      keywords: ['boot', 'start', 'logo', 'intro', 'animation'],
      icon: <IconPlay />,
      onSelect: replayBoot,
    },
    {
      id: 'action-emergency',
      label: t('palette.emergency'),
      group: actionsGroup,
      keywords: ['panic', 'notfall', 'emergency', 'scan'],
      icon: <IconPanic />,
      onSelect: requestEmergencyScan,
    },
  ];
  return [...pages, ...actions];
}
