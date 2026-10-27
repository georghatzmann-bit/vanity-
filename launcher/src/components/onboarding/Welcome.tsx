import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, FolderCheck, Gamepad2, Keyboard, Loader2, Rocket, Sparkles, UserRound } from "lucide-react";
import { ImportBuildForm, useBuildImport } from "@/components/build/ImportBuild";
import { GradientText, ShimmerButton } from "@/components/fx";
import { Logo, LogoMark } from "@/components/layout/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCalmMotion } from "@/hooks/use-calm-motion";
import { api } from "@/lib/api";
import { EASE_IN, EASE_OUT, SPRING_PLAYFUL, SPRING_UI } from "@/lib/motion";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const STEPS = ["Welcome", "Your name", "Your build", "Ready"] as const;

/** Same rule as on the Profiles page. */
const NAME_RULE = /^[A-Za-z0-9]{3,16}$/;

/**
 * First start: full-window welcome with a short setup (name → build folder → "Let's go").
 * Shown when settings.lastSeenVersion is empty. Every way out stores the app version.
 */
export function Welcome() {
  const config = useApp((s) => s.config);
  const finishWelcome = useApp((s) => s.finishWelcome);
  const setPage = useApp((s) => s.setPage);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [name, setName] = useState(config.settings.playerName === "Player" ? "" : config.settings.playerName);
  const [savingName, setSavingName] = useState(false);
  const build = useBuildImport(() => go(3));

  const go = (next: number) => {
    setDir(next > step ? 1 : -1);
    setStep(next);
  };

  // Save the name right away: a build added in the next step creates its first profile with it
  const saveName = async () => {
    const clean = name.trim();
    if (!NAME_RULE.test(clean)) return;
    setSavingName(true);
    const old = useApp.getState().config.settings.playerName;
    await useApp.getState().saveSettings({ playerName: clean });
    if (old !== clean) {
      for (const p of useApp.getState().config.profiles.filter((p) => p.playerName === old)) {
        try {
          useApp.getState().setConfig(await api.updateProfile({ ...p, playerName: clean }));
        } catch {
          /* the profile keeps its old name – it can be changed on the Profiles page */
        }
      }
    }
    setSavingName(false);
    go(2);
  };

  const finish = async (openLibrary = false) => {
    await finishWelcome();
    setPage(openLibrary ? "library" : "start");
  };

  const nameOk = NAME_RULE.test(name.trim());

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Rift"
      className="absolute inset-x-0 top-10 bottom-0 z-40 flex flex-col overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.25, ease: EASE_IN } }}
    >
      {/* Veil over the app, the aurora still glows through */}
      <div className="absolute inset-0 bg-[#07070c]/80 backdrop-blur-xl" />
      <div className="pointer-events-none absolute -top-40 left-1/2 size-[44rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(139_92_246/0.22),transparent)]" />
      <div className="pointer-events-none absolute -bottom-56 left-1/4 size-[36rem] rounded-full bg-[radial-gradient(closest-side,rgb(34_211_238/0.16),transparent)]" />

      <div className="relative flex h-9 items-center justify-between px-8 mt-6">
        <StepDots step={step} />
        {step < 3 && (
          <Button variant="ghost" size="sm" onClick={() => finish(false)}>
            Skip setup
          </Button>
        )}
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-8 py-6">
        <AnimatePresence mode="wait" custom={dir} initial={false}>
          <motion.div
            key={step}
            custom={dir}
            variants={{
              enter: (d: number) => ({ opacity: 0, x: 28 * d, filter: "blur(6px)" }),
              center: { opacity: 1, x: 0, filter: "blur(0px)", transition: { duration: 0.45, ease: EASE_OUT }, transitionEnd: { filter: "none" } },
              leave: (d: number) => ({ opacity: 0, x: -20 * d, filter: "blur(4px)", transition: { duration: 0.18, ease: EASE_IN } }),
            }}
            initial="enter"
            animate="center"
            exit="leave"
            className="w-full max-w-xl"
          >
            {step === 0 && <IntroStep onNext={() => go(1)} />}

            {step === 1 && (
              <StepFrame
                icon={UserRound}
                title="What should we call you?"
                hint="This is the name other players see in the game. You can change it later in Settings."
              >
                <form
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveName();
                  }}
                >
                  <Input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. georg"
                    maxLength={16}
                    aria-invalid={name.length > 0 && !nameOk}
                    aria-label="Player name"
                    className="h-12 rounded-xl px-4 text-base"
                  />
                  <p className={cn("text-xs", name.length > 0 && !nameOk ? "text-destructive" : "text-muted-foreground")}>
                    3–16 letters or numbers, no spaces.
                  </p>
                  <StepActions>
                    <Button type="button" variant="ghost" onClick={() => go(0)}>
                      <ArrowLeft />
                      Back
                    </Button>
                    <Button type="submit" disabled={!nameOk || savingName}>
                      {savingName ? <Loader2 className="animate-spin" /> : null}
                      Next
                      <ArrowRight />
                    </Button>
                  </StepActions>
                </form>
              </StepFrame>
            )}

            {step === 2 && (
              <StepFrame
                icon={FolderCheck}
                title="Add your Fortnite build"
                hint="Pick the folder of a build you own (1.7 – 30.x). Rift only reads it – nothing inside is changed."
              >
                {config.builds.length > 0 && !build.report && (
                  <div className="mb-4 flex flex-col gap-2">
                    {config.builds.map((b) => (
                      <div key={b.id} className="flex items-center gap-3 rounded-xl bg-success/[0.07] px-4 py-3 ring-1 ring-success/20">
                        <span className="flex size-6 items-center justify-center rounded-full bg-success/15 text-success">
                          <Check className="size-3.5" strokeWidth={3} />
                        </span>
                        <p className="text-sm">
                          Fortnite <span className="font-semibold tabular-nums">{b.version}</span>
                          <span className="text-muted-foreground"> · {b.season}</span>
                        </p>
                      </div>
                    ))}
                    <p className="text-xs text-muted-foreground">
                      {config.builds.length === 1 ? "You already have a build." : "You already have builds."} Add another one below, or go on.
                    </p>
                  </div>
                )}
                <ImportBuildForm state={build} />
                <StepActions>
                  <Button variant="ghost" onClick={() => go(1)}>
                    <ArrowLeft />
                    Back
                  </Button>
                  <div className="flex gap-2">
                    {!build.report && (
                      <Button variant="secondary" onClick={() => go(3)}>
                        {config.builds.length > 0 ? "Next" : "Skip for now"}
                      </Button>
                    )}
                    {build.report ? (
                      <Button onClick={build.add} disabled={!build.canAdd}>
                        <Check />
                        Add build
                      </Button>
                    ) : (
                      <Button onClick={() => build.check()} disabled={!build.path || build.checking}>
                        {build.checking && <Loader2 className="animate-spin" />}
                        Check
                      </Button>
                    )}
                  </div>
                </StepActions>
              </StepFrame>
            )}

            {step === 3 && (
              <ReadyStep
                name={config.settings.playerName}
                hasBuild={config.builds.length > 0}
                onGo={() => finish(config.builds.length === 0)}
                onBack={() => go(2)}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function StepDots({ step }: { step: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
      {STEPS.map((label, i) => (
        <li key={label} className="relative flex h-2 items-center">
          <span className={cn("block h-2 rounded-full transition-[width,background-color] duration-300", i === step ? "w-7" : "w-2", i < step ? "bg-violet-text/60" : "bg-white/[0.12]")} />
          {i === step && (
            <motion.span layoutId="welcome-dot" transition={SPRING_UI} className="absolute inset-0 rounded-full bg-brand shadow-[0_0_12px_rgb(139_92_246/0.8)]" />
          )}
        </li>
      ))}
      <span className="ml-2 text-xs text-muted-foreground">{STEPS[step]}</span>
    </ol>
  );
}

function StepFrame({ icon: Icon, title, hint, children }: { icon: typeof Gamepad2; title: string; hint: string; children: ReactNode }) {
  return (
    <div className="glass-strong rounded-2xl p-8">
      <div className="mb-6 flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-cyan/30 to-brand-violet/30 text-violet-text ring-1 ring-brand-violet/30">
          <Icon className="size-5" />
        </div>
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function StepActions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex items-center justify-between gap-3">{children}</div>;
}

const features = [
  { icon: FolderCheck, title: "Your builds", text: "Use the Fortnite builds you already have – 1.7 up to 30.x." },
  { icon: Rocket, title: "Host & Play", text: "One click starts the backend, your own server and the game." },
  { icon: Keyboard, title: "F9 menu", text: "Edit on release, trickshot parkours, bots and more – in the game." },
];

function IntroStep({ onNext }: { onNext: () => void }) {
  return (
    <motion.div
      className="flex flex-col items-center text-center"
      initial="hidden"
      animate="show"
      variants={{ show: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } } }}
    >
      <motion.div
        variants={{ hidden: { opacity: 0, scale: 0.86, filter: "blur(12px)" }, show: { opacity: 1, scale: 1, filter: "blur(0px)", transition: SPRING_PLAYFUL } }}
      >
        <Logo size={72} glow tagline className="text-left" />
      </motion.div>
      <motion.h1
        variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE_OUT } } }}
        className="mt-10 text-4xl font-semibold tracking-tight"
      >
        Welcome to <GradientText>Rift</GradientText>
      </motion.h1>
      <motion.p
        variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE_OUT } } }}
        className="mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground"
      >
        Play old Fortnite seasons on your own PC – with friends, bots and your own rules. Setup takes about a minute.
      </motion.p>
      <div className="mt-8 grid w-full gap-3 sm:grid-cols-3">
        {features.map((f) => (
          <motion.div
            key={f.title}
            variants={{ hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT } } }}
            className="glass rounded-xl p-4 text-left"
          >
            <f.icon className="size-5 text-violet-text" />
            <p className="mt-3 text-sm font-semibold">{f.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{f.text}</p>
          </motion.div>
        ))}
      </div>
      <motion.div
        variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT } } }}
        className="mt-9"
      >
        <ShimmerButton size="lg" pulse icon={<Sparkles />} onClick={onNext}>
          Let's set it up
        </ShimmerButton>
      </motion.div>
    </motion.div>
  );
}

function ReadyStep({ name, hasBuild, onGo, onBack }: { name: string; hasBuild: boolean; onGo: () => void; onBack: () => void }) {
  const calm = useCalmMotion();
  const goRef = useRef<HTMLButtonElement>(null);
  useEffect(() => goRef.current?.focus(), []);
  return (
    <div className="flex flex-col items-center text-center">
      <div className="relative">
        {!calm && <Sparkles8 />}
        <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={SPRING_PLAYFUL}>
          <LogoMark size={96} glow />
        </motion.div>
      </div>
      <h2 className="mt-8 text-3xl font-semibold tracking-tight">
        You're all set{name && name !== "Player" ? `, ${name}` : ""}!
      </h2>
      <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground">
        {hasBuild
          ? "Press Host & Play on Home to start. In the game, F9 opens the Rift menu."
          : "Add a build in the Library whenever you're ready. Then press Host & Play on Home."}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-3 py-1 ring-1 ring-white/[0.06]">
          <Check className="size-3.5 text-success" /> Name saved
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-3 py-1 ring-1 ring-white/[0.06]">
          {hasBuild ? <Check className="size-3.5 text-success" /> : <span className="size-1.5 rounded-full bg-faint" />}
          {hasBuild ? "Build ready" : "No build yet"}
        </span>
      </div>
      <div className="mt-9 flex items-center gap-3">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft />
          Back
        </Button>
        <ShimmerButton ref={goRef} size="xl" pulse icon={<Gamepad2 />} onClick={onGo}>
          Let's go
        </ShimmerButton>
      </div>
    </div>
  );
}

/** A few cyan and violet sparks that fly out once around the logo. */
function Sparkles8() {
  const sparks = Array.from({ length: 10 }, (_, i) => {
    const angle = (i / 10) * Math.PI * 2 + 0.3;
    const dist = 78 + (i % 3) * 14;
    return { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist, gold: i % 3 === 0, delay: 0.15 + (i % 4) * 0.04 };
  });
  return (
    <div aria-hidden className="pointer-events-none absolute top-1/2 left-1/2">
      {sparks.map((s, i) => (
        <motion.span
          key={i}
          className={cn("absolute size-1.5 rounded-full", s.gold ? "bg-brand-cyan shadow-[0_0_8px_rgb(34_211_238/0.9)]" : "bg-violet-text shadow-[0_0_8px_rgb(196_181_253/0.9)]")}
          initial={{ x: 0, y: 0, opacity: 0, scale: 0.4 }}
          animate={{ x: s.x, y: s.y, opacity: [0, 1, 0], scale: [0.4, 1, 0.6] }}
          transition={{ duration: 1.1, delay: s.delay, ease: EASE_OUT }}
        />
      ))}
    </div>
  );
}
