import { useEffect } from "react";
import { api, errorText, listen } from "@/lib/api";
import { markDuplicates } from "@/lib/dedupe";
import { t } from "@/lib/i18n";
import { useBoost } from "@/store/boost";
import { useLibrary } from "@/store/library";
import { useNet } from "@/store/net";
import { useSettings } from "@/store/settings";
import { toast, useUI, type Page } from "@/store/ui";
import { useUpdate } from "@/store/update";
import { isTauri } from "@shared/lib/env";
import { sound } from "@shared/sound/engine";

const PAGES: Page[] = ["cockpit", "games", "network", "optimize", "reports", "settings"];

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
      if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        void useBoost.getState().toggle();
        return;
      }
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        ui.navigate({ page: "games" });
        window.setTimeout(() => window.dispatchEvent(new Event("pulsar:focus-search")), 80);
        return;
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        ui.navigate({ page: "settings" });
        return;
      }
      if (mod && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        ui.navigate({ page: PAGES[Number(e.key) - 1] });
        return;
      }
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        ui.back();
        return;
      }
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

/** PC-Auslastung und Verbindung regelmäßig aktualisieren */
export function useLiveStats(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const sys = window.setInterval(() => void useNet.getState().refreshSystem(), 2000);
    const con = window.setInterval(() => void useNet.getState().refreshConnection(), 20000);
    return () => {
      window.clearInterval(sys);
      window.clearInterval(con);
    };
  }, [ready]);
}

/** Aufgaben nach dem Start: Auto-Scan, Update-Check, Tray-Aktionen */
export function useStartupTasks(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const timers: number[] = [];
    const s = useSettings.getState().settings;
    const lib = useLibrary.getState();

    if (s.scanOnStartup && lib.games.length > 0) {
      timers.push(
        window.setTimeout(async () => {
          try {
            const res = await api.scanLibrary({ steam: true, epic: true, gog: true, startMenu: false, folders: [] });
            const marked = markDuplicates(res.entries, useLibrary.getState().games);
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

    const uns: Array<() => void> = [];
    void listen<{ action: string }>("tray://action", ({ action }) => {
      if (action === "boost") void useBoost.getState().toggle();
      if (action === "speedtest") useUI.getState().navigate({ page: "network", section: "speed" });
    }).then((u) => uns.push(u));
    void listen("app://second-instance", () => sound.play("notify")).then((u) => uns.push(u));

    return () => {
      timers.forEach((x) => window.clearTimeout(x));
      uns.forEach((u) => u());
    };
  }, [ready]);
}
