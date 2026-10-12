import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { SystemStats } from "@/lib/types";
import { Ring } from "../ui/Ring";
import { Widget } from "./Widget";

function color(v: number) {
  if (v >= 90) return "var(--nv-danger)";
  if (v >= 75) return "var(--nv-warning)";
  return undefined;
}

export function SystemWidget() {
  const t = useT();
  const [s, setS] = useState<SystemStats | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.systemStats().then((x) => alive && setS(x)).catch(() => undefined);
    void load();
    const id = window.setInterval(() => !document.hidden && load(), 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const ram = s ? (s.ramUsed / Math.max(1, s.ramTotal)) * 100 : 0;
  const items: { label: string; v: number | null; sub?: string }[] = [
    { label: t("widgets.cpu"), v: s ? s.cpu : null, sub: s?.cpuName },
    { label: t("widgets.ram"), v: s ? ram : null, sub: s ? `${formatBytes(s.ramUsed)} / ${formatBytes(s.ramTotal)}` : undefined },
    { label: t("widgets.gpu"), v: s ? s.gpu : null, sub: s?.gpuName },
  ];

  return (
    <Widget title={t("widgets.system")} icon={<Cpu className="h-3.5 w-3.5" />}>
      <div className="flex flex-1 items-center justify-around gap-2">
        {items.map((it) => (
          <div key={it.label} className="flex flex-col items-center gap-2" title={it.sub}>
            <Ring value={(it.v ?? 0) / 100} size={66} stroke={6} color={it.v !== null ? color(it.v) : "var(--nv-faint)"}>
              <span className="text-[14px] font-semibold text-fg tabular">{it.v === null ? (s ? t("widgets.notAvailable") : "…") : `${Math.round(it.v)}%`}</span>
            </Ring>
            <span className="text-[11px] font-semibold tracking-wider text-muted uppercase">{it.label}</span>
          </div>
        ))}
      </div>
    </Widget>
  );
}
