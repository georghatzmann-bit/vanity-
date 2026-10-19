import { createContext, use, useMemo, type ReactNode } from 'react';
import { createTranslator, type Language, type Translator } from './translator.ts';

const I18nContext = createContext<Translator | null>(null);

export interface I18nProviderProps {
  readonly language: Language;
  /** Gebietsschema für Zahlen/Uhrzeiten (Standard je Sprache). */
  readonly locale?: string | undefined;
  readonly children: ReactNode;
}

/** Stellt die Übersetzung der aktiven Sprache bereit – ein Wechsel wirkt sofort. */
export function I18nProvider({ language, locale, children }: I18nProviderProps) {
  const translator = useMemo(() => createTranslator(language, locale), [language, locale]);
  return <I18nContext value={translator}>{children}</I18nContext>;
}

/** Übersetzung der aktiven Sprache: `const { t, tp } = useT();`. */
export function useT(): Translator {
  const translator = use(I18nContext);
  if (translator === null) {
    throw new Error('useT: kein <I18nProvider> vorhanden.');
  }
  return translator;
}
