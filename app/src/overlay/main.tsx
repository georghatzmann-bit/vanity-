import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { motion } from "motion/react";
import { ExternalLink, Gamepad2, Play, X } from "lucide-react";
import "@fontsource-variable/inter";
import "@fontsource-variable/sora";
import "../styles/app.css";
import { api, imgSrc, initImgSrc } from "@/lib/api";
import { mergeSettings, normalizeGame } from "@/lib/defaults";
import { formatClock, formatDuration, formatTime } from "@/lib/format";
import { setLanguage, useT } from "@/lib/i18n";
import { todaySeconds } from "@/lib/stats";
import { applyAppearance } from "@/lib/theme";
import type { Game, RunningGame, Session, Settings } from "@/lib/types";
import { GameCover } from "@/components/GameCover";
import { GenIcon } from "@/components/GenCover";
import { useNow } from "@/hooks/useNow";
import { NovaLogo } from "@shared/ui/NovaLogo";
import { sound } from "@shared/sound/engine";
import { isTauri } from "@shared/lib/env";

async function hide() {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().hide();
}

async function showMain() {
  if (!isTauri()) return;
  const { Window } = await import("@tauri-apps/api/window");
  const main = await Window.getByLabel("main");
  await main?.show();
  await main?.unminimize();
  await main?.setFocus();
  await hide();
}

/** Mini-Overlay: Uhr, laufende Sitzung, heutige Spielzeit, Schnellstart */
function Overlay() {
  const t = useT();
  const now = useNow(1000);
  const [games, setGames] = useState<Game[]>([]);
  const [running, setRunning] = useState<RunningGame[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [g, r, s, settings] = await Promise.all([api.games(), api.runningGames(), api.sessionsRange(Date.now() - 86400000 * 2, Date.now() + 86400000), api.kvGet<Partial<Settings>>("settings")]);
        if (!alive) return;
        const st = mergeSettings(settings);
        applyAppearance(st.theme, st.accent, st.motion);
        setLanguage(st.language);
        sound.setVolume(st.soundVolume);
        sound.setMuted(st.soundMuted);
        setGames(g.map(normalizeGame));
        setRunning(r);
        setSessions(s);
      } catch {
        /* Overlay bleibt einfach leer */
      }
    };
    void load();
    const id = window.setInterval(load, 3000);
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

  const current = running[0];
  const game = current ? games.find((g) => g.id === current.gameId) : undefined;
  const live = running.reduce((a, r) => a + (now - r.startedAt) / 1000, 0);
  const today = todaySeconds(sessions, now) + live;
  const quick = games.filter((g) => (g.favorite || g.inDock) && !g.hidden).slice(0, 8);

  return (
    <motion.div className="glass-strong m-3 flex h-[calc(100%-24px)] flex-col overflow-hidden rounded-2xl" initial={{ opacity: 0, x: 30, scale: 0.96 }} animate={{ opacity: 1, x: 0, scale: 1 }} transition={{ type: "spring", stiffness: 260, damping: 26 }}>
      <div data-tauri-drag-region className="flex items-center justify-between px-4 pt-3">
        <div data-tauri-drag-region className="flex items-center gap-2">
          <NovaLogo size={20} />
          <span data-tauri-drag-region className="font-display text-[12px] font-bold tracking-[0.2em] text-fg">
            NOVA
          </span>
        </div>
        <button type="button" onClick={() => void hide()} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg" aria-label="Schließen">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="px-4 pt-3">
        <div className="font-display text-[44px] leading-none font-bold text-fg tabular">{formatTime(now)}</div>
      </div>

      <div className="mx-4 mt-4 overflow-hidden rounded-xl bg-surface">
        {game && current ? (
          <div className="relative flex items-center gap-3 p-3">
            <div className="h-16 w-11 shrink-0 overflow-hidden rounded-md">
              <GameCover game={game} />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold tracking-[0.16em] text-accent uppercase">{t("overlay.session")}</div>
              <div className="truncate text-sm font-semibold text-fg">{game.name}</div>
              <div className="font-display text-2xl font-bold text-fg tabular">{formatClock((now - current.startedAt) / 1000)}</div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 p-4 text-[13px] text-muted">
            <Gamepad2 className="h-4 w-4" /> {t("overlay.noGame")}
          </div>
        )}
      </div>

      <div className="mx-4 mt-3 flex items-center justify-between rounded-xl bg-surface px-4 py-3">
        <span className="text-[12px] text-muted">{t("overlay.today")}</span>
        <span className="font-display text-lg font-bold text-fg tabular">{formatDuration(today, { short: true })}</span>
      </div>

      {quick.length > 0 && (
        <div className="mt-4 px-4">
          <div className="mb-2 text-[10px] font-semibold tracking-[0.16em] text-muted uppercase">{t("overlay.quick")}</div>
          <div className="grid grid-cols-4 gap-2">
            {quick.map((g) => (
              <button
                key={g.id}
                type="button"
                title={g.name}
                onClick={async () => {
                  sound.play("launch", { gain: 0.5 });
                  await api.launchGame(g.id, g.launch).catch(() => undefined);
                  await hide();
                }}
                className="group relative aspect-square overflow-hidden rounded-xl ring-1 ring-line transition hover:scale-105 hover:ring-accent"
              >
                {g.images.icon ? <div className="grid h-full w-full place-items-center bg-surface-solid p-2"><img src={imgSrc(g.images.icon)} alt="" className="h-full w-full object-contain" /></div> : g.images.cover ? <img src={imgSrc(g.images.cover)} alt="" className="h-full w-full object-cover" /> : <GenIcon name={g.name} />}
                <span className="absolute inset-0 grid place-items-center bg-black/50 opacity-0 transition group-hover:opacity-100">
                  <Play className="h-4 w-4 text-white" fill="currentColor" />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-auto p-4">
        <button type="button" onClick={() => void showMain()} className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-gradient-accent text-[13px] font-semibold text-white">
          <ExternalLink className="h-4 w-4" /> {t("overlay.open")}
        </button>
      </div>
    </motion.div>
  );
}

void initImgSrc().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Overlay />
    </StrictMode>,
  );
});
