import { isSoundEnabled, setSoundEnabled } from '@aegis/ui';
import { createActivityLog } from '../activity/activityLog.ts';
import { detectPlatform, type Platform } from '../platform/platform.ts';
import { createHashRouter } from '../router/hashRouter.ts';
import { installReducedMotionOverride } from '../settings/reducedMotion.ts';
import { browserStorage, createSettingsStore, type StorageLike } from '../settings/store.ts';
import type { AppServices } from './services.tsx';

export interface CreateServicesOptions {
  readonly window: Window;
  /** Standard: `localStorage` (falls zugänglich). */
  readonly storage?: StorageLike | null | undefined;
  /** Standard: passend zur Laufzeit (`detectPlatform()`). */
  readonly platform?: Platform | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * Baut die Dienste der Oberfläche und verbindet die Einstellungen mit der Außenwelt:
 * App-Vorgabe „Bewegung reduziert“ (für @aegis/ui und die Start-Animation) und den
 * Klang-Schalter von @aegis/ui. Beides wird sofort und bei jeder Änderung synchron gesetzt –
 * vor dem nächsten Rendern, damit z. B. die Start-Animation schon beim Einhängen stimmt.
 */
export function createAppServices(options: CreateServicesOptions): AppServices {
  const platform = options.platform ?? detectPlatform();
  const settings = createSettingsStore(
    options.storage === undefined ? browserStorage() : options.storage,
  );
  const motion = installReducedMotionOverride(options.window);
  const router = createHashRouter(options.window);
  const activity = createActivityLog(options.now);

  const syncOutside = (): void => {
    const current = settings.getSnapshot().settings;
    motion.setForced(current.motion === 'reduced');
    if (isSoundEnabled() !== current.sound) {
      setSoundEnabled(current.sound);
    }
  };
  syncOutside();
  settings.subscribe(syncOutside);

  activity.record({ kind: 'app-started', platform: platform.kind });
  return { platform, settings, activity, router, motion };
}
