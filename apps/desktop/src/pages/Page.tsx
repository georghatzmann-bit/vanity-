import type { RouteId } from '../router/routes.ts';
import { AboutPage } from './AboutPage.tsx';
import { DashboardPage } from './DashboardPage.tsx';
import { ModulePage } from './ModulePage.tsx';
import { SettingsPage } from './SettingsPage.tsx';

/** Seite zur aktuellen Route. */
export function Page({ route }: { readonly route: RouteId }) {
  switch (route) {
    case 'dashboard':
      return <DashboardPage />;
    case 'settings':
      return <SettingsPage />;
    case 'about':
      return <AboutPage />;
    default:
      return <ModulePage route={route} />;
  }
}
