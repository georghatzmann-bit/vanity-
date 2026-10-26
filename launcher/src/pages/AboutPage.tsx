import type { ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowUpRight, BookOpen, Code2, ExternalLink, Layers, Lightbulb, Scale, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Eyebrow, IconTile, PageHeader, PageShell } from "@/components/common";
import { GlowCard, GradientText, HeroBackdrop, NumberTicker, Reveal, Stagger } from "@/components/fx";
import { LogoMark, Wordmark } from "@/components/layout/Logo";
import { credits, type Credit } from "@/lib/demo-data";
import { SPRING_PLAYFUL, SPRING_UI } from "@/lib/motion";
import { useApp } from "@/lib/store";
import { openExternal } from "@/lib/window";
import { cn } from "@/lib/utils";

/*
 * About & Credits: Niobium itself, then everyone whose work it uses.
 * The credit list comes from src/lib/demo-data.ts; the few libraries below are also listed in
 * THIRD_PARTY_NOTICES.md and are added here when the shared list doesn't have them yet.
 */

const SOURCE_URL = "https://github.com/georghatzmann-bit/vanity-";

const moreLibraries: Credit[] = [
  {
    name: "JSON for Modern C++ (nlohmann/json)",
    author: "Niels Lohmann",
    license: "MIT",
    url: "https://github.com/nlohmann/json",
    use: "Reads and writes JSON in the game server and the in-game menu",
  },
  { name: "Vite", author: "Evan You and contributors", license: "MIT", url: "https://vite.dev", use: "Builds the launcher's user interface" },
  { name: "Zustand", author: "Poimandres", license: "MIT", url: "https://github.com/pmndrs/zustand", use: "Keeps the launcher's state" },
  { name: "Sonner", author: "Emil Kowalski", license: "MIT", url: "https://sonner.emilkowal.ski", use: "Pop-up messages" },
  { name: "Express", author: "OpenJS Foundation and contributors", license: "MIT", url: "https://expressjs.com", use: "Web server of the backend" },
  { name: "ws", author: "Einar Otto Stangvik and contributors", license: "MIT", url: "https://github.com/websockets/ws", use: "Live connections in the backend (friends, parties)" },
];

/** The shared credit list plus the libraries above (no duplicates). */
function allCredits(): { group: string; items: Credit[] }[] {
  const known = new Set(credits.flatMap((g) => g.items.map((c) => c.name.toLowerCase())));
  const extra = moreLibraries.filter((c) => !known.has(c.name.toLowerCase()));
  const found = credits.findIndex((g) => /librar/i.test(g.group));
  const libIndex = found >= 0 ? found : credits.length - 1;
  return credits.map((g, i) => (i === libIndex && extra.length ? { ...g, items: [...g.items, ...extra] } : g));
}

const groups = allCredits();
const creditCount = groups.reduce((n, g) => n + g.items.length, 0);

/** Look per group: the projects Niobium is built on get big cards, libraries get compact rows. */
function groupStyle(group: string, index: number): { icon: LucideIcon; big: boolean; hint: string } {
  if (/built on|source/i.test(group) || index === 0) {
    return { icon: Layers, big: true, hint: "Niobium uses source code from these projects. Thank you!" };
  }
  if (/inspired|read only/i.test(group)) {
    return { icon: Lightbulb, big: false, hint: "Read to learn from – no code taken." };
  }
  return { icon: BookOpen, big: false, hint: "Open-source building blocks used across Niobium." };
}

/** Projects named after chemical elements, like Niobium – shown as periodic-table tiles. */
const elements: Record<string, { symbol: string; number: number }> = {
  magnesium: { symbol: "Mg", number: 12 },
  erbium: { symbol: "Er", number: 68 },
  tellurium: { symbol: "Te", number: 52 },
};

function elementOf(name: string) {
  const key = name.toLowerCase().split(/[\s/]/)[0];
  return elements[key];
}

/** Letter mark for projects that aren't elements ("LawinServer" → "LS", or just "L" when small). */
function monogram(name: string, letters: 1 | 2): string {
  const clean = name.replace(/\(.*?\)/g, "").trim();
  const first = (clean.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
  if (letters === 1) return first;
  const words = clean.split(/[\s/+.-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const caps = clean.match(/[A-Z]/g);
  return caps && caps.length >= 2 ? caps[0] + caps[1] : first;
}

export function AboutPage() {
  return (
    <PageShell>
      <PageHeader
        title="About & Credits"
        description="Niobium stands on the shoulders of many open-source projects. Here's who made what."
      />

      <HeroCard />

      <Reveal className="flex flex-wrap items-end justify-between gap-3 pt-2">
        <div>
          <Eyebrow>Credits</Eyebrow>
          <h2 className="mt-1.5 text-xl font-semibold tracking-tight">
            <NumberTicker value={creditCount} /> projects make Niobium possible
          </h2>
        </div>
        <p className="max-w-sm text-xs text-muted-foreground">Click a project to open its website. License texts are listed in THIRD_PARTY_NOTICES.md in the source code.</p>
      </Reveal>

      {groups.map((group, index) => (
        <CreditGroup key={group.group} title={group.group} items={group.items} {...groupStyle(group.group, index)} />
      ))}

      <Reveal className="pt-2 text-center text-[11px] text-faint">
        Niobium is not affiliated with or endorsed by Epic Games. “Fortnite” is a trademark of Epic Games, Inc.
      </Reveal>
    </PageShell>
  );
}

// ---- Hero ----------------------------------------------------------------------------------------

function HeroCard() {
  const version = useApp((s) => s.appVersion);
  return (
    <GlowCard className="grain relative overflow-hidden p-8">
      <HeroBackdrop />
      <div className="relative flex flex-col gap-7">
        <div className="flex flex-wrap items-center justify-between gap-8">
          <div className="flex min-w-0 items-center gap-6">
            <motion.div initial={{ opacity: 0, scale: 0.7, rotate: -8 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} transition={{ ...SPRING_PLAYFUL, delay: 0.1 }}>
              <LogoMark size={96} variant="rich" glow />
            </motion.div>
            <div className="min-w-0">
              <Wordmark height={36} title="Niobium" className="text-foreground" />
              <p className="mt-2.5 text-sm text-muted-foreground">
                <GradientText variant="brand" className="font-semibold">NiobiumFN</GradientText> — old seasons, new shine.
              </p>
              <div className="mt-3.5 flex flex-wrap gap-2">
                <Badge variant="brand" className="tabular-nums">Version {version}</Badge>
                <Badge variant="secondary">Test build</Badge>
                <Badge variant="muted">For your own use only</Badge>
              </div>
            </div>
          </div>
          <ElementFamily />
        </div>

        <div aria-hidden className="h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />

        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl space-y-2 text-sm leading-relaxed text-muted-foreground">
            <p>
              A launcher for OG Fortnite private servers with your own old builds. It starts the backend, the game server and your game with one
              click.
            </p>
            <p>
              Niobium's in-game menu is based on <span className="font-medium text-foreground">ATLAS Console by cipherfps, ralz and contributors</span>.
            </p>
            <p className="flex items-center gap-1.5 text-xs">
              <Scale className="size-3.5 shrink-0" />
              License: GPL-3.0. Niobium is not affiliated with Epic Games.
            </p>
          </div>
          <Button variant="secondary" onClick={() => openExternal(SOURCE_URL)}>
            <Code2 />
            Source code
            <ArrowUpRight className="text-muted-foreground" />
          </Button>
        </div>
      </div>
    </GlowCard>
  );
}

/** Nb next to the elements its base projects are named after. */
function ElementFamily() {
  const family = [
    { symbol: "Nb", number: 41, name: "Niobium", own: true },
    { symbol: "Mg", number: 12, name: "Magnesium" },
    { symbol: "Te", number: 52, name: "Tellurium" },
    { symbol: "Er", number: 68, name: "Erbium" },
  ];
  return (
    <div className="flex flex-col gap-2.5">
      <Stagger stagger={0.07} delay={0.25} className="flex gap-2">
        {family.map((e) => (
          <ElementTile key={e.symbol} {...e} />
        ))}
      </Stagger>
      <p className="text-[11px] text-faint">Named like the projects it's built on.</p>
    </div>
  );
}

function ElementTile({ symbol, number, name, own = false, size = "md" }: { symbol: string; number: number; name: string; own?: boolean; size?: "sm" | "md" }) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 10, scale: 0.9 },
        show: { opacity: 1, y: 0, scale: 1, transition: SPRING_PLAYFUL },
      }}
      whileHover={{ y: -3 }}
      transition={SPRING_UI}
      title={`${name} · element ${number}`}
      className={cn(
        "relative flex shrink-0 flex-col justify-between overflow-hidden rounded-xl ring-1",
        size === "md" ? "size-[68px] p-2" : "size-12 p-1.5",
        own
          ? "bg-brand text-white shadow-[0_10px_30px_-10px_rgb(139_92_246/0.8),inset_0_1px_0_rgb(255_255_255/0.25)] ring-white/20"
          : "bg-white/[0.04] text-foreground ring-white/[0.08]",
      )}
    >
      {own && <span aria-hidden className="absolute -right-3 -bottom-3 size-8 rounded-full bg-[radial-gradient(closest-side,rgb(34_211_238/0.7),transparent)]" />}
      <span className={cn("relative font-mono leading-none tabular-nums", size === "md" ? "text-[10px]" : "text-[9px]", own ? "text-white/80" : "text-muted-foreground")}>
        {number}
      </span>
      <span className={cn("relative leading-none font-bold tracking-tight", size === "md" ? "text-xl" : "text-base")}>{symbol}</span>
      {size === "md" && <span className={cn("relative truncate text-[9px] leading-none", own ? "text-white/75" : "text-faint")}>{name}</span>}
    </motion.div>
  );
}

// ---- Credits -------------------------------------------------------------------------------------

function CreditGroup({ title, hint, icon, items, big }: { title: string; hint: string; icon: LucideIcon; items: Credit[]; big: boolean }) {
  return (
    <section className="flex flex-col gap-3">
      <Reveal className="flex items-center gap-3">
        <IconTile icon={icon} size="sm" />
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold">
            {title}
            <span className="ml-2 text-xs font-normal text-faint tabular-nums">{items.length}</span>
          </h3>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
      </Reveal>
      <Stagger className={cn("grid gap-3", big ? "md:grid-cols-2 xl:grid-cols-3" : "sm:grid-cols-2 xl:grid-cols-3")}>
        {items.map((c) => (big ? <BigCredit key={c.name} credit={c} /> : <CreditRow key={c.name} credit={c} />))}
      </Stagger>
    </section>
  );
}

/** Opens the project's website; works with mouse and keyboard. */
function CreditCard({ credit, className, children }: { credit: Credit; className?: string; children: ReactNode }) {
  return (
    <GlowCard
      interactive
      kind="scale"
      onClick={() => openExternal(credit.url)}
      aria-label={`${credit.name} by ${credit.author}, ${credit.license}. ${credit.use}. Opens the website.`}
      className={className}
    >
      {children}
    </GlowCard>
  );
}

function CreditMark({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const element = elementOf(name);
  if (element) return <ElementTile symbol={element.symbol} number={element.number} name={name} size="sm" />;
  return (
    <div
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center bg-gradient-to-br from-brand-cyan/25 to-brand-violet/25 font-semibold tracking-tight text-violet-text shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] ring-1 ring-brand-violet/25",
        size === "md" ? "size-12 rounded-xl text-sm" : "size-9 rounded-lg text-xs",
      )}
    >
      {monogram(name, size === "md" ? 2 : 1)}
    </div>
  );
}

function BigCredit({ credit: c }: { credit: Credit }) {
  return (
    <CreditCard credit={c} className="flex h-full flex-col gap-4 p-5">
      <div className="flex items-start gap-4">
        <CreditMark name={c.name} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[15px] font-semibold">
            <span className="truncate">{c.name}</span>
            <ExternalLink className="size-3.5 shrink-0 text-violet-text opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100" />
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{c.author}</p>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{c.use}</p>
      <div className="mt-auto">
        <Badge variant="muted">{c.license}</Badge>
      </div>
    </CreditCard>
  );
}

function CreditRow({ credit: c }: { credit: Credit }) {
  return (
    <CreditCard credit={c} className="flex items-start gap-3 p-4">
      <CreditMark name={c.name} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="flex items-start gap-2 text-sm font-medium">
          <span className="min-w-0 break-words">{c.name}</span>
          <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-violet-text opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100" />
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {c.author} · {c.license}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{c.use}</p>
      </div>
    </CreditCard>
  );
}
