/**
 * Hinweise des Echtzeit-Wächters, egal auf welcher Seite: neue Meldungen erscheinen als
 * Benachrichtigung mit „Anzeigen“. Die Benachrichtigung entscheidet nichts – Isolieren oder
 * Vertrauen gibt es nur auf der Wächter-Seite über den Freigabe-Dialog.
 */
import { useToast } from '@aegis/ui';
import { useEffect, useRef } from 'react';
import { useServices } from '../app/services.tsx';
import { useT } from '../i18n/I18nProvider.tsx';
import { WATCH_POLL_MS } from '../pages/RealtimePage.tsx';
import type { RouteId } from '../router/routes.ts';

export function useWatchNotifier(ready: boolean, route: RouteId): void {
  const { platform, router } = useServices();
  const { t } = useT();
  const toast = useToast();
  const lastSeq = useRef(0);
  const routeRef = useRef(route);
  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  useEffect(() => {
    const service = platform.service;
    if (!ready || service === null) {
      return undefined;
    }
    let active = true;
    const tick = () => {
      service.watchPoll(lastSeq.current).then(
        (state) => {
          if (!active || state.events.length === 0) {
            return;
          }
          lastSeq.current = Math.max(lastSeq.current, ...state.events.map((e) => e.seq));
          if (routeRef.current === 'realtime') {
            return; // Die Seite zeigt die Meldungen ohnehin.
          }
          const dangerous = state.events.some((e) => e.finding.risk === 'dangerous');
          toast.show({
            id: 'aegis-watch',
            tone: dangerous ? 'danger' : 'warn',
            title: t('realtime.toastTitle', { count: String(state.events.length) }),
            description: t('realtime.toastHint'),
            actions: [
              {
                label: t('realtime.toastShow'),
                onAction: () => router.navigate('realtime'),
                variant: 'primary',
              },
            ],
          });
        },
        () => undefined, // Dienst nicht erreichbar: die Seiten zeigen das selbst an.
      );
    };
    tick();
    const timer = window.setInterval(tick, WATCH_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [platform, router, ready, t, toast]);
}
