import { ExternalLink } from "lucide-react";
import { PageHeader, PageShell, Panel, Reveal } from "@/components/common";
import { LogoMark } from "@/components/layout/Logo";
import { credits } from "@/lib/demo-data";
import { openExternal } from "@/lib/window";

export function AboutPage() {
  return (
    <PageShell>
      <PageHeader
        title="Über & Credits"
        description="Vanity steht auf den Schultern vieler Open-Source-Projekte. Hier steht, wer was gemacht hat."
      />

      <Reveal className="glass flex flex-wrap items-center gap-6 rounded-xl p-6">
        <LogoMark className="size-16" />
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold tracking-tight">Vanity 0.1.0</h2>
          <p className="mt-1 text-sm text-muted-foreground">Phase 1 · Design-Vorschau · nur für den eigenen Gebrauch</p>
          <p className="mt-3 max-w-2xl text-xs text-muted-foreground">
            Ein Launcher für OG-Fortnite-Privatserver mit eigenen, alten Builds. Vanity ist nicht mit Epic Games
            verbunden. „Fortnite“ ist eine Marke von Epic Games, Inc. Lizenz: GPL-3.0.
          </p>
        </div>
      </Reveal>

      {credits.map((group) => (
        <Panel key={group.group} title={group.group} bodyClassName="px-3">
          <ul className="grid gap-1 md:grid-cols-2">
            {group.items.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  onClick={() => openExternal(c.url)}
                  className="group flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left outline-none transition-colors hover:bg-white/[0.04] focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {c.name}
                      <ExternalLink className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {c.author} · {c.license}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{c.use}</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      ))}
    </PageShell>
  );
}
