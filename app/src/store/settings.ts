import { create } from "zustand";
import { api } from "@/lib/api";
import { defaultSettings, mergeSettings } from "@/lib/defaults";
import { setLanguage } from "@/lib/i18n";
import { applyAppearance } from "@/lib/theme";
import type { Settings } from "@/lib/types";
import { sound } from "@shared/sound/engine";
import { isTauri } from "@shared/lib/env";

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<Settings>) => void;
}

let saveTimer: number | undefined;

/** Wirkt Einstellungen sofort auf Oberfläche, Sound und Sprache aus */
function applyLocal(s: Settings) {
  applyAppearance(s.theme, s.accent, s.motion);
  sound.setVolume(s.soundVolume);
  sound.setMuted(s.soundMuted);
  sound.setHoverEnabled(s.hoverSounds);
  setLanguage(s.language);
}

const NATIVE_KEYS: (keyof Settings)[] = ["closeToTray", "overlayShortcut", "minimizeOnLaunch", "language"];

async function applyNative(s: Settings) {
  try {
    await api.applyNativeSettings({ closeToTray: s.closeToTray, overlayShortcut: s.overlayShortcut, minimizeOnLaunch: s.minimizeOnLaunch, language: s.language });
  } catch (e) {
    console.warn("Native Einstellungen:", e);
    throw e;
  }
}

async function applyAutostart(enabled: boolean) {
  if (!isTauri()) return;
  try {
    const m = await import("@tauri-apps/plugin-autostart");
    const on = await m.isEnabled();
    if (enabled && !on) await m.enable();
    if (!enabled && on) await m.disable();
  } catch (e) {
    console.warn("Autostart:", e);
  }
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: defaultSettings(),
  loaded: false,
  load: async () => {
    let stored: Partial<Settings> | null = null;
    try {
      stored = await api.kvGet<Partial<Settings>>("settings");
    } catch (e) {
      console.warn("Einstellungen konnten nicht geladen werden, nutze Standardwerte:", e);
    }
    const s = mergeSettings(stored);
    applyLocal(s);
    set({ settings: s, loaded: true });
    void applyNative(s).catch(() => undefined);
    void applyAutostart(s.autostart);
  },
  update: (patch) => {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    applyLocal(next);
    if (NATIVE_KEYS.some((k) => k in patch)) {
      void applyNative(next).catch((e) => {
        // z. B. ungültiges Tastenkürzel: Meldung zeigen, alten Wert behalten
        void import("./ui").then(({ toast }) => toast({ kind: "error", title: String(e instanceof Error ? e.message : e) }));
      });
    }
    if ("autostart" in patch) void applyAutostart(next.autostart);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void api.kvSet("settings", get().settings).catch((e) => console.warn("Einstellungen speichern:", e));
    }, 350);
  },
}));
