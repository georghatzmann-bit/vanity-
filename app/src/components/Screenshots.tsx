import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Camera, ChevronLeft, ChevronRight, FolderOpen, X } from "lucide-react";
import { api, imgSrc } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Game, Screenshot } from "@/lib/types";
import { EmptyState } from "./ui/EmptyState";
import { Button } from "@shared/ui/Button";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

function Thumb({ shot, onOpen, index }: { shot: Screenshot; onOpen: () => void; index: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .thumbnail(shot.path, 480)
      .then((p) => alive && setSrc(p))
      .catch(() => alive && setSrc(shot.path));
    return () => {
      alive = false;
    };
  }, [shot.path]);
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => sound.play("hover")}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ ...spring.gentle, delay: Math.min(index, 20) * 0.03 }}
      whileHover={{ y: -4, scale: 1.02 }}
      className={`group relative aspect-video overflow-hidden rounded-xl bg-surface-2 ring-1 ring-line ${src ? "" : "skeleton"}`}
    >
      {src && <img src={imgSrc(src)} alt="" loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />}
      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2 text-left text-[11px] text-white/80 opacity-0 transition group-hover:opacity-100">{formatDateTime(shot.takenAt)}</span>
    </motion.button>
  );
}

/** Vollbild-Ansicht mit Pfeiltasten */
function Lightbox({ shots, index, onClose, setIndex }: { shots: Screenshot[]; index: number; onClose: () => void; setIndex: (i: number) => void }) {
  const go = useCallback(
    (d: number) => {
      sound.play("tick");
      setIndex((index + d + shots.length) % shots.length);
    },
    [index, shots.length, setIndex],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, onClose]);
  const shot = shots[index];
  return createPortal(
    <motion.div className="fixed inset-0 grid place-items-center bg-black/90 backdrop-blur-xl" style={{ zIndex: "var(--nv-z-modal)" }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <AnimatePresence mode="wait">
        <motion.img key={shot.path} src={imgSrc(shot.path)} alt="" className="max-h-[88vh] max-w-[92vw] rounded-lg object-contain shadow-2xl" initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} transition={spring.smooth} onClick={(e) => e.stopPropagation()} />
      </AnimatePresence>
      <button type="button" onClick={(e) => (e.stopPropagation(), go(-1))} className="absolute left-6 grid h-12 w-12 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20" aria-label="zurück">
        <ChevronLeft className="h-6 w-6" />
      </button>
      <button type="button" onClick={(e) => (e.stopPropagation(), go(1))} className="absolute right-6 grid h-12 w-12 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20" aria-label="weiter">
        <ChevronRight className="h-6 w-6" />
      </button>
      <div className="absolute top-5 right-5 flex gap-2">
        <button type="button" onClick={(e) => (e.stopPropagation(), void api.revealPath(shot.path))} className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20" aria-label="Im Explorer zeigen">
          <FolderOpen className="h-5 w-5" />
        </button>
        <button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20" aria-label="Schließen">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="absolute bottom-6 text-[13px] text-white/70">
        {index + 1} / {shots.length} · {formatDateTime(shot.takenAt)}
      </div>
    </motion.div>,
    document.body,
  );
}

/** Screenshot-Galerie pro Spiel (Steam, Xbox Game Bar, NVIDIA und eigener Ordner) */
export function Screenshots({ game }: { game: Game }) {
  const t = useT();
  const [shots, setShots] = useState<Screenshot[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    setShots(null);
    const steamId = game.source === "steam" ? game.sourceId : undefined;
    api
      .screenshotsList(game.id, game.name, steamId, game.links.screenshots)
      .then(setShots)
      .catch(() => setShots([]));
  }, [game.id, game.name, game.source, game.sourceId, game.links.screenshots]);

  if (shots === null) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skeleton aspect-video rounded-xl" />
        ))}
      </div>
    );
  }
  if (!shots.length) {
    return <EmptyState icon={<Camera className="h-7 w-7" />} title={t("game.noScreens")} text={t("game.noScreensText")} action={<Button variant="secondary" onClick={() => document.dispatchEvent(new CustomEvent("nova:tab", { detail: "links" }))}>{t("game.setFolder")}</Button>} />;
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        {shots.map((s, i) => (
          <Thumb key={s.path} shot={s} index={i} onOpen={() => (sound.play("open"), setOpen(i))} />
        ))}
      </div>
      <AnimatePresence>{open !== null && <Lightbox shots={shots} index={open} setIndex={setOpen} onClose={() => (sound.play("close"), setOpen(null))} />}</AnimatePresence>
    </>
  );
}
