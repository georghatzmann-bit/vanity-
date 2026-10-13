import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { motion } from "motion/react";
import { X } from "lucide-react";
import "@fontsource-variable/inter";
import "@fontsource-variable/sora";
import "../styles/app.css";
import { api, listen } from "@/lib/api";
import { mergeSettings } from "@/lib/defaults";
import { formatTime } from "@/lib/format";
import { gradeColor, pingColor, pingGrade } from "@/lib/grade";
import { setLanguage, useT } from "@/lib/i18n";
import { applyAppearance } from "@/lib/theme";
import type { Corner, MonitorUpdate, OverlayItem, PingStats, Settings, SystemStats } from "@/lib/types";
import { useNow } from "@/hooks/useNow";
import { PulsarLogo } from "@shared/ui/PulsarLogo";
import { cn } from "@shared/lib/cn";
import { isTauri } from "@shared/lib/env";

async function hide() {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().hide();
}

/** Fenster in die gewünschte Bildschirmecke schieben */
async function placeInCorner(corner: Corner) {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow, currentMonitor, PhysicalPosition } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const mon = await currentMonitor();
    if (!mon) return;
    const size = await win.outerSize();
    const pad = Math.round(16 * mon.scaleFactor);
    const x = corner.endsWith("l") ? mon.position.x + pad : mon.position.x + mon.size.width - size.width - pad;
    const y = corner.startsWith("t") ? mon.position.y + pad : mon.position.y + mon.size.height - size.height - pad - Math.round(48 * mon.scaleFactor);
    await win.setPosition(new PhysicalPosition(x, y));
  } catch {
    /* Position ist Komfort, kein Muss */
  }
}

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
      <motion.div className="h-full rounded-full" style={{ background: color }} animate={{ width: `${Math.max(0, Math.min(100, value))}%` }} transition={{ duration: 0.4 }} />
    </div>
  );
}

/** In-Game-Overlay: Ping groß, Rest klein – immer im Vordergrund, durchsichtig */
function Overlay() {
  const t = useT();
  const now = useNow(1000);
  const [settings, setSettings] = useState<Settings>(() => mergeSettings(null));
  const [stats, setStats] = useState<PingStats | null>(null);
  const [lastAt, setLastAt] = useState(0);
  const [sys, setSys] = useState<SystemStats | null>(null);

  // Einstellungen (Theme, Werte, Ecke, Deckkraft) regelmäßig nachladen
  useEffect(() => {
    let alive = true;
    let lastCorner: Corner | null = null;
    const load = async () => {
      try {
        const st = mergeSettings(await api.kvGet<Partial<Settings>>("settings"));
        if (!alive) return;
        applyAppearance(st.theme, st.accent, st.motion);
        setLanguage(st.language);
        setSettings(st);
        if (st.overlayCorner !== lastCorner) {
          lastCorner = st.overlayCorner;
          void placeInCorner(st.overlayCorner);
        }
      } catch {
        /* Standardwerte bleiben */
      }
    };
    void load();
    const id = window.setInterval(load, 5000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && void hide();
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Live-Ping vom Hauptfenster-Monitor (Ereignis geht an alle Fenster)
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen<MonitorUpdate>("net://ping", (u) => {
      const s = u.stats[0];
      if (s) {
        setStats(s);
        setLastAt(Date.now());
      }
    }).then((u) => (off = u));
    return () => off?.();
  }, []);

  // PC-Auslastung alle 2 Sekunden
  useEffect(() => {
    const wants = settings.overlayItems.some((i) => i === "cpu" || i === "gpu" || i === "ram");
    if (!wants) return;
    let alive = true;
    const tick = () => void api.systemStats().then((s) => alive && setSys(s)).catch(() => undefined);
    tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [settings.overlayItems]);

  const stale = Date.now() - lastAt > 5000;
  const live = stats && !stale ? stats : null;
  const grade = live ? pingGrade(live.avg, live.jitter, live.loss) : null;
  const color = grade ? gradeColor(grade) : "var(--nv-muted)";
  const items = settings.overlayItems;
  const has = (i: OverlayItem) => items.includes(i);
  const ram = sys ? (sys.ramUsed / Math.max(1, sys.ramTotal)) * 100 : null;

  return (
    <motion.div
      data-tauri-drag-region
      className="glass-strong group m-2 flex h-[calc(100%-16px)] flex-col justify-between overflow-hidden rounded-2xl px-4 py-3"
      style={{ opacity: settings.overlayOpacity }}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: settings.overlayOpacity, scale: 1 }}
      transition={{ type: "spring", stiffness: 300, damping: 26 }}
    >
      <div data-tauri-drag-region className="flex items-center justify-between">
        <div data-tauri-drag-region className="flex items-center gap-2">
          <PulsarLogo size={16} mode="static" />
          <span data-tauri-drag-region className="font-display text-[10px] font-bold tracking-[0.22em] text-fg">
            {t("overlay.title")}
          </span>
          {grade && (
            <span className="rounded-full px-1.5 py-px font-display text-[10px] font-bold" style={{ color, background: `color-mix(in oklab, ${color} 16%, transparent)` }}>
              {grade}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {has("clock") && <span className="text-[11px] text-muted tabular">{formatTime(now)}</span>}
          <button type="button" onClick={() => void hide()} className="grid h-5 w-5 place-items-center rounded text-faint opacity-0 transition group-hover:opacity-100 hover:bg-white/10 hover:text-fg" aria-label={t("overlay.close")}>
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div data-tauri-drag-region className="flex items-end gap-4">
        {has("ping") && (
          <div data-tauri-drag-region className="flex items-baseline gap-1">
            <span className="font-display text-[40px] leading-none font-bold tabular" style={{ color: pingColor(live?.last ?? null) }}>
              {live?.last === null || live?.last === undefined ? "–" : Math.round(live.last)}
            </span>
            <span className="text-[11px] text-muted">ms</span>
          </div>
        )}
        <div data-tauri-drag-region className="flex flex-1 gap-3 pb-1 text-[11px]">
          {has("jitter") && (
            <div>
              <div className="text-[9px] font-semibold tracking-[0.12em] text-faint uppercase">{t("cockpit.jitter")}</div>
              <div className="font-display text-[13px] font-bold text-fg tabular">{live?.jitter === null || live?.jitter === undefined ? "–" : `±${live.jitter.toFixed(1)}`}</div>
            </div>
          )}
          {has("loss") && (
            <div>
              <div className="text-[9px] font-semibold tracking-[0.12em] text-faint uppercase">{t("cockpit.loss")}</div>
              <div className={cn("font-display text-[13px] font-bold tabular", live && live.loss > 0.01 ? "text-danger" : "text-fg")}>{live ? `${(live.loss * 100).toFixed(0)} %` : "–"}</div>
            </div>
          )}
        </div>
      </div>

      {(has("cpu") || has("gpu") || has("ram")) && (
        <div data-tauri-drag-region className="grid grid-cols-3 gap-3">
          {has("cpu") && (
            <div>
              <div className="flex justify-between text-[9px] font-semibold tracking-[0.12em] text-faint uppercase">
                <span>{t("cockpit.cpu")}</span>
                <span className="text-fg tabular">{sys ? `${Math.round(sys.cpu)} %` : "–"}</span>
              </div>
              <Bar value={sys?.cpu ?? 0} color="var(--nv-accent)" />
            </div>
          )}
          {has("gpu") && (
            <div>
              <div className="flex justify-between text-[9px] font-semibold tracking-[0.12em] text-faint uppercase">
                <span>{t("cockpit.gpu")}</span>
                <span className="text-fg tabular">{sys?.gpu === null || sys?.gpu === undefined ? "–" : `${Math.round(sys.gpu)} %`}</span>
              </div>
              <Bar value={sys?.gpu ?? 0} color="var(--nv-accent-2)" />
            </div>
          )}
          {has("ram") && (
            <div>
              <div className="flex justify-between text-[9px] font-semibold tracking-[0.12em] text-faint uppercase">
                <span>{t("cockpit.ram")}</span>
                <span className="text-fg tabular">{ram === null ? "–" : `${Math.round(ram)} %`}</span>
              </div>
              <Bar value={ram ?? 0} color="var(--nv-accent-3)" />
            </div>
          )}
        </div>
      )}
      {!live && has("ping") && <div className="text-[10px] text-faint">{t("overlay.noData")}</div>}
    </motion.div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Overlay />
  </StrictMode>,
);
