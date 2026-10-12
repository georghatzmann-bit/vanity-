import { useEffect, useRef } from "react";
import { api, errorText, listen } from "@/lib/api";
import { markDuplicates } from "@/lib/dedupe";
import { formatDuration } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLibrary } from "@/store/library";
import { useSettings } from "@/store/settings";
import { toast, useUI, type Page } from "@/store/ui";
import { useUpdate } from "@/store/update";
import { isTauri } from "@shared/lib/env";
import { sound } from "@shared/sound/engine";

const PAGES: Page[] = ["home", "library", "collections", "stats", "achievements", "wishlist", "cleanup"];

/** Globale Tastenkürzel */
export function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUI.getState();
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ui.setPalette(!ui.paletteOpen);
        return;
      }
      if (ui.bigPicture) return;
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        ui.navigate({ page: "library" });
        window.setTimeout(() => window.dispatchEvent(new Event("nova:focus-search")), 80);
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        ui.setDice(true);
        return;
      }
      if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        ui.setBigPicture(true);
        return;
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        ui.navigate({ page: "settings" });
        return;
      }
      if (mod && /^[1-7]$/.test(e.key)) {
        e.preventDefault();
        ui.navigate({ page: PAGES[Number(e.key) - 1] });
        return;
      }
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        ui.back();
        return;
      }
      // "/" fokussiert die Suche (wie in vielen Apps)
      if (!typing && e.key === "/") {
        e.preventDefault();
        ui.setPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Dateien per Drag & Drop ins Fenster ziehen */
export function useDragDrop() {
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      un = await getCurrentWebview().onDragDropEvent(async (ev) => {
        const ui = useUI.getState();
        const p = ev.payload;
        if (p.type === "enter" || p.type === "over") {
          if (!ui.dragging) ui.setDragging(true);
        } else if (p.type === "leave") {
          ui.setDragging(false);
        } else if (p.type === "drop") {
          ui.setDragging(false);
          if (!p.paths?.length) return;
          try {
            const entries = await api.inspectPaths(p.paths);
            const marked = markDuplicates(entries, useLibrary.getState().games);
            const fresh = marked.filter((m) => !m.duplicate).map((m) => m.entry);
            if (!fresh.length) {
              toast({ kind: "info", title: t("scan.nothingNew") });
              return;
            }
            const created = await useLibrary.getState().addEntries(fresh);
            toast({ kind: "success", title: t("scan.added", { n: created.length }) });
            if (created.length === 1) ui.navigate({ page: "game", id: created[0].id });
          } catch (e) {
            toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
          }
        }
      });
    });
    return () => un?.();
  }, []);
}

/** Pausen-Erinnerung: meldet sich nach X Minuten Spielzeit am Stück */
export function useBreakReminder() {
  const reminded = useRef(new Map<string, number>());
  useEffect(() => {
    const id = window.setInterval(() => {
      const { breakReminder, breakReminderMinutes, notifications } = useSettings.getState().settings;
      if (!breakReminder || breakReminderMinutes <= 0) return;
      const now = Date.now();
      const { running, games } = useLibrary.getState();
      for (const r of running.values()) {
        const mins = (now - r.startedAt) / 60000;
        const step = Math.floor(mins / breakReminderMinutes);
        const key = `${r.gameId}:${r.startedAt}`;
        if (step >= 1 && (reminded.current.get(key) ?? 0) < step) {
          reminded.current.set(key, step);
          const game = games.find((g) => g.id === r.gameId);
          const text = t("toast.breakText", { time: formatDuration(mins * 60) });
          toast({ kind: "warning", title: t("toast.breakTitle"), text: game ? `${game.name}: ${text}` : text, duration: 12000 });
          if (notifications && isTauri()) {
            void import("@tauri-apps/plugin-notification")
              .then(async (n) => {
                let ok = await n.isPermissionGranted();
                if (!ok) ok = (await n.requestPermission()) === "granted";
                if (ok) n.sendNotification({ title: t("toast.breakTitle"), body: text });
              })
              .catch(() => undefined);
          }
        }
      }
    }, 30000);
    return () => window.clearInterval(id);
  }, []);
}

/** Aufgaben nach dem Start: Auto-Scan, Update-Check, Tray-Aktionen */
export function useStartupTasks(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const timers: number[] = [];
    const s = useSettings.getState().settings;
    const lib = useLibrary.getState();

    if (s.scanOnStart && lib.games.length > 0) {
      timers.push(
        window.setTimeout(async () => {
          try {
            const res = await api.scanLibrary(s.scan);
            const marked = markDuplicates(res.entries, useLibrary.getState().games);
            // Automatisch nur Spiele aus Spiele-Launchern übernehmen (keine Startmenü-Flut)
            const fresh = marked.filter((m) => !m.duplicate && ["steam", "epic", "gog"].includes(m.entry.source)).map((m) => m.entry);
            if (fresh.length) {
              await useLibrary.getState().addEntries(fresh);
              toast({ kind: "success", title: t("scan.added", { n: fresh.length }), text: fresh.slice(0, 3).map((f) => f.name).join(", ") });
            }
          } catch (e) {
            console.warn("Auto-Scan:", e);
          }
        }, 4000),
      );
    }

    if (s.checkUpdates) {
      timers.push(
        window.setTimeout(async () => {
          const info = await useUpdate.getState().check();
          if (info?.available) {
            toast({
              kind: "info",
              title: t("toast.updateTitle"),
              text: t("toast.updateText", { v: info.latest ?? "" }),
              duration: 15000,
              action: { label: t("settings.updateInstall"), run: () => useUI.getState().navigate({ page: "settings", section: "about" }) },
            });
          }
        }, 9000),
      );
    }

    const uns: Array<() => void> = [];
    void listen<{ action: string }>("tray://action", ({ action }) => {
      const ui = useUI.getState();
      if (action === "bigpicture") ui.setBigPicture(true);
      if (action === "dice") ui.setDice(true);
    }).then((u) => uns.push(u));
    void listen("app://second-instance", () => {
      sound.play("notify");
    }).then((u) => uns.push(u));

    return () => {
      timers.forEach((x) => window.clearTimeout(x));
      uns.forEach((u) => u());
    };
  }, [ready]);
}
