import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Gamepad2, Heart, Play, Square, X } from "lucide-react";
import { imgSrc } from "@/lib/api";
import { formatDuration, formatRelative, formatTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Game } from "@/lib/types";
import { useNow } from "@/hooks/useNow";
import { useLibrary } from "@/store/library";
import { useUI } from "@/store/ui";
import { GameCover } from "./GameCover";
import { NovaLogo } from "@shared/ui/NovaLogo";
import { cn } from "@shared/lib/cn";
import { sound } from "@shared/sound/engine";
import { isTauri } from "@shared/lib/env";

type Row = "recent" | "all" | "favorites";

async function setFullscreen(on: boolean) {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow()
    .setFullscreen(on)
    .catch(() => undefined);
}

/** Big-Picture-Modus: Vollbild, große Cover, Controller-Steuerung fürs Sofa */
export function BigPicture() {
  const t = useT();
  const games = useLibrary((s) => s.games);
  const stats = useLibrary((s) => s.stats);
  const running = useLibrary((s) => s.running);
  const [row, setRow] = useState<Row>("recent");
  const [index, setIndex] = useState(0);
  const [pad, setPad] = useState(false);
  const now = useNow(1000);
  const stripRef = useRef<HTMLDivElement>(null);

  const lists = useMemo(() => {
    const visible = games.filter((g) => !g.hidden && g.kind === "game");
    const recent = visible.filter((g) => stats.get(g.id)?.lastPlayedAt).sort((a, b) => (stats.get(b.id)?.lastPlayedAt ?? 0) - (stats.get(a.id)?.lastPlayedAt ?? 0));
    return {
      recent: recent.length ? recent : visible,
      all: [...visible].sort((a, b) => a.name.localeCompare(b.name)),
      favorites: visible.filter((g) => g.favorite),
    } satisfies Record<Row, Game[]>;
  }, [games, stats]);
  const rows: Row[] = ["recent", "all", "favorites"];
  const list = lists[row];
  const game = list[Math.min(index, list.length - 1)];

  useEffect(() => {
    void setFullscreen(true);
    sound.play("whoosh");
    useLibrary.getState().bump("bigPicture");
    return () => void setFullscreen(false);
  }, []);

  useEffect(() => {
    if (game) useUI.getState().setFocusGame(game.id);
  }, [game]);

  const exit = useCallback(() => {
    sound.play("close");
    useUI.getState().setBigPicture(false);
  }, []);

  const move = useCallback(
    (d: number) => {
      setIndex((i) => {
        const n = Math.max(0, Math.min(list.length - 1, i + d));
        if (n !== i) sound.play("tick");
        return n;
      });
    },
    [list.length],
  );
  const switchRow = useCallback((d: number) => {
    setRow((r) => {
      const n = rows[(rows.indexOf(r) + d + rows.length) % rows.length];
      sound.play("switch");
      return n;
    });
    setIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const activate = useCallback(() => {
    if (!game) return;
    if (running.has(game.id)) return;
    void useLibrary.getState().launch(game);
  }, [game, running]);
  const fav = useCallback(() => {
    if (!game) return;
    sound.play(game.favorite ? "toggleOff" : "toggleOn");
    useLibrary.getState().updateGame(game.id, { favorite: !game.favorite });
  }, [game]);

  // Tastatur
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "ArrowRight") move(1);
      else if (e.key === "ArrowLeft") move(-1);
      else if (e.key === "ArrowDown" || e.key === "Tab") (e.preventDefault(), switchRow(1));
      else if (e.key === "ArrowUp") switchRow(-1);
      else if (e.key === "Enter") activate();
      else if (e.key === "Escape") exit();
      else if (e.key.toLowerCase() === "f") fav();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [move, switchRow, activate, exit, fav]);

  // Controller (Gamepad-API): Steuerkreuz/Stick, A, B, Y, LB/RB
  const handlers = useRef({ move, switchRow, activate, exit, fav });
  handlers.current = { move, switchRow, activate, exit, fav };
  useEffect(() => {
    let raf = 0;
    const prev: boolean[] = [];
    let lastMove = 0;
    const loop = () => {
      const pads = navigator.getGamepads?.() ?? [];
      const gp = [...pads].find((p) => p && p.connected);
      setPad(!!gp);
      if (gp) {
        const pressed = (i: number) => !!gp.buttons[i]?.pressed;
        const edge = (i: number) => {
          const p = pressed(i);
          const was = prev[i];
          prev[i] = p;
          return p && !was;
        };
        const h = handlers.current;
        if (edge(0)) h.activate();
        if (edge(1)) h.exit();
        if (edge(3)) h.fav();
        if (edge(4)) h.switchRow(-1);
        if (edge(5)) h.switchRow(1);
        if (edge(12)) h.switchRow(-1);
        if (edge(13)) h.switchRow(1);
        const x = gp.axes[0] ?? 0;
        const dir = pressed(15) || x > 0.55 ? 1 : pressed(14) || x < -0.55 ? -1 : 0;
        const tNow = performance.now();
        if (dir !== 0 && tNow - lastMove > (prev[99] ? 140 : 320)) {
          h.move(dir);
          lastMove = tNow;
          prev[99] = true;
        } else if (dir === 0) prev[99] = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const st = game ? stats.get(game.id) : undefined;
  const run = game ? running.get(game.id) : undefined;
  const CARD = 210;
  const GAP = 28;

  return createPortal(
    <motion.div className="fixed inset-0 overflow-hidden bg-[var(--nv-bg)]" style={{ zIndex: 95 }} initial={{ opacity: 0, scale: 1.04 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.02 }} transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}>
      {/* Hintergrund */}
      <AnimatePresence>
        {game && (
          <motion.div key={game.id} className="absolute inset-0" initial={{ opacity: 0, scale: 1.06 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.7 }}>
            {game.images.hero || game.images.cover ? <img src={imgSrc(game.images.hero ?? game.images.cover)} alt="" className="h-full w-full object-cover" style={{ filter: game.images.hero ? "none" : "blur(40px)" }} /> : <GameCover game={game} variant="hero" />}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--nv-bg)] via-[color-mix(in_oklab,var(--nv-bg)_55%,transparent)] to-[color-mix(in_oklab,var(--nv-bg)_30%,transparent)]" />
      <div className="absolute inset-0 bg-gradient-to-r from-[color-mix(in_oklab,var(--nv-bg)_85%,transparent)] via-transparent to-transparent" />

      {/* Kopfzeile */}
      <div className="relative flex items-center justify-between px-14 pt-10">
        <div className="flex items-center gap-4">
          <NovaLogo size={40} mode="idle" />
          <div className="flex gap-2">
            {rows.map((r) => (
              <button key={r} type="button" onClick={() => (setRow(r), setIndex(0), sound.play("switch"))} className={cn("h-10 rounded-full px-5 text-[15px] font-semibold transition", row === r ? "bg-white text-black" : "text-white/70 hover:text-white")}>
                {r === "recent" ? t("home.recent") : r === "all" ? t("bigpicture.all") : t("home.favorites")}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-6 text-white">
          {pad && (
            <span className="flex items-center gap-2 text-sm text-white/80">
              <Gamepad2 className="h-5 w-5 text-success" /> {t("bigpicture.controller")}
            </span>
          )}
          <span className="font-display text-3xl font-bold tabular">{formatTime(now)}</span>
          <button type="button" onClick={exit} className="grid h-11 w-11 place-items-center rounded-full bg-white/10 hover:bg-white/20" aria-label={t("bigpicture.exit")}>
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Info zum gewählten Spiel */}
      <div className="relative mt-[8vh] px-14">
        <AnimatePresence mode="wait">
          {game && (
            <motion.div key={game.id} initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ type: "spring", stiffness: 220, damping: 26 }}>
              {game.images.logo ? <img src={imgSrc(game.images.logo)} alt={game.name} className="max-h-36 max-w-[560px] object-contain object-left nv-logo" /> : <h1 className="max-w-3xl font-display text-6xl leading-tight font-bold text-white [text-shadow:0_6px_30px_rgb(0_0_0/0.5)]">{game.name}</h1>}
              <div className="mt-5 flex items-center gap-6 text-lg text-white/80">
                <span>{st ? formatDuration(st.totalSeconds) : t("library.neverPlayed")}</span>
                {st?.lastPlayedAt && <span>{formatRelative(st.lastPlayedAt)}</span>}
                {game.favorite && <Heart className="h-5 w-5 text-accent" fill="currentColor" />}
              </div>
              <div className="mt-8 flex gap-4">
                {run ? (
                  <button type="button" onClick={() => void useLibrary.getState().stop(game.id)} className="flex h-16 items-center gap-3 rounded-2xl bg-danger px-10 text-xl font-bold text-white">
                    <Square className="h-6 w-6" fill="currentColor" /> {t("common.stop")}
                  </button>
                ) : (
                  <motion.button type="button" whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }} onClick={activate} className="flex h-16 items-center gap-3 rounded-2xl bg-gradient-accent px-10 text-xl font-bold text-white shadow-[0_10px_40px_-10px_var(--nv-accent)]">
                    <Play className="h-6 w-6" fill="currentColor" /> {t("common.play")}
                  </motion.button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Cover-Leiste */}
      <div className="absolute inset-x-0 bottom-20 overflow-visible">
        <motion.div ref={stripRef} className="flex items-end" style={{ gap: GAP, paddingLeft: 56 }} animate={{ x: -Math.max(0, index - 1) * (CARD + GAP) }} transition={{ type: "spring", stiffness: 200, damping: 28 }}>
          {list.map((g, i) => {
            const active = i === index;
            return (
              <motion.button
                key={g.id}
                type="button"
                onClick={() => (active ? activate() : (setIndex(i), sound.play("tick")))}
                className="relative shrink-0 overflow-hidden rounded-2xl"
                style={{ width: CARD, height: CARD * 1.5 }}
                animate={{ scale: active ? 1.12 : 0.92, opacity: active ? 1 : 0.55, y: active ? -14 : 0 }}
                transition={{ type: "spring", stiffness: 260, damping: 24 }}
              >
                <GameCover game={g} />
                {active && <motion.div layoutId="bp-ring" className="pointer-events-none absolute inset-0 rounded-2xl ring-4 ring-white shadow-[0_0_50px_-5px_var(--nv-accent)]" transition={{ type: "spring", stiffness: 400, damping: 32 }} />}
                {running.has(g.id) && <span className="absolute top-3 left-3 rounded-full bg-success px-2.5 py-1 text-[11px] font-bold text-black">{t("common.running")}</span>}
              </motion.button>
            );
          })}
        </motion.div>
      </div>

      <div className="absolute inset-x-0 bottom-6 text-center text-[13px] tracking-wide text-white/50">{pad ? t("bigpicture.hint") : t("bigpicture.hintKeys")}</div>
    </motion.div>,
    document.body,
  );
}
