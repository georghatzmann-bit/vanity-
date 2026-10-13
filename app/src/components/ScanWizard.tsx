import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, Check, FolderOpen, FolderPlus, Gamepad2, AppWindow, Radar, X } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { markDuplicates } from "@/lib/dedupe";
import { pickFolder } from "@/lib/dialog";
import { useT } from "@/lib/i18n";
import type { ScannedEntry, ScanOptions } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { toast, useUI } from "@/store/ui";
import { Modal } from "./ui/Modal";
import { Button } from "@shared/ui/Button";
import { Checkbox } from "@shared/ui/Checkbox";
import { AnimatedCheck } from "@shared/ui/AnimatedCheck";
import { cn } from "@shared/lib/cn";
import { sound } from "@shared/sound/engine";

type Step = "sources" | "scanning" | "results" | "done";

const SCAN_KEY = "pulsar-scan-options";
const defaultScan = (): ScanOptions => ({ steam: true, epic: true, gog: true, startMenu: true, folders: [] });

/** Zuletzt gewählte Quellen (nur lokal gemerkt) */
function loadScanOptions(): ScanOptions {
  try {
    const raw = localStorage.getItem(SCAN_KEY);
    if (!raw) return defaultScan();
    const p = JSON.parse(raw) as Partial<ScanOptions>;
    return { ...defaultScan(), ...p, folders: Array.isArray(p.folders) ? p.folders.filter((f) => typeof f === "string") : [] };
  } catch {
    return defaultScan();
  }
}
function saveScanOptions(o: ScanOptions) {
  try {
    localStorage.setItem(SCAN_KEY, JSON.stringify(o));
  } catch {
    /* kein Speicher – egal */
  }
}

/** Radar-Animation während der Suche */
function RadarAnim() {
  return (
    <div className="relative h-56 w-56">
      {[1, 0.72, 0.44].map((s, i) => (
        <div key={i} className="absolute inset-0 m-auto rounded-full border border-accent/25" style={{ width: `${s * 100}%`, height: `${s * 100}%` }} />
      ))}
      <motion.div className="absolute inset-0 rounded-full" style={{ background: "conic-gradient(from 0deg, transparent 0deg, color-mix(in oklab, var(--nv-accent) 55%, transparent) 50deg, transparent 60deg)" }} animate={{ rotate: 360 }} transition={{ duration: 2.2, repeat: Infinity, ease: "linear" }} />
      {Array.from({ length: 7 }, (_, i) => {
        const a = (i / 7) * Math.PI * 2;
        const r = 30 + ((i * 37) % 60);
        return (
          <motion.span key={i} className="absolute h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_10px_var(--nv-accent)]" style={{ left: `calc(50% + ${Math.cos(a) * r}px - 5px)`, top: `calc(50% + ${Math.sin(a) * r}px - 5px)` }} animate={{ opacity: [0, 1, 0], scale: [0.4, 1.2, 0.4] }} transition={{ duration: 2.2, repeat: Infinity, delay: (i / 7) * 2.2 }} />
        );
      })}
      <div className="absolute inset-0 grid place-items-center">
        <Radar className="h-8 w-8 text-accent" />
      </div>
    </div>
  );
}

export function ScanWizard() {
  const t = useT();
  const open = useUI((s) => s.scanOpen);
  const setOpen = useUI((s) => s.setScan);
  const [opts, setOpts] = useState<ScanOptions>(loadScanOptions);
  const [step, setStep] = useState<Step>("sources");
  const [found, setFound] = useState<{ entry: ScannedEntry; duplicate: boolean }[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [added, setAdded] = useState(0);

  useEffect(() => {
    if (open) {
      setOpts(loadScanOptions());
      setStep("sources");
      setFound([]);
      setMessages([]);
    }
  }, [open]);

  const start = async () => {
    setStep("scanning");
    saveScanOptions(opts);
    sound.play("whoosh");
    try {
      const [res] = await Promise.all([api.scanLibrary(opts), new Promise((r) => setTimeout(r, 1200))]);
      const marked = markDuplicates(res.entries, useLibrary.getState().games);
      setFound(marked);
      setMessages(res.messages);
      // Vorauswahl: alle neuen Spiele; Programme nur, wenn sie nicht aus dem Startmenü kommen (sonst zu viele)
      setSelected(new Set(marked.flatMap((m, i) => (!m.duplicate && (m.entry.kind === "game" || m.entry.source !== "startmenu") ? [i] : []))));
      setStep("results");
      sound.play("success");
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
      setStep("sources");
    }
  };

  const doImport = async () => {
    const entries = found.filter((_, i) => selected.has(i)).map((f) => f.entry);
    try {
      const created = await useLibrary.getState().addEntries(entries);
      setAdded(created.length);
      setStep("done");
      sound.play("achievement", { gain: 0.6 });
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    }
  };

  const fresh = found.filter((f) => !f.duplicate).length;
  const groups = useMemo(() => {
    const m = new Map<string, number[]>();
    found.forEach((f, i) => {
      const k = f.entry.source;
      m.set(k, [...(m.get(k) ?? []), i]);
    });
    return [...m.entries()];
  }, [found]);

  const toggle = (i: number) => {
    const s = new Set(selected);
    if (s.has(i)) s.delete(i);
    else s.add(i);
    setSelected(s);
  };

  const source = (k: keyof Omit<ScanOptions, "folders">, desc: string) => (
    <Checkbox key={k} checked={opts[k]} onChange={(v) => setOpts({ ...opts, [k]: v })} label={t(`scan.${k}`)} description={desc} className="rounded-lg border border-line bg-surface p-3.5 transition hover:border-line-strong" />
  );

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      locked={step === "scanning"}
      title={step === "results" ? t("scan.foundTitle") : t("scan.title")}
      subtitle={step === "results" ? t("scan.foundText") : step === "sources" ? t("scan.subtitle") : undefined}
      width={720}
      footer={
        step === "sources" ? (
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" icon={<Radar className="h-4 w-4" />} onClick={() => void start()}>
              {t("scan.start")}
            </Button>
          </>
        ) : step === "results" ? (
          <>
            <span className="mr-auto text-[13px] text-muted">{t("scan.found", { n: fresh })}</span>
            <Button variant="ghost" onClick={() => setStep("sources")}>
              {t("common.back")}
            </Button>
            <Button variant="primary" disabled={selected.size === 0} icon={<Check className="h-4 w-4" />} onClick={() => void doImport()}>
              {t("scan.import", { n: selected.size })}
            </Button>
          </>
        ) : step === "done" ? (
          <Button variant="primary" onClick={() => (setOpen(false), useUI.getState().navigate({ page: "games" }))}>
            {t("common.done")}
          </Button>
        ) : undefined
      }
    >
      <AnimatePresence mode="wait">
        {step === "sources" && (
          <motion.div key="s" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            <div className="mb-3 text-[12px] font-semibold tracking-wider text-muted uppercase">{t("scan.sources")}</div>
            <div className="grid grid-cols-2 gap-3">
              {source("steam", t("scan.steamDesc"))}
              {source("epic", t("scan.epicDesc"))}
              {source("gog", t("scan.gogDesc"))}
              {source("startMenu", t("scan.startMenuDesc"))}
            </div>
            <div className="mt-5 mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">{t("scan.folders")}</div>
            <div className="flex flex-col gap-1.5">
              {opts.folders.map((f) => (
                <div key={f} className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-fg">
                  <FolderOpen className="h-4 w-4 text-muted" />
                  <span className="flex-1 truncate font-mono text-[12px]">{f}</span>
                  <button type="button" onClick={() => setOpts({ ...opts, folders: opts.folders.filter((x) => x !== f) })} className="text-faint hover:text-danger" aria-label={t("common.remove")}>
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={async () => {
                  const p = await pickFolder();
                  if (p && !opts.folders.includes(p)) setOpts({ ...opts, folders: [...opts.folders, p] });
                }}
                className="flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line py-3 text-[13px] text-muted transition hover:border-accent/50 hover:text-fg"
              >
                <FolderPlus className="h-4 w-4" /> {t("scan.addFolder")} <span className="text-faint">· {t("scan.foldersDesc")}</span>
              </button>
            </div>
          </motion.div>
        )}
        {step === "scanning" && (
          <motion.div key="r" className="flex flex-col items-center py-6" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
            <RadarAnim />
            <div className="mt-6 text-sm font-medium text-fg">{t("scan.scanning")}</div>
          </motion.div>
        )}
        {step === "results" && (
          <motion.div key="res" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            {messages.length > 0 && (
              <div className="mb-4 flex flex-col gap-1 rounded-lg bg-surface-2 p-3">
                {messages.map((m) => (
                  <div key={m} className="flex items-start gap-2 text-[12px] text-muted">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" /> {m}
                  </div>
                ))}
              </div>
            )}
            {found.length === 0 || fresh === 0 ? (
              <div className="py-10 text-center text-sm text-muted">{t("scan.nothingNew")}</div>
            ) : (
              <>
                <div className="mb-3 flex gap-3 text-[13px]">
                  <button type="button" className="font-medium text-accent hover:underline" onClick={() => setSelected(new Set(found.map((f, i) => (f.duplicate ? -1 : i)).filter((i) => i >= 0)))}>
                    {t("scan.selectAll")}
                  </button>
                  <button type="button" className="text-muted hover:text-fg" onClick={() => setSelected(new Set())}>
                    {t("scan.selectNone")}
                  </button>
                </div>
                <div className="flex flex-col gap-4">
                  {groups.map(([src, idxs]) => (
                    <div key={src}>
                      <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-faint uppercase">
                        {t(`source.${src}`)} · {idxs.length}
                      </div>
                      <div className="flex flex-col">
                        {idxs.map((i, n) => {
                          const f = found[i];
                          return (
                            <motion.button
                              key={i}
                              type="button"
                              disabled={f.duplicate}
                              initial={{ opacity: 0, y: 6 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: Math.min(n, 20) * 0.02 }}
                              onClick={() => (sound.play("tick"), toggle(i))}
                              className={cn("flex items-center gap-3 rounded-lg px-3 py-2 text-left transition", f.duplicate ? "opacity-45" : "hover:bg-surface-2")}
                            >
                              <span className={cn("grid h-5 w-5 shrink-0 place-items-center rounded-md border", selected.has(i) ? "border-transparent bg-gradient-accent" : "border-line-strong")}>{selected.has(i) && <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />}</span>
                              {f.entry.kind === "game" ? <Gamepad2 className="h-4 w-4 text-muted" /> : <AppWindow className="h-4 w-4 text-muted" />}
                              <span className="min-w-0 flex-1 truncate text-sm text-fg">{f.entry.name}</span>
                              {f.duplicate && <span className="text-[11px] text-faint">{t("scan.duplicate")}</span>}
                            </motion.button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </motion.div>
        )}
        {step === "done" && (
          <motion.div key="d" className="flex flex-col items-center py-8 text-center" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
            <AnimatedCheck size={96} />
            <div className="mt-5 font-display text-2xl font-bold text-fg">{t("scan.added", { n: added })}</div>
            <div className="mt-2 text-sm text-muted">{t("scan.fetchingImages")}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  );
}
