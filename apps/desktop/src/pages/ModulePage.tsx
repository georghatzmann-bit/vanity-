import { ComingSoon } from '@aegis/ui';
import { useT } from '../i18n/I18nProvider.tsx';
import type { TextKey } from '../i18n/translator.ts';
import { routePhases, type RouteId } from '../router/routes.ts';
import { routeIcons, titleKey, eyebrowKey } from '../shell/navigation.ts';
import { Blueprint } from './decor.tsx';
import { PageBody, PageHeader } from './PageHeader.tsx';

/** Seiten, die es erst in einer späteren Phase gibt. */
export type ModuleRouteId = Exclude<RouteId, 'dashboard' | 'settings' | 'about'>;

/** Module, die später etwas verändern könnten – dort erinnert die Seite an die Goldene Regel. */
const changesSomething: ReadonlySet<ModuleRouteId> = new Set([
  'scan',
  'quarantine',
  'hardening',
  'tools',
]);

/**
 * Ehrlicher Platzhalter eines Moduls: Phase aus docs/PROGRESS.md, ein bis zwei Sätze, was das
 * Modul tun wird – keine Beispiel- oder Schätzwerte.
 */
export function ModulePage({ route }: { readonly route: ModuleRouteId }) {
  const { t } = useT();
  const Icon = routeIcons[route];
  const phase = routePhases[route] ?? '';
  const note = changesSomething.has(route)
    ? `${t('placeholder.note')} ${t('placeholder.golden')}`
    : t('placeholder.note');

  return (
    <PageBody>
      <PageHeader eyebrow={t(eyebrowKey(route))} title={t(titleKey(route))} />
      <section
        aria-labelledby={`placeholder-${route}`}
        className="relative isolate overflow-hidden rounded-2xl border border-border bg-surface-1 shadow-bevel"
        data-testid="module-placeholder"
        data-phase={phase}
      >
        <Blueprint />
        <ComingSoon
          icon={<Icon />}
          phase={phase}
          formatPhase={(value) => t('phase.comingIn', { phase: value })}
          title={
            <span id={`placeholder-${route}`}>{t(`pages.${route}.tagline` satisfies TextKey)}</span>
          }
          description={t(`pages.${route}.summary` satisfies TextKey)}
          note={note}
        />
      </section>
    </PageBody>
  );
}
