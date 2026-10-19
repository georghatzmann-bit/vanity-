export { de } from './de.ts';
export { en } from './en.ts';
export { I18nProvider, useT, type I18nProviderProps } from './I18nProvider.tsx';
export {
  catalogs,
  createTranslator,
  detectLanguage,
  flattenMessages,
  interpolate,
  isPluralMessage,
  languages,
  localeFor,
  placeholdersOf,
  type Language,
  type PluralKey,
  type TextKey,
  type Translator,
} from './translator.ts';
export type { MessageParams, MessageTree, Messages, PluralMessage } from './types.ts';
