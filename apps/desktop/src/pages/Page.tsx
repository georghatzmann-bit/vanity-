import type { RouteId } from '../router/routes.ts';
import { AboutPage } from './AboutPage.tsx';
import { DashboardPage } from './DashboardPage.tsx';
import { DefenderPage } from './DefenderPage.tsx';
import { HardeningPage } from './HardeningPage.tsx';
import { LabPage } from './LabPage.tsx';
import { ModulePage } from './ModulePage.tsx';
import { NetworkPage } from './NetworkPage.tsx';
import { QuarantinePage } from './QuarantinePage.tsx';
import { RealtimePage } from './RealtimePage.tsx';
import { ReportsPage } from './ReportsPage.tsx';
import { SafePage } from './SafePage.tsx';
import { ScanPage } from './ScanPage.tsx';
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
    case 'scan':
      return <ScanPage />;
    case 'quarantine':
      return <QuarantinePage />;
    case 'realtime':
      return <RealtimePage />;
    case 'reports':
      return <ReportsPage />;
    case 'lab':
      return <LabPage />;
    case 'safe':
      return <SafePage />;
    case 'hardening':
      return <HardeningPage />;
    case 'network':
      return <NetworkPage />;
    case 'defender':
      return <DefenderPage />;
    default:
      return <ModulePage route={route} />;
  }
}
