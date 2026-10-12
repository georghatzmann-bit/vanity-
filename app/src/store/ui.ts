import { create } from "zustand";
import { emptyFilter, type LibraryFilter } from "@/lib/search";
import type { Game } from "@/lib/types";
import { sound } from "@shared/sound/engine";

export type Page = "home" | "library" | "game" | "collections" | "stats" | "achievements" | "wishlist" | "cleanup" | "settings";

export interface Route {
  page: Page;
  id?: string;
  /** Unterbereich, z. B. Einstellungs-Abschnitt */
  section?: string;
}

export type ToastKind = "success" | "error" | "info" | "game" | "warning";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  text?: string;
  duration?: number;
  action?: { label: string; run: () => void };
}

export interface ConfirmOptions {
  title: string;
  text?: string;
  confirmLabel?: string;
  danger?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

interface UIState {
  route: Route;
  history: Route[];
  navigate: (r: Route) => void;
  back: () => void;

  /** Spiel, dessen Farben/Cover gerade den Hintergrund bestimmen */
  focusGameId: string | null;
  setFocusGame: (id: string | null) => void;

  paletteOpen: boolean;
  setPalette: (open: boolean) => void;
  diceOpen: boolean;
  setDice: (open: boolean) => void;
  scanOpen: boolean;
  setScan: (open: boolean) => void;
  manualOpen: boolean;
  setManual: (open: boolean) => void;
  bigPicture: boolean;
  setBigPicture: (on: boolean) => void;
  introDone: boolean;
  setIntroDone: () => void;
  /** Logo ist von der Startanimation in die Titelleiste geflogen */
  logoDocked: boolean;
  setLogoDocked: (v: boolean) => void;

  ritual: Game | null;
  setRitual: (g: Game | null) => void;

  dragging: boolean;
  setDragging: (d: boolean) => void;

  libraryFilter: LibraryFilter;
  setFilter: (patch: Partial<LibraryFilter>) => void;
  resetFilter: () => void;

  toasts: Toast[];
  toast: (t: Omit<Toast, "id">) => number;
  dismiss: (id: number) => void;

  achievementQueue: string[];
  pushAchievements: (ids: string[]) => void;
  shiftAchievement: () => void;

  confirmState: ConfirmState | null;
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  closeConfirm: (ok: boolean) => void;
}

let toastId = 1;

export const useUI = create<UIState>((set, get) => ({
  route: { page: "home" },
  history: [],
  navigate: (r) => {
    const cur = get().route;
    if (cur.page === r.page && cur.id === r.id && cur.section === r.section) return;
    sound.play("switch");
    set({ route: r, history: [...get().history.slice(-30), cur] });
  },
  back: () => {
    const h = get().history;
    if (!h.length) return;
    sound.play("switch");
    set({ route: h[h.length - 1], history: h.slice(0, -1) });
  },

  focusGameId: null,
  setFocusGame: (id) => {
    if (get().focusGameId !== id) set({ focusGameId: id });
  },

  paletteOpen: false,
  setPalette: (open) => set({ paletteOpen: open }),
  diceOpen: false,
  setDice: (open) => set({ diceOpen: open }),
  scanOpen: false,
  setScan: (open) => set({ scanOpen: open }),
  manualOpen: false,
  setManual: (open) => set({ manualOpen: open }),
  bigPicture: false,
  setBigPicture: (on) => set({ bigPicture: on }),
  introDone: false,
  setIntroDone: () => set({ introDone: true }),
  logoDocked: false,
  setLogoDocked: (v) => set({ logoDocked: v }),

  ritual: null,
  setRitual: (g) => set({ ritual: g }),

  dragging: false,
  setDragging: (d) => set({ dragging: d }),

  libraryFilter: emptyFilter(),
  setFilter: (patch) => set({ libraryFilter: { ...get().libraryFilter, ...patch } }),
  resetFilter: () => set({ libraryFilter: emptyFilter() }),

  toasts: [],
  toast: (t) => {
    const id = toastId++;
    set({ toasts: [...get().toasts.slice(-4), { ...t, id }] });
    if (t.kind === "error") sound.play("error");
    else if (t.kind === "success") sound.play("success");
    else sound.play("notify");
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),

  achievementQueue: [],
  pushAchievements: (ids) => set({ achievementQueue: [...get().achievementQueue, ...ids] }),
  shiftAchievement: () => set({ achievementQueue: get().achievementQueue.slice(1) }),

  confirmState: null,
  confirm: (o) =>
    new Promise<boolean>((resolve) => {
      sound.play("open");
      set({ confirmState: { ...o, resolve } });
    }),
  closeConfirm: (ok) => {
    const c = get().confirmState;
    c?.resolve(ok);
    set({ confirmState: null });
  },
}));

/** Kurzform für Meldungen außerhalb von Komponenten */
export const toast = (t: Omit<Toast, "id">) => useUI.getState().toast(t);
export const confirmDialog = (o: ConfirmOptions) => useUI.getState().confirm(o);
