import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import {
  AlertTriangle, ArrowLeft, ArrowRight, BarChart3, Download, FolderOpen, Gamepad2, HardDrive, Library, Monitor, Power, RefreshCw, Rocket, ShieldCheck, Sparkles, Trash2, Tv, Volume2, VolumeX, LayoutList,
} from "lucide-react";
import { api, on, pickFolder, type DiskInfo, type ErrorCode, type InstallDone, type InstallError, type InstallOptions, type Manifest, type Phase, type Progress, type SetupInfo, type UninstallProgress } from "./api";
import { formatBytes, formatEta, getLang, setLang, useT, type Lang } from "./i18n";
import { Backdrop } from "./components/Backdrop";
import { OptionCard } from "./components/OptionCard";
import { StepRail } from "./components/StepRail";
import { WaveRing } from "./components/WaveRing";
import { AnimatedCheck } from "@shared/ui/AnimatedCheck";
import { Button } from "@shared/ui/Button";
import { Checkbox } from "@shared/ui/Checkbox";
import { NovaLogo } from "@shared/ui/NovaLogo";
import { WindowControls } from "@shared/ui/WindowControls";
import type { StarfieldHandle } from "@shared/ui/Starfield";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

type Step = "intro" | "welcome" | "maintenance" | "folder" | "options" | "install" | "done" | "un-confirm" | "un-run" | "un-done";
const RAIL: Step[] = ["welcome", "folder", "options", "install", "done"];
const PHASES: Exclude<Phase, "done">[] = ["connect", "download", "verify", "install", "shortcuts", "register"];

function readMuted() {
  try {
    return localStorage.getItem("nova-setup-muted") === "1";
  } catch {
    return false;
  }
}

/** Seiteninhalt mit Richtungs-Übergang */
function Page({ children, k, dir }: { children: React.ReactNode; k: string; dir: number }) {
  return (
    <motion.div key={k} className="absolute inset-0 flex flex-col" initial={{ opacity: 0, x: 40 * dir, filter: "blur(6px)" }} animate={{ opacity: 1, x: 0, filter: "blur(0px)" }} exit={{ opacity: 0, x: -40 * dir, filter: "blur(6px)" }} transition={{ ...spring.smooth, opacity: { duration: 0.3 } }}>
      {children}
    </motion.div>
  );
}

export function App() {
  const t = useT();
  const stars = useRef<StarfieldHandle>(null);
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("intro");
  const [dir, setDir] = useState(1);
  const [muted, setMuted] = useState(readMuted);
  const [lang, setLangState] = useState<Lang>(getLang());
  const [opts, setOpts] = useState<InstallOptions>({ dir: "", desktopShortcut: true, startMenu: true, autostart: false, launchAfter: true });
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<InstallError | null>(null);
  const [done, setDone] = useState<InstallDone | null>(null);
  const [keepData, setKeepData] = useState(true);
  const [unProgress, setUnProgress] = useState<UninstallProgress | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastProgressSound = useRef(0);

  const go = useCallback((s: Step, d = 1) => {
    setDir(d);
    setStep(s);
    sound.play("whoosh", { gain: 0.6 });
  }, []);

  useEffect(() => {
    sound.setMuted(muted);
    try {
      localStorage.setItem("nova-setup-muted", muted ? "1" : "0");
    } catch {
      /* egal */
    }
  }, [muted]);

  // Start: Infos laden, Intro abspielen
  useEffect(() => {
    sound.play("startup");
    const burst = window.setTimeout(() => stars.current?.burst(490, 270, { count: 170, speed: 9, life: 2 }), 650);
    let introDone = false;
    let loaded: SetupInfo | null = null;
    const next = (si: SetupInfo) => {
      if (si.mode === "uninstall") go("un-confirm");
      else if (si.mode === "update") {
        startInstallRef.current?.({ ...defaultOpts(si), dir: si.installed?.dir ?? si.defaultDir });
      } else if (si.preset) {
        setOpts(si.preset);
        startInstallRef.current?.(si.preset);
      } else if (si.mode === "maintenance") go("maintenance");
      else go("welcome");
    };
    const timer = window.setTimeout(() => {
      introDone = true;
      if (loaded) next(loaded);
    }, 2600);
    void api
      .setupInfo()
      .then((si) => {
        setInfo(si);
        setLang(si.systemLang);
        setLangState(si.systemLang);
        setOpts((o) => ({ ...o, dir: si.preset?.dir ?? si.installed?.dir ?? si.defaultDir }));
        loaded = si;
        if (introDone) next(si);
      })
      .catch(() => {
        loaded = { mode: "install", setupVersion: "1.0.0", appName: "Nova Launcher", defaultDir: "", elevated: false, systemLang: "de", manifestUrl: "" };
        if (introDone) next(loaded);
      });
    void api
      .fetchManifest()
      .then(setManifest)
      .catch((e) => setManifestError(e instanceof Error ? e.message : String(e)));
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(burst);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Backend-Events
  useEffect(() => {
    const uns: Promise<() => void>[] = [
      on<Progress>("install://progress", (p) => {
        setProgress(p);
        setError(null);
        const now = performance.now();
        if (p.phase === "download" && now - lastProgressSound.current > 1200) {
          lastProgressSound.current = now;
          sound.play("progress", { value: p.percent / 100 });
        }
      }),
      on<InstallError>("install://error", (e) => {
        setError(e);
        setBusy(false);
        if (e.code !== "cancelled") sound.play("error");
      }),
      on<InstallDone>("install://done", (d) => {
        setDone(d);
        setBusy(false);
        setProgress((p) => (p ? { ...p, phase: "done", percent: 100 } : p));
        window.setTimeout(() => {
          go("done");
          sound.play("jingle");
          window.setTimeout(() => stars.current?.burst(640, 250, { count: 220, speed: 12, life: 2.2 }), 350);
        }, 650);
      }),
      on<UninstallProgress>("uninstall://progress", (p) => {
        setUnProgress(p);
        sound.play("tick");
        stars.current?.burst(150, 230, { count: 30, speed: 5, life: 1.4 });
      }),
      on<Record<string, never>>("uninstall://done", () => {
        window.setTimeout(() => {
          go("un-done");
          sound.play("farewell");
        }, 500);
      }),
      on<{ message: string }>("uninstall://error", (e) => {
        setError({ phase: "install", code: "unknown", message: e.message, retryable: true });
        sound.play("error");
      }),
    ];
    return () => uns.forEach((u) => void u.then((f) => f()));
  }, [go]);

  // Speicherplatz prüfen, wenn sich der Ordner ändert
  useEffect(() => {
    if (step !== "folder" || !opts.dir) return;
    const id = window.setTimeout(() => {
      void api
        .diskSpace(opts.dir)
        .then(setDisk)
        .catch(() => setDisk(null));
    }, 250);
    return () => window.clearTimeout(id);
  }, [opts.dir, step]);

  const startInstall = useCallback(
    async (o: InstallOptions) => {
      setError(null);
      setBusy(true);
      setStep((s) => (s === "install" ? s : (setDir(1), "install")));
      try {
        // Ordner braucht Adminrechte? Dann mit UAC neu starten (nur wenn nötig).
        const d = await api.diskSpace(o.dir).catch(() => null);
        if (d?.needsAdmin && !info?.elevated) {
          await api.relaunchElevated(o);
          return;
        }
        await api.startInstall(o);
      } catch (e) {
        setBusy(false);
        setError({ phase: "connect", code: "unknown", message: e instanceof Error ? e.message : String(e), retryable: true });
        sound.play("error");
      }
    },
    [info],
  );
  const startInstallRef = useRef(startInstall);
  startInstallRef.current = startInstall;

  const retry = async () => {
    if (error?.code === "running") {
      await api.closeApp().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 800));
    }
    void startInstall(opts);
  };

  const finish = async (launch: boolean) => {
    if (launch) {
      sound.play("launch", { gain: 0.6 });
      await api.launchApp().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 900));
    }
    await api.quit();
  };

  // Nach einem Update startet NOVA automatisch neu
  useEffect(() => {
    if (step === "done" && info?.mode === "update") {
      const id = window.setTimeout(() => void finish(true), 2600);
      return () => window.clearTimeout(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, info]);

  const onClose = () => {
    if (step === "install" && busy) setConfirmClose(true);
    else void api.quit();
  };

  const isUninstall = step.startsWith("un-");
  const railIndex = Math.max(0, RAIL.indexOf(step === "maintenance" ? "welcome" : step));
  const showRail = step !== "intro";
  const size = manifest?.app.size;
  const requiredOk = !disk || (disk.valid && disk.free >= disk.required);

  const phaseIndex = progress ? (progress.phase === "done" ? PHASES.length : PHASES.indexOf(progress.phase as Exclude<Phase, "done">)) : 0;

  return (
    <LayoutGroup>
      <div className="relative h-full w-full overflow-hidden" style={{ background: "var(--nv-bg)" }}>
        <Backdrop ref={stars} />

        {/* Titelleiste */}
        <div data-tauri-drag-region className="absolute inset-x-0 top-0 z-30 flex h-11 items-center justify-between pl-5">
          <div data-tauri-drag-region className="text-[12px] font-medium tracking-[0.18em] text-faint uppercase">
            {step !== "intro" && "Nova Setup"}
          </div>
          <div className="flex h-full items-center">
            <button type="button" onClick={() => setMuted(!muted)} className="no-drag grid h-full w-11 place-items-center text-muted transition hover:text-fg" aria-label={muted ? t("common.unmute") : t("common.mute")} title={muted ? t("common.unmute") : t("common.mute")}>
              {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
            <WindowControls maximizable={false} onClose={onClose} />
          </div>
        </div>

        {/* Intro */}
        <AnimatePresence>
          {step === "intro" && (
            <motion.div key="intro" className="absolute inset-0 z-20 grid place-items-center" exit={{ opacity: 0 }} transition={{ duration: 0.5 }}>
              <div className="flex flex-col items-center">
                <motion.div layoutId="setup-logo" transition={{ type: "spring", stiffness: 110, damping: 18 }}>
                  <NovaLogo size={140} mode="intro" />
                </motion.div>
                <motion.div className="mt-8 font-display text-[40px] font-bold tracking-[0.42em] text-fg" initial={{ opacity: 0, letterSpacing: "0.9em", filter: "blur(10px)" }} animate={{ opacity: 1, letterSpacing: "0.42em", filter: "blur(0px)" }} transition={{ duration: 1.3, delay: 0.8, ease: [0.22, 1, 0.36, 1] }}>
                  NOVA
                </motion.div>
                <motion.div className="mt-2 text-[12px] tracking-[0.35em] text-muted uppercase" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.4 }}>
                  {t("tagline")}
                </motion.div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {showRail && (
          <div className="relative z-10 flex h-full">
            {/* Linke Spalte */}
            <motion.aside className="flex w-[300px] shrink-0 flex-col px-9 pt-16 pb-7" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ ...spring.smooth, delay: 0.1 }}>
              <div className="flex items-center gap-3">
                <motion.div layoutId="setup-logo" transition={{ type: "spring", stiffness: 110, damping: 18 }}>
                  <NovaLogo size={isUninstall && step === "un-run" ? 44 : 52} mode="idle" />
                </motion.div>
                <div>
                  <div className="font-display text-xl font-bold tracking-[0.22em] text-fg">NOVA</div>
                  <div className="text-[11px] tracking-wider text-muted">{t("tagline")}</div>
                </div>
              </div>
              <div className="mt-12 flex-1">{!isUninstall && <StepRail steps={RAIL.map((s) => t(`steps.${s}`))} current={step === "done" ? RAIL.length : railIndex} />}</div>
              <div className="flex items-center justify-between text-[11px] text-faint">
                <div className="flex gap-1 rounded-md border border-line p-0.5">
                  {(["de", "en"] as Lang[]).map((l) => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => {
                        setLang(l);
                        setLangState(l);
                        sound.play("click");
                      }}
                      className={cn("h-6 rounded px-2 font-semibold uppercase transition", lang === l ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <span>v{info?.setupVersion ?? "1.0.0"}</span>
              </div>
            </motion.aside>

            {/* Inhalt */}
            <main className="glass-strong relative mt-12 mr-4 mb-4 flex-1 overflow-hidden rounded-2xl">
              <AnimatePresence mode="wait" custom={dir}>
                {step === "welcome" && (
                  <Page k="welcome" dir={dir}>
                    <div className="flex flex-1 flex-col px-10 pt-14">
                      <motion.h1 className="font-display text-[34px] leading-tight font-bold text-fg" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
                        {t("welcome.title").replace("NOVA", "")}
                        <span className="text-gradient">NOVA</span>
                      </motion.h1>
                      <motion.p className="mt-3 max-w-[520px] text-[15px] leading-relaxed text-fg-soft" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
                        {t("welcome.text")}
                      </motion.p>
                      <div className="mt-8 grid grid-cols-3 gap-3">
                        {[
                          { i: <Library className="h-5 w-5" />, a: t("welcome.f1"), b: t("welcome.f1d") },
                          { i: <BarChart3 className="h-5 w-5" />, a: t("welcome.f2"), b: t("welcome.f2d") },
                          { i: <Tv className="h-5 w-5" />, a: t("welcome.f3"), b: t("welcome.f3d") },
                        ].map((f, i) => (
                          <motion.div key={i} className="glow-edge rounded-xl border border-line bg-surface p-4 [--glow-opacity:0] hover:[--glow-opacity:1]" initial={{ opacity: 0, y: 20, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ ...spring.gravity, delay: 0.3 + i * 0.08 }} whileHover={{ y: -4 }} onMouseEnter={() => sound.play("hover")}>
                            <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-accent text-white shadow-glow">{f.i}</span>
                            <div className="mt-3 text-[13px] font-semibold text-fg">{f.a}</div>
                            <div className="text-[12px] text-muted">{f.b}</div>
                          </motion.div>
                        ))}
                      </div>
                      <div className="mt-6 flex items-center gap-3 text-[12px] text-muted">
                        {manifest ? (
                          <>
                            <span className="rounded-full bg-surface-2 px-2.5 py-1">{t("welcome.version", { v: manifest.version })}</span>
                            {size ? <span className="rounded-full bg-surface-2 px-2.5 py-1">{t("welcome.size", { size: formatBytes(size) })}</span> : null}
                          </>
                        ) : manifestError ? (
                          <span className="flex items-center gap-1.5 text-warning">
                            <AlertTriangle className="h-3.5 w-3.5" /> {t("welcome.manifestError")}
                          </span>
                        ) : (
                          <span className="skeleton h-6 w-40 rounded-full" />
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-6 border-t border-line px-10 py-5">
                      <p className="max-w-[380px] text-[11px] leading-snug text-faint">{t("welcome.license")}</p>
                      <Button variant="primary" size="lg" iconRight={<ArrowRight className="h-4 w-4" />} onClick={() => go("folder")}>
                        {t("welcome.start")}
                      </Button>
                    </div>
                  </Page>
                )}

                {step === "maintenance" && info?.installed && (
                  <Page k="maint" dir={dir}>
                    <div className="flex flex-1 flex-col px-10 pt-14">
                      <h1 className="font-display text-3xl font-bold text-fg">{t("maintenance.title")}</h1>
                      <p className="mt-3 text-[14px] text-fg-soft">{t("maintenance.text", { v: info.installed.version, dir: info.installed.dir })}</p>
                      <div className="mt-8 flex flex-col gap-3">
                        <motion.button type="button" whileHover={{ y: -3 }} whileTap={{ scale: 0.98 }} onMouseEnter={() => sound.play("hover")} onClick={() => void startInstall({ ...opts, dir: info.installed!.dir })} className="glow-edge flex items-center gap-4 rounded-xl border border-line bg-surface p-5 text-left [--glow-opacity:0] hover:[--glow-opacity:1]">
                          <span className="grid h-12 w-12 place-items-center rounded-xl bg-gradient-accent text-white shadow-glow">
                            <RefreshCw className="h-5 w-5" />
                          </span>
                          <span>
                            <span className="block font-semibold text-fg">{t("maintenance.update")}</span>
                            <span className="block text-[13px] text-muted">{t("maintenance.updateDesc")}</span>
                          </span>
                        </motion.button>
                        <motion.button type="button" whileHover={{ y: -3 }} whileTap={{ scale: 0.98 }} onMouseEnter={() => sound.play("hover")} onClick={() => go("un-confirm")} className="flex items-center gap-4 rounded-xl border border-line bg-surface p-5 text-left transition hover:border-danger/40">
                          <span className="grid h-12 w-12 place-items-center rounded-xl bg-danger/15 text-danger">
                            <Trash2 className="h-5 w-5" />
                          </span>
                          <span>
                            <span className="block font-semibold text-fg">{t("maintenance.uninstall")}</span>
                            <span className="block text-[13px] text-muted">{t("maintenance.uninstallDesc")}</span>
                          </span>
                        </motion.button>
                      </div>
                    </div>
                  </Page>
                )}

                {step === "folder" && (
                  <Page k="folder" dir={dir}>
                    <div className="flex flex-1 flex-col px-10 pt-14">
                      <h1 className="font-display text-3xl font-bold text-fg">{t("folder.title")}</h1>
                      <p className="mt-2 text-[14px] text-muted">{t("folder.text")}</p>
                      <div className="mt-8 flex gap-2">
                        <div className="relative flex-1">
                          <FolderOpen className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-accent" />
                          <input value={opts.dir} onChange={(e) => setOpts({ ...opts, dir: e.target.value })} className="input pl-10 font-mono text-[12.5px]" spellCheck={false} />
                        </div>
                        <Button
                          size="lg"
                          className="h-11"
                          onClick={async () => {
                            const p = await pickFolder(opts.dir);
                            if (p) setOpts({ ...opts, dir: /nova/i.test(p) ? p : `${p.replace(/[\\/]+$/, "")}\\Nova Launcher` });
                          }}
                        >
                          {t("folder.browse")}
                        </Button>
                        {info && opts.dir !== info.defaultDir && (
                          <Button size="lg" variant="ghost" className="h-11" onClick={() => setOpts({ ...opts, dir: info.defaultDir })}>
                            {t("folder.reset")}
                          </Button>
                        )}
                      </div>

                      <div className="mt-6 rounded-xl border border-line bg-surface p-5">
                        <div className="flex items-center justify-between text-[13px]">
                          <span className="flex items-center gap-2 font-medium text-fg">
                            <HardDrive className="h-4 w-4 text-accent" /> {disk?.path.slice(0, 3) ?? "–"}
                          </span>
                          <span className="text-muted">
                            {t("folder.required")}: <b className="text-fg">{disk ? formatBytes(disk.required) : "…"}</b> · {t("folder.free")}: <b className="text-fg">{disk ? formatBytes(disk.free) : "…"}</b>
                          </span>
                        </div>
                        <div className="relative mt-3 h-3 overflow-hidden rounded-full bg-surface-3">
                          {disk && disk.total > 0 && (
                            <>
                              <motion.div className="absolute inset-y-0 left-0 rounded-full bg-[var(--nv-fg)]/20" initial={{ width: 0 }} animate={{ width: `${((disk.total - disk.free) / disk.total) * 100}%` }} transition={spring.smooth} />
                              <motion.div className="absolute inset-y-0 rounded-full bg-gradient-accent shadow-[0_0_10px_var(--nv-accent)]" initial={{ width: 0 }} animate={{ left: `${((disk.total - disk.free) / disk.total) * 100}%`, width: `max(6px, ${(disk.required / disk.total) * 100}%)` }} transition={{ ...spring.smooth, delay: 0.2 }} />
                            </>
                          )}
                        </div>
                      </div>

                      <AnimatePresence>
                        {disk && (!disk.valid || disk.needsAdmin || disk.free < disk.required) && (
                          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={cn("mt-4 flex items-start gap-3 rounded-xl p-4 text-[13px]", !disk.valid || disk.free < disk.required ? "bg-danger/10 text-fg ring-1 ring-danger/30" : "bg-warning/10 text-fg ring-1 ring-warning/30")}>
                            {!disk.valid || disk.free < disk.required ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" /> : <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
                            <span>{!disk.valid ? disk.message ?? t("folder.invalid") : disk.free < disk.required ? t("folder.lowSpace") : t("folder.needsAdmin")}</span>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                    <div className="flex items-center justify-between border-t border-line px-10 py-5">
                      <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => go("welcome", -1)}>
                        {t("common.back")}
                      </Button>
                      <Button variant="primary" size="lg" disabled={!requiredOk || !opts.dir.trim()} iconRight={<ArrowRight className="h-4 w-4" />} onClick={() => go("options")}>
                        {t("common.next")}
                      </Button>
                    </div>
                  </Page>
                )}

                {step === "options" && (
                  <Page k="options" dir={dir}>
                    <div className="flex flex-1 flex-col px-10 pt-14">
                      <h1 className="font-display text-3xl font-bold text-fg">{t("options.title")}</h1>
                      <p className="mt-2 text-[14px] text-muted">{t("options.text")}</p>
                      <div className="mt-7 grid grid-cols-1 gap-3">
                        <OptionCard icon={<Monitor className="h-5 w-5" />} title={t("options.desktop")} desc={t("options.desktopDesc")} checked={opts.desktopShortcut} onChange={(v) => setOpts({ ...opts, desktopShortcut: v })} />
                        <OptionCard icon={<LayoutList className="h-5 w-5" />} title={t("options.startMenu")} desc={t("options.startMenuDesc")} checked={opts.startMenu} onChange={(v) => setOpts({ ...opts, startMenu: v })} />
                        <OptionCard icon={<Power className="h-5 w-5" />} title={t("options.autostart")} desc={t("options.autostartDesc")} checked={opts.autostart} onChange={(v) => setOpts({ ...opts, autostart: v })} />
                        <OptionCard icon={<Rocket className="h-5 w-5" />} title={t("options.launch")} desc={t("options.launchDesc")} checked={opts.launchAfter} onChange={(v) => setOpts({ ...opts, launchAfter: v })} />
                      </div>
                    </div>
                    <div className="flex items-center justify-between border-t border-line px-10 py-5">
                      <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => go("folder", -1)}>
                        {t("common.back")}
                      </Button>
                      <Button variant="primary" size="lg" icon={<Download className="h-4 w-4" />} onClick={() => void startInstall(opts)}>
                        {t("options.install")}
                      </Button>
                    </div>
                  </Page>
                )}

                {step === "install" && (
                  <Page k="install" dir={dir}>
                    <div className="flex flex-1 items-center gap-10 px-10 pt-10">
                      <div className="flex flex-col items-center">
                        <WaveRing value={(progress?.percent ?? 0) / 100} error={!!error}>
                          <div className="text-center">
                            <div className="font-display text-5xl font-bold text-white tabular [text-shadow:0_2px_16px_rgb(0_0_0/0.4)]">
                              {Math.floor(progress?.percent ?? 0)}
                              <span className="text-2xl">%</span>
                            </div>
                            {progress?.phase === "download" && progress.total > 0 && (
                              <div className="mt-1 text-[11px] font-medium text-white/80 tabular">
                                {formatBytes(progress.downloaded)} / {formatBytes(progress.total)}
                              </div>
                            )}
                          </div>
                        </WaveRing>
                        <div className="mt-5 flex h-5 gap-4 text-[12px] text-muted tabular">
                          {progress?.phase === "download" && !error && (
                            <>
                              <span>{t("install.speed", { speed: formatBytes(progress.speed) })}</span>
                              <span>{progress.eta > 0 ? t("install.remaining", { time: formatEta(progress.eta) }) : t("install.calculating")}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <h1 className="font-display text-2xl font-bold text-fg">{info?.mode === "update" ? t("install.updateTitle", { v: manifest?.version ?? "" }) : t("install.title")}</h1>
                        <AnimatePresence mode="wait">
                          {error && error.code !== "cancelled" ? (
                            <motion.div key="err" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-6 rounded-xl bg-danger/10 p-5 ring-1 ring-danger/30">
                              <div className="flex items-center gap-2 font-semibold text-fg">
                                <AlertTriangle className="h-5 w-5 text-danger" /> {t(`errors.${error.code as ErrorCode}`)}
                              </div>
                              <p className="mt-2 text-[13px] break-words text-fg-soft">{error.message}</p>
                              {error.code === "network" && <p className="mt-2 text-[12px] text-muted">{t("errors.resumeHint")}</p>}
                              <div className="mt-4 flex gap-2">
                                {error.retryable && (
                                  <Button variant="primary" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void retry()}>
                                    {error.code === "running" ? t("errors.closeApp") : t("errors.retry")}
                                  </Button>
                                )}
                                {info?.mode !== "update" && (
                                  <Button variant="ghost" onClick={() => go(error.code === "disk" || error.code === "permission" ? "folder" : "options", -1)}>
                                    {t("errors.back")}
                                  </Button>
                                )}
                              </div>
                            </motion.div>
                          ) : error?.code === "cancelled" ? (
                            <motion.div key="cancel" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-6 text-sm text-muted">
                              {t("errors.cancelled")}
                              <div className="mt-4 flex gap-2">
                                <Button variant="primary" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void retry()}>
                                  {t("errors.retry")}
                                </Button>
                                <Button variant="ghost" onClick={() => void api.quit()}>
                                  {t("common.close")}
                                </Button>
                              </div>
                            </motion.div>
                          ) : (
                            <motion.ol key="steps" className="mt-6 flex flex-col gap-2.5" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                              {PHASES.map((ph, i) => {
                                const state = i < phaseIndex ? "done" : i === phaseIndex ? "active" : "todo";
                                return (
                                  <motion.li key={ph} className="flex items-center gap-3" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.06 }}>
                                    <span className={cn("relative grid h-6 w-6 place-items-center rounded-full border-2", state === "done" ? "border-transparent bg-success" : state === "active" ? "border-accent" : "border-line-strong")}>
                                      {state === "done" && (
                                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none">
                                          <motion.path d="M5 12.5 L10 17 L19 7.5" stroke="#06140d" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.3 }} />
                                        </svg>
                                      )}
                                      {state === "active" && <span className="h-2 w-2 animate-pulse rounded-full bg-accent shadow-[0_0_8px_var(--nv-accent)]" />}
                                    </span>
                                    <span className={cn("text-[14px] transition-colors", state === "todo" ? "text-faint" : "text-fg")}>{t(`install.phases.${ph}`)}</span>
                                    {state === "active" && <span className="ml-auto h-1 w-16 overflow-hidden rounded-full bg-surface-3"><motion.span className="block h-full w-1/2 rounded-full bg-gradient-accent" animate={{ x: ["-100%", "200%"] }} transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }} /></span>}
                                  </motion.li>
                                );
                              })}
                            </motion.ol>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                    <div className="flex items-center justify-end border-t border-line px-10 py-5">
                      {busy && !error && (
                        <Button variant="ghost" onClick={() => setConfirmClose(true)}>
                          {t("install.cancel")}
                        </Button>
                      )}
                    </div>
                  </Page>
                )}

                {step === "done" && (
                  <Page k="done" dir={dir}>
                    <div className="flex flex-1 flex-col items-center justify-center px-10 text-center">
                      <AnimatedCheck size={110} />
                      <motion.h1 className="mt-7 font-display text-4xl font-bold text-fg" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.8 }}>
                        {t("done.title")}
                      </motion.h1>
                      <motion.p className="mt-3 text-[15px] text-fg-soft" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1 }}>
                        {info?.mode === "update" ? t("done.updated") : t("done.text")}
                      </motion.p>
                      {done && !done.verified && <p className="mt-2 text-[12px] text-warning">{t("done.unverified")}</p>}
                      {info?.mode !== "update" && (
                        <motion.div className="mt-10 flex gap-3" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.2 }}>
                          <Button variant="primary" size="lg" icon={<Sparkles className="h-5 w-5" />} silent onClick={() => void finish(true)} autoFocus>
                            {t("done.launch")}
                          </Button>
                          <Button variant="secondary" size="lg" onClick={() => void finish(false)}>
                            {t("done.close")}
                          </Button>
                        </motion.div>
                      )}
                    </div>
                  </Page>
                )}

                {step === "un-confirm" && (
                  <Page k="un-confirm" dir={dir}>
                    <div className="flex flex-1 flex-col px-10 pt-14">
                      <h1 className="font-display text-3xl font-bold text-fg">{t("uninstall.title")}</h1>
                      <p className="mt-3 max-w-[520px] text-[14px] leading-relaxed text-fg-soft">{t("uninstall.text")}</p>
                      <div className="mt-8 rounded-xl border border-line bg-surface p-5">
                        <Checkbox checked={keepData} onChange={setKeepData} label={t("uninstall.keepData")} description={t("uninstall.keepDataDesc")} />
                      </div>
                    </div>
                    <div className="flex items-center justify-between border-t border-line px-10 py-5">
                      <Button variant="ghost" onClick={() => void api.quit()}>
                        {t("uninstall.cancel")}
                      </Button>
                      <Button
                        variant="danger"
                        size="lg"
                        icon={<Trash2 className="h-4 w-4" />}
                        className="bg-danger text-white hover:bg-danger/90"
                        onClick={() => {
                          go("un-run");
                          void api.startUninstall(keepData);
                        }}
                      >
                        {t("uninstall.confirm")}
                      </Button>
                    </div>
                  </Page>
                )}

                {step === "un-run" && (
                  <Page k="un-run" dir={dir}>
                    <div className="flex flex-1 items-center gap-12 px-12">
                      <motion.div className="relative grid h-48 w-48 place-items-center" animate={{ scale: 1 - (unProgress?.percent ?? 0) / 160, opacity: 1 - (unProgress?.percent ?? 0) / 130, rotate: (unProgress?.percent ?? 0) * 1.8 }} transition={{ type: "spring", stiffness: 60, damping: 16 }}>
                        <NovaLogo size={170} glow mode="static" />
                        <motion.div className="absolute inset-0 rounded-full border border-dashed border-accent/40" animate={{ rotate: -360 }} transition={{ duration: 6, repeat: Infinity, ease: "linear" }} />
                      </motion.div>
                      <div className="flex-1">
                        <h1 className="font-display text-2xl font-bold text-fg">{t("uninstall.running")}</h1>
                        <ol className="mt-6 flex flex-col gap-2.5">
                          {(["stop", "shortcuts", "registry", "files", "data"] as const).map((s, i) => {
                            const order = ["stop", "shortcuts", "registry", "files", "data", "done"];
                            const cur = unProgress ? order.indexOf(unProgress.step) : -1;
                            const state = i < cur || cur === 5 ? "done" : i === cur ? "active" : "todo";
                            return (
                              <li key={s} className="flex items-center gap-3">
                                <span className={cn("grid h-6 w-6 place-items-center rounded-full border-2", state === "done" ? "border-transparent bg-success" : state === "active" ? "border-accent" : "border-line-strong")}>
                                  {state === "done" && (
                                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none">
                                      <motion.path d="M5 12.5 L10 17 L19 7.5" stroke="#06140d" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} />
                                    </svg>
                                  )}
                                  {state === "active" && <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />}
                                </span>
                                <span className={cn("text-[14px]", state === "todo" ? "text-faint" : "text-fg", s === "data" && keepData && "line-through opacity-50")}>{t(`uninstall.steps.${s}`)}</span>
                              </li>
                            );
                          })}
                        </ol>
                        {error && <p className="mt-4 text-[13px] text-danger">{error.message}</p>}
                      </div>
                    </div>
                  </Page>
                )}

                {step === "un-done" && (
                  <Page k="un-done" dir={dir}>
                    <div className="flex flex-1 flex-col items-center justify-center px-10 text-center">
                      <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring.gravity}>
                        <Gamepad2 className="h-14 w-14 text-accent" strokeWidth={1.5} />
                      </motion.div>
                      <h1 className="mt-6 font-display text-4xl font-bold text-fg">{t("uninstall.doneTitle")}</h1>
                      <p className="mt-3 text-[15px] text-fg-soft">{t("uninstall.doneText")}</p>
                      <div className="mt-10">
                        <Button variant="secondary" size="lg" onClick={() => void api.quit()}>
                          {t("common.close")}
                        </Button>
                      </div>
                    </div>
                  </Page>
                )}
              </AnimatePresence>
            </main>
          </div>
        )}

        {/* Abbrechen bestätigen */}
        <AnimatePresence>
          {confirmClose && (
            <motion.div className="absolute inset-0 z-40 grid place-items-center bg-[var(--nv-overlay)] backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <motion.div className="glass-strong w-[420px] rounded-2xl p-6" initial={{ scale: 0.92, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96 }} transition={spring.snappy}>
                <div className="font-display text-lg font-bold text-fg">{t("install.cancel")}</div>
                <p className="mt-2 text-[13px] leading-relaxed text-fg-soft">{t("install.cancelConfirm")}</p>
                <div className="mt-6 flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setConfirmClose(false)}>
                    {t("common.back")}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={async () => {
                      setConfirmClose(false);
                      await api.cancelInstall().catch(() => undefined);
                    }}
                  >
                    {t("install.cancel")}
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  );
}

function defaultOpts(si: SetupInfo): InstallOptions {
  return { dir: si.installed?.dir ?? si.defaultDir, desktopShortcut: true, startMenu: true, autostart: false, launchAfter: true };
}
