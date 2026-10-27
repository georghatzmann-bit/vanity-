import { motion } from "motion/react";
import { Bubbles, Languages, Palette, Sparkles } from "lucide-react";
import { NewDot, ShimmerButton } from "@/components/fx";
import { LogoMark } from "@/components/layout/Logo";
import { EASE_IN, EASE_OUT, SPRING_UI } from "@/lib/motion";
import { useApp } from "@/lib/store";

/** What changed in this version (shown once after an update). Keep it short and plain. */
const changes = [
  { icon: Sparkles, title: "Niobium is now Rift", text: "New name, new logo – your builds, profiles and settings came along." },
  { icon: Bubbles, title: "Bubble Builds", text: "The see-through build look from Chapter 2 Seasons 5–6. Turn it on in Settings." },
  { icon: Palette, title: "A fresh look", text: "A smoother launcher with new animations. Calmer? Settings → Reduce motion." },
  { icon: Languages, title: "Everything in English", text: "The launcher, the installer and the F9 menu." },
];

/** Short "What's new" card after an update (settings.lastSeenVersion differs from the app version). */
export function WhatsNew() {
  const version = useApp((s) => s.appVersion);
  const finishWelcome = useApp((s) => s.finishWelcome);

  return (
    <motion.div
      className="absolute inset-x-0 top-10 bottom-0 z-40 flex items-center justify-center p-8"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2, ease: EASE_IN } }}
    >
      <div className="absolute inset-0 bg-[#040407]/60 backdrop-blur-md" onClick={() => finishWelcome()} />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        initial={{ opacity: 0, y: 16, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING_UI }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        className="glass-strong relative w-full max-w-md overflow-hidden rounded-2xl p-7 shadow-[0_30px_80px_-20px_rgb(0_0_0/0.9),0_0_60px_-24px_rgb(139_92_246/0.6)]"
      >
        <div className="pointer-events-none absolute -top-24 -right-20 size-64 rounded-full bg-[radial-gradient(closest-side,rgb(139_92_246/0.3),transparent)]" />
        <div className="relative flex items-center gap-4">
          <LogoMark size={44} />
          <div>
            <div className="flex items-center gap-2">
              <NewDot />
              <span className="text-[11px] font-semibold tracking-[0.14em] text-cyan-text uppercase">New in {version}</span>
            </div>
            <h2 id="whats-new-title" className="mt-1 text-xl font-semibold">
              What's new
            </h2>
          </div>
        </div>
        <motion.ul
          className="relative mt-6 flex flex-col gap-4"
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.05, delayChildren: 0.15 } } }}
        >
          {changes.map((c) => (
            <motion.li
              key={c.title}
              variants={{ hidden: { opacity: 0, x: -10 }, show: { opacity: 1, x: 0, transition: { duration: 0.4, ease: EASE_OUT } } }}
              className="flex gap-3"
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-cyan/25 to-brand-violet/25 text-violet-text ring-1 ring-brand-violet/25">
                <c.icon className="size-4" />
              </div>
              <div>
                <p className="text-sm font-semibold">{c.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{c.text}</p>
              </div>
            </motion.li>
          ))}
        </motion.ul>
        <div className="relative mt-7 flex justify-end">
          <ShimmerButton size="md" onClick={() => finishWelcome()} autoFocus>
            Got it
          </ShimmerButton>
        </div>
      </motion.div>
    </motion.div>
  );
}
