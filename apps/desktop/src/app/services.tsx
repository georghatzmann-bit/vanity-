import { createContext, use, useSyncExternalStore, type ReactNode } from 'react';
import type { ActivityEntry, ActivityLog } from '../activity/activityLog.ts';
import { PlatformProvider } from '../platform/PlatformContext.tsx';
import type { Platform } from '../platform/platform.ts';
import type { HashRouter } from '../router/hashRouter.ts';
import type { RouteId } from '../router/routes.ts';
import type { ReducedMotionController } from '../settings/reducedMotion.ts';
import type { SettingsSnapshot, SettingsStore } from '../settings/store.ts';

/** Alles, was die Oberfläche von außen braucht – in Tests vollständig ersetzbar. */
export interface AppServices {
  readonly platform: Platform;
  readonly settings: SettingsStore;
  readonly activity: ActivityLog;
  readonly router: HashRouter;
  readonly motion: ReducedMotionController;
}

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({
  services,
  children,
}: {
  readonly services: AppServices;
  readonly children: ReactNode;
}) {
  return (
    <ServicesContext value={services}>
      <PlatformProvider platform={services.platform}>{children}</PlatformProvider>
    </ServicesContext>
  );
}

export function useServices(): AppServices {
  const services = use(ServicesContext);
  if (services === null) {
    throw new Error('useServices: kein <ServicesProvider> vorhanden.');
  }
  return services;
}

export function useSettingsSnapshot(): SettingsSnapshot {
  const { settings } = useServices();
  return useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot);
}

export function useRoute(): RouteId {
  const { router } = useServices();
  return useSyncExternalStore(router.subscribe, router.getSnapshot, router.getSnapshot);
}

export function useActivity(): readonly ActivityEntry[] {
  const { activity } = useServices();
  return useSyncExternalStore(activity.subscribe, activity.getSnapshot, activity.getSnapshot);
}

export function useSystemReducedMotion(): boolean {
  const { motion } = useServices();
  return useSyncExternalStore(
    motion.subscribeSystem,
    motion.systemPrefersReduced,
    motion.systemPrefersReduced,
  );
}
