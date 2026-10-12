import { useSyncExternalStore } from "react";
import { de, type Dict } from "../locales/de";
import { en } from "../locales/en";
import type { Language } from "./types";

const dicts: Record<Language, Dict> = { de, en };
let lang: Language = detectLanguage();
const listeners = new Set<() => void>();

export function detectLanguage(): Language {
  if (typeof navigator === "undefined") return "de";
  return navigator.language?.toLowerCase().startsWith("de") ? "de" : "en";
}

export function setLanguage(l: Language) {
  if (l === lang) return;
  lang = l;
  document.documentElement.lang = l;
  listeners.forEach((fn) => fn());
}

export function getLanguage(): Language {
  return lang;
}

function lookup(dict: unknown, key: string): string | undefined {
  let cur: unknown = dict;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

/** Übersetzt einen Schlüssel wie "home.continue" und ersetzt {platzhalter}. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const raw = lookup(dicts[lang], key) ?? lookup(dicts.de, key) ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}

/** Hook: rendert neu, wenn die Sprache wechselt */
export function useT() {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lang,
    () => lang,
  );
  return t;
}

export function useLanguage(): Language {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lang,
    () => lang,
  );
}
