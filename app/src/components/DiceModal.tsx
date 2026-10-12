import { useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { Brain, Coffee, Info, Play, RotateCcw, Shuffle, Swords, BookOpen, Users } from "lucide-react";
import { pickGame, type Duration, type Mood, type Pick } from "@/lib/dice";
import { formatDuration } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useLibrary } from "@/store/library";
import { useUI } from "@/store/ui";
import { GameCover } from "./GameCover";
import { Modal } from "./ui/Modal";
import { Button } from "@shared/ui/Button";
import { Starfield, type StarfieldHandle } from "@shared/ui/Starfield";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

const PIPS: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [[28, 28], [72, 72]],
  3: [[25, 25], [50, 50], [75, 75]],
  4: [[28, 28], [72, 28], [28, 72], [72, 72]],
  5: [[26, 26], [74, 26], [50, 50], [26, 74], [74, 74]],
  6: [[28, 24], [72, 24], [28, 50], [72, 50], [28, 76], [72, 76]],
};

// Drehung, die jeweils eine Fläche nach vorne bringt
const FACE_ROT: Record<number, { x: number; y: number }> = { 1: { x: 0, y: 0 }, 2: { x: 0, y: -90 }, 3: { x: -90, y: 0 }, 4: { x: 90, y: 0 }, 5: { x: 0, y: 90 }, 6: { x: 0, y: 180 } };

function Face({ n, transform }: { n: number; transform: string }) {
  return (
    <div className="absolute inset-0 rounded-[22px] border border-white/25" style={{ transform, backfaceVisibility: "hidden", background: "linear-gradient(135deg, var(--nv-accent-2), var(--nv-accent) 55%, var(--nv-accent-3))", boxShadow: "inset 0 0 24px rgb(255 255 255 / 0.25), inset 0 -10px 20px rgb(0 0 0 / 0.2)" }}>
      {PIPS[n].map(([x, y], i) => (
        <span key={i} className="absolute h-[18%] w-[18%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[inset_0_2px_3px_rgb(0_0_0/0.25)]" style={{ left: `${x}%`, top: `${y}%` }} />
      ))}
    </div>
  );
}

/** 3D-Würfel aus sechs Flächen */
function Dice({ controls }: { controls: ReturnType<typeof useAnimationControls> }) {
  const size = 110;
  const h = size / 2;
  return (
    <div style={{ perspective: 700, width: size, height: size }}>
      <motion.div className="relative h-full w-full" style={{ transformStyle: "preserve-3d" }} animate={controls} initial={{ rotateX: -22, rotateY: 32 }}>
        <Face n={1} transform={`translateZ(${h}px)`} />
        <Face n={6} transform={`rotateY(180deg) translateZ(${h}px)`} />
        <Face n={2} transform={`rotateY(90deg) translateZ(${h}px)`} />
        <Face n={5} transform={`rotateY(-90deg) translateZ(${h}px)`} />
        <Face n={3} transform={`rotateX(90deg) translateZ(${h}px)`} />
        <Face n={4} transform={`rotateX(-90deg) translateZ(${h}px)`} />
      </motion.div>
    </div>
  );
}

/** "Was soll ich spielen?" - Würfel mit Stimmung und Zeit */
export function DiceModal() {
  const t = useT();
  const open = useUI((s) => s.diceOpen);
  const setOpen = useUI((s) => s.setDice);
  const games = useLibrary((s) => s.games);
  const stats = useLibrary((s) => s.stats);
  const [mood, setMood] = useState<Mood>("any");
  const [duration, setDuration] = useState<Duration>("any");
  const [rolling, setRolling] = useState(false);
  const [result, setResult] = useState<Pick | null>(null);
  const controls = useAnimationControls();
  const stars = useRef<StarfieldHandle>(null);
  const rolls = useRef(0);

  const roll = async () => {
    if (rolling) return;
    setRolling(true);
    setResult(null);
    sound.play("dice");
    rolls.current++;
    const face = 1 + Math.floor(Math.random() * 6);
    const target = FACE_ROT[face];
    const spinsX = 720 * (1 + Math.floor(Math.random() * 2));
    const spinsY = 720 * (1 + Math.floor(Math.random() * 2));
    await controls.start({
      rotateX: [-22, target.x - spinsX - 20],
      rotateY: [32, target.y + spinsY + 30],
      y: [0, -70, 0, -18, 0],
      transition: { duration: 1.5, ease: [0.2, 0.75, 0.25, 1], y: { duration: 1.5, times: [0, 0.3, 0.6, 0.8, 1] } },
    });
    const pick = pickGame(games, stats, { mood, duration }, Date.now() + rolls.current);
    setResult(pick);
    setRolling(false);
    if (pick) {
      sound.play("success");
      stars.current?.burst(300, 140, { count: 110, speed: 8, life: 1.6 });
      useLibrary.getState().bump("diceRolls");
    }
  };

  const moods: { v: Mood; icon: React.ReactNode; label: string }[] = [
    { v: "any", icon: <Shuffle className="h-4 w-4" />, label: t("dice.moodAny") },
    { v: "chill", icon: <Coffee className="h-4 w-4" />, label: t("dice.moodChill") },
    { v: "action", icon: <Swords className="h-4 w-4" />, label: t("dice.moodAction") },
    { v: "story", icon: <BookOpen className="h-4 w-4" />, label: t("dice.moodStory") },
    { v: "social", icon: <Users className="h-4 w-4" />, label: t("dice.moodSocial") },
    { v: "brain", icon: <Brain className="h-4 w-4" />, label: t("dice.moodBrain") },
  ];
  const durations: { v: Duration; label: string }[] = [
    { v: "any", label: t("dice.durAny") },
    { v: "short", label: t("dice.durShort") },
    { v: "mid", label: t("dice.durMid") },
    { v: "long", label: t("dice.durLong") },
  ];
  const hasGames = games.some((g) => g.kind === "game" && !g.hidden);

  return (
    <Modal open={open} onClose={() => setOpen(false)} title={t("dice.title")} subtitle={t("dice.subtitle")} width={640}>
      <div className="relative">
        <Starfield ref={stars} className="pointer-events-none absolute inset-0 z-10" density={0} drift={0} parallax={false} still />
        {!hasGames ? (
          <div className="py-10 text-center text-sm text-muted">{t("dice.empty")}</div>
        ) : (
          <>
            <div className="mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">{t("dice.mood")}</div>
            <div className="grid grid-cols-3 gap-2">
              {moods.map((m) => (
                <button key={m.v} type="button" onMouseEnter={() => sound.play("hover")} onClick={() => (sound.play("click"), setMood(m.v))} className={cn("flex h-11 items-center justify-center gap-2 rounded-lg border text-[13px] font-medium transition", mood === m.v ? "border-transparent bg-accent/15 text-fg ring-1 ring-accent/60" : "border-line text-muted hover:text-fg")}>
                  {m.icon} {m.label}
                </button>
              ))}
            </div>
            <div className="mt-5 mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">{t("dice.duration")}</div>
            <div className="grid grid-cols-4 gap-2">
              {durations.map((d) => (
                <button key={d.v} type="button" onMouseEnter={() => sound.play("hover")} onClick={() => (sound.play("click"), setDuration(d.v))} className={cn("h-10 rounded-lg border text-[12px] font-medium transition", duration === d.v ? "border-transparent bg-accent/15 text-fg ring-1 ring-accent/60" : "border-line text-muted hover:text-fg")}>
                  {d.label}
                </button>
              ))}
            </div>

            <div className="mt-6 flex min-h-[230px] items-center justify-center gap-8 rounded-xl bg-surface py-6">
              <AnimatePresence mode="wait">
                {!result ? (
                  <motion.div key="dice" className="flex flex-col items-center gap-6" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6, rotate: 30 }} transition={spring.gentle}>
                    <Dice controls={controls} />
                    <Button variant="primary" size="lg" silent onClick={() => void roll()} loading={rolling} className="min-w-44">
                      {rolling ? t("dice.rolling") : t("dice.roll")}
                    </Button>
                  </motion.div>
                ) : (
                  <motion.div key={result.game.id} className="flex items-center gap-6 px-6" initial={{ opacity: 0, y: 30, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -20 }} transition={spring.bouncy}>
                    <motion.div className="h-[195px] w-[130px] shrink-0 overflow-hidden rounded-xl shadow-glow" initial={{ rotateY: 180 }} animate={{ rotateY: 0 }} transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}>
                      <GameCover game={result.game} />
                    </motion.div>
                    <div className="min-w-0">
                      <div className="text-[12px] font-semibold tracking-[0.2em] text-accent uppercase">{t("dice.result")}</div>
                      <div className="mt-1 font-display text-2xl leading-tight font-bold text-fg">{result.game.name}</div>
                      <div className="mt-1 text-[13px] text-muted">
                        {t(result.reason)}
                        {stats.get(result.game.id) ? ` · ${formatDuration(stats.get(result.game.id)!.totalSeconds, { short: true })}` : ""}
                      </div>
                      {!result.matched && <div className="mt-1 flex items-center gap-1 text-[12px] text-warning"><Info className="h-3.5 w-3.5" /> {t("dice.noMatch")}</div>}
                      <div className="mt-5 flex gap-2">
                        <Button
                          variant="primary"
                          silent
                          icon={<Play className="h-4 w-4" fill="currentColor" />}
                          onClick={() => {
                            setOpen(false);
                            void useLibrary.getState().launch(result.game);
                          }}
                        >
                          {t("common.play")}
                        </Button>
                        <Button variant="secondary" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setResult(null)}>
                          {t("dice.again")}
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setOpen(false);
                            useUI.getState().navigate({ page: "game", id: result.game.id });
                          }}
                        >
                          Details
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
