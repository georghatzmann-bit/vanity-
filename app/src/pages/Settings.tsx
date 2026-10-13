import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Activity, Check, Download, ExternalLink, FolderOpen, HardDrive, Info, Keyboard, Languages, Library, MonitorSmartphone, Palette,
  PictureInPicture2, RefreshCw, Save, Sparkles, Trash2, Volume2, Zap,
} from "lucide-react";
import { api, errorText } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { useLanguage, useT } from "@/lib/i18n";
import { THEME_PREVIEW, THEMES, transitionTheme } from "@/lib/theme";
import type { Corner, LibraryBackup, MotionLevel, OverlayItem, ThemeId } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { useNet } from "@/store/net";
import { useSettings } from "@/store/settings";
import { confirmDialog, toast } from "@/store/ui";
import { useUpdate } from "@/store/update";
import { Chip, Field, Section } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Button } from "@shared/ui/Button";
import { Kbd } from "@shared/ui/Kbd";
import { PulsarLogo } from "@shared/ui/PulsarLogo";
import { Toggle } from "@shared/ui/Toggle";
import { cn } from "@shared/lib/cn";
import { sound, type SoundName } from "@shared/sound/engine";

const SECTIONS = [
  { id: "appearance", icon: Palette, key: "settings.appearance" },
  { id: "sound", icon: Volume2, key: "settings.sound" },
  { id: "monitor", icon: Activity, key: "settings.monitor" },
  { id: "boost", icon: Zap, key: "settings.boost" },
  { id: "overlay", icon: PictureInPicture2, key: "settings.overlay" },
  { id: "behavior", icon: MonitorSmartphone, key: "settings.behavior" },
  { id: "library", icon: Library, key: "settings.library" },
  { id: "data", icon: HardDrive, key: "settings.data" },
  { id: "about", icon: Info, key: "settings.about" },
];

const ACCENTS = ["", "#22d3ee", "#60a5fa", "#a78bfa", "#f472b6", "#fb7185", "#fbbf24", "#34d399"];
const OVERLAY_ITEMS: OverlayItem[] = ["ping", "jitter", "loss", "cpu", "gpu", "ram", "clock"];
const TEST_SOUNDS: SoundName[] = ["click", "hover", "switch", "success", "error", "launch", "achievement", "startup"];

function ThemeCard({ id, active, onPick }: { id: ThemeId; active: boolean; onPick: (e: React.MouseEvent) => void }) {
  const t = useT();
  const p = THEME_PREVIEW[id];
  return (
    <motion.button type="button" whileHover={{ y: -4 }} whileTap={{ scale: 0.97 }} onMouseEnter={() => sound.play("hover")} onClick={onPick} className={cn("relative overflow-hidden rounded-xl border-2 text-left transition-colors", active ? "border-accent" : "border-line hover:border-line-strong")}>
      <div className="relative h-24 overflow-hidden" style={{ background: p.bg }}>
        <div className="absolute -top-6 -left-4 h-20 w-24 rounded-full blur-xl" style={{ background: p.b, opacity: 0.45 }} />
        <div className="absolute -right-4 -bottom-8 h-20 w-24 rounded-full blur-xl" style={{ background: p.c, opacity: 0.4 }} />
        {/* Mini-Cockpit: Notenring + Ping-Linie */}
        <div className="absolute top-3 left-3 grid h-12 w-12 place-items-center rounded-full font-display text-sm font-bold" style={{ color: p.a, boxShadow: `inset 0 0 0 3px ${p.a}` }}>
          A
        </div>
        <svg className="absolute right-3 bottom-3 h-8 w-24" viewBox="0 0 96 32" fill="none">
          <path d="M0 22 L12 18 L24 20 L36 10 L48 14 L60 8 L72 12 L84 6 L96 10" stroke={`url(#tg-${id})`} strokeWidth="2" strokeLinecap="round" />
          <defs>
            <linearGradient id={`tg-${id}`} x1="0" x2="1">
              <stop offset="0" stopColor={p.a} />
              <stop offset="0.5" stopColor={p.b} />
              <stop offset="1" stopColor={p.c} />
            </linearGradient>
          </defs>
        </svg>
      </div>
      <div className="flex items-center justify-between bg-surface px-3 py-2.5">
        <div>
          <div className="text-[13px] font-semibold text-fg">{t(`settings.themes.${id}`)}</div>
          <div className="text-[11px] text-muted">{t(`settings.themeDesc.${id}`)}</div>
        </div>
        {active && (
          <span className="grid h-6 w-6 place-items-center rounded-full bg-accent text-accent-fg">
            <Check className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
    </motion.button>
  );
}

function ShortcutRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  const [rec, setRec] = useState(false);
  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRec(false);
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean) as string[];
      if (!mods.length) return;
      const key = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.code;
      onChange([...mods, key].join("+"));
      sound.play("success");
      setRec(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rec, onChange]);
  return (
    <button type="button" onClick={() => (sound.play("click"), setRec(true))} className={cn("flex h-10 min-w-44 items-center justify-center gap-1 rounded-md border px-3 transition", rec ? "border-accent bg-accent/10 text-fg" : "border-line bg-surface-2 hover:border-line-strong")}>
      {rec ? <span className="animate-pulse text-[13px] text-fg">{t("settings.recordShortcut")}</span> : value.split("+").map((k) => <Kbd key={k}>{k}</Kbd>)}
    </button>
  );
}

function RangeRow({ value, min, max, step, onChange, format }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string }) {
  return (
    <div className="flex w-56 items-center gap-3">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="accent-[var(--nv-accent)] flex-1" />
      <span className="w-14 text-right text-[13px] text-fg-soft tabular">{format(value)}</span>
    </div>
  );
}

function DataSection() {
  const t = useT();
  const [backups, setBackups] = useState<LibraryBackup[]>([]);
  const [cache, setCache] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => {
    void api.backupsList().then(setBackups).catch(() => setBackups([]));
    void api.cacheSize().then(setCache).catch(() => setCache(null));
  };
  useEffect(load, []);
  return (
    <>
      <Field label={t("settings.backups")} description={t("settings.backupsDesc")} stacked>
        <div className="flex flex-col gap-1">
          {backups.slice(0, 5).map((b) => (
            <div key={b.file} className="group flex items-center gap-3 rounded-lg px-2 py-1.5 text-[13px] hover:bg-surface-2">
              <Save className="h-4 w-4 text-muted" />
              <span className="flex-1 text-fg-soft">{formatDateTime(b.createdAt)}</span>
              <span className="text-faint">{formatBytes(b.size)}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (!(await confirmDialog({ title: t("settings.restore"), text: t("settings.restoreConfirm", { date: formatDateTime(b.createdAt) }), danger: true, confirmLabel: t("settings.restore") }))) return;
                  try {
                    await api.backupRestore(b.file);
                    toast({ kind: "success", title: t("settings.restored") });
                    window.setTimeout(() => window.location.reload(), 800);
                  } catch (e) {
                    toast({ kind: "error", title: errorText(e) });
                  }
                }}
              >
                {t("settings.restore")}
              </Button>
            </div>
          ))}
          {!backups.length && <div className="px-2 py-1.5 text-[13px] text-faint">{t("common.never")}</div>}
          <div className="pt-2">
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              icon={<Save className="h-3.5 w-3.5" />}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.backupNow();
                  load();
                  toast({ kind: "success", title: t("common.done") });
                } catch (e) {
                  toast({ kind: "error", title: errorText(e) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("settings.backupNow")}
            </Button>
          </div>
        </div>
      </Field>
      <Field label={t("settings.cache")} description={`${t("settings.cacheDesc")}${cache !== null ? ` · ${formatBytes(cache)}` : ""}`}>
        <Button
          variant="secondary"
          icon={<Trash2 className="h-4 w-4" />}
          onClick={async () => {
            try {
              const freed = await api.cacheClear();
              toast({ kind: "success", title: t("settings.cacheCleared", { size: formatBytes(freed) }) });
              load();
              const lib = useLibrary.getState();
              await lib.reload();
              void lib.fetchImages(lib.games, { force: true, quiet: true });
            } catch (e) {
              toast({ kind: "error", title: errorText(e) });
            }
          }}
        >
          {t("settings.clearCache")}
        </Button>
      </Field>
    </>
  );
}

function About() {
  const t = useT();
  const lang = useLanguage();
  const { info, checking, error, check } = useUpdate();
  const s = useSettings((x) => x.settings);
  const [version, setVersion] = useState("1.0.0");
  const [dataDir, setDataDir] = useState("");
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    void api
      .appInfo()
      .then((i) => (setVersion(i.version), setDataDir(i.dataDir)))
      .catch(() => undefined);
  }, []);
  const shortcuts: [string, string][] = [
    ["Ctrl+K", t("shortcuts.palette")],
    ["Ctrl+B", t("shortcuts.boost")],
    ["Ctrl+F", t("shortcuts.search")],
    ["Ctrl+,", t("shortcuts.settings")],
    ["Ctrl+1…6", t("shortcuts.pages")],
    ["Alt+←", t("shortcuts.back")],
    [s.overlayShortcut, t("shortcuts.overlay")],
  ];
  return (
    <>
      <div className="flex items-center gap-5 py-5">
        <PulsarLogo size={64} mode="idle" />
        <div>
          <div className="font-display text-2xl font-bold tracking-[0.2em] text-fg">PULSAR</div>
          <div className="text-sm text-muted">{t("settings.version", { v: version })}</div>
          <div className="mt-1 text-[12px] text-faint">{t("settings.madeWith")}</div>
        </div>
      </div>
      <Field label={t("settings.checkUpdates")} description={info ? (info.available ? t("settings.updateAvailable", { v: info.latest ?? "" }) : t("settings.upToDate")) : error ? error : undefined}>
        {info?.available && info.setupUrl ? (
          <Button
            variant="primary"
            loading={installing}
            icon={<Download className="h-4 w-4" />}
            onClick={async () => {
              setInstalling(true);
              toast({ kind: "info", title: t("settings.updateInstalling") });
              try {
                await api.updateInstall(info.setupUrl!, info.setupSha256);
              } catch (e) {
                toast({ kind: "error", title: errorText(e) });
                setInstalling(false);
              }
            }}
          >
            {t("settings.updateInstall")}
          </Button>
        ) : (
          <Button variant="secondary" loading={checking} icon={<RefreshCw className="h-4 w-4" />} onClick={() => void check().then((i) => i && !i.available && toast({ kind: "success", title: t("settings.upToDate") }))}>
            {t("settings.checkNow")}
          </Button>
        )}
      </Field>
      {info?.notes && <div className="my-3 rounded-lg bg-surface-2 p-3 text-[13px] whitespace-pre-wrap text-fg-soft">{info.notes}</div>}
      <Field label={t("settings.openDataDir")} description={dataDir}>
        <Button variant="secondary" icon={<FolderOpen className="h-4 w-4" />} onClick={() => dataDir && void api.openPath(dataDir)}>
          {t("common.open")}
        </Button>
      </Field>
      <Field label={t("settings.keyboard")} stacked>
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-[13px]">
          {shortcuts.map(([k, label]) => (
            <div key={label} className="flex items-center justify-between gap-3">
              <span className="text-fg-soft">{label}</span>
              <span className="flex gap-1">
                {k.split("+").map((x) => (
                  <Kbd key={x}>{x === "Ctrl" && lang === "de" ? "Strg" : x}</Kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </Field>
    </>
  );
}

/** Einstellungen: linke Sprungliste, rechts alle Bereiche untereinander */
export function SettingsPage({ section }: { section?: string }) {
  const t = useT();
  const s = useSettings((x) => x.settings);
  const update = useSettings((x) => x.update);
  const regions = useNet((x) => x.regions);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(section ?? "appearance");

  // Sprung zu einem Bereich (z. B. aus der Befehlspalette)
  useEffect(() => {
    if (!section) return;
    setActive(section);
    document.getElementById(`settings-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [section]);

  // Aktiven Bereich beim Scrollen mitführen
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.getBoundingClientRect().top + 80;
      let cur = SECTIONS[0].id;
      for (const sec of SECTIONS) {
        const node = document.getElementById(`settings-${sec.id}`);
        if (node && node.getBoundingClientRect().top <= top) cur = sec.id;
      }
      setActive(cur);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const regionOptions = regions.map((r) => ({ value: r.id, label: `${r.name} · ${r.provider}` }));
  if (!regionOptions.some((o) => o.value === s.monitorRegion)) regionOptions.unshift({ value: s.monitorRegion, label: s.monitorRegion });

  return (
    <div className="flex h-full min-h-0">
      <nav className="sticky top-0 hidden w-56 shrink-0 flex-col gap-1 self-start px-6 pt-3 lg:flex">
        <div className="mb-3 font-display text-2xl font-bold text-fg">{t("settings.title")}</div>
        {SECTIONS.map((sec) => {
          const Icon = sec.icon;
          const on = active === sec.id;
          return (
            <button
              key={sec.id}
              type="button"
              onMouseEnter={() => sound.play("hover")}
              onClick={() => {
                sound.play("click");
                setActive(sec.id);
                document.getElementById(`settings-${sec.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className={cn("relative flex h-9 items-center gap-2.5 rounded-md px-3 text-left text-[13px] font-medium transition", on ? "text-fg" : "text-muted hover:text-fg-soft")}
            >
              {on && <motion.span layoutId="settings-nav" className="absolute inset-0 rounded-md bg-surface-2" />}
              <Icon className="relative h-4 w-4" />
              <span className="relative">{t(sec.key)}</span>
            </button>
          );
        })}
      </nav>

      <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto px-8 pt-3 pb-24">
        <div className="mx-auto flex max-w-[860px] flex-col gap-6">
          <Section id="settings-appearance" title={t("settings.appearance")} icon={<Palette className="h-4 w-4" />}>
            <Field label={t("settings.theme")} stacked>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {THEMES.map((id) => (
                  <ThemeCard key={id} id={id} active={s.theme === id} onPick={(e) => s.theme !== id && (sound.play("switch"), transitionTheme(() => update({ theme: id }), { x: e.clientX, y: e.clientY }))} />
                ))}
              </div>
            </Field>
            <Field label={t("settings.accent")} description={t("settings.accentDesc")}>
              <div className="flex items-center gap-2">
                {ACCENTS.map((c) => (
                  <button
                    key={c || "theme"}
                    type="button"
                    title={c || t("settings.accentReset")}
                    onClick={() => (sound.play("click"), update({ accent: c }))}
                    className={cn("grid h-7 w-7 place-items-center rounded-full border-2 transition", s.accent === c ? "scale-110 border-fg" : "border-transparent hover:scale-105")}
                    style={{ background: c || `linear-gradient(135deg, ${THEME_PREVIEW[s.theme].a}, ${THEME_PREVIEW[s.theme].c})` }}
                  >
                    {s.accent === c && <Check className="h-3.5 w-3.5 text-white drop-shadow" />}
                  </button>
                ))}
                <input type="color" value={s.accent || THEME_PREVIEW[s.theme].a} onChange={(e) => update({ accent: e.target.value })} className="h-7 w-9 cursor-pointer rounded-md border border-line bg-surface-2" />
              </div>
            </Field>
            <Field label={t("settings.motion")} description={t("settings.motionDesc")}>
              <Segmented<MotionLevel> value={s.motion} onChange={(v) => update({ motion: v })} options={(["full", "reduced", "off"] as MotionLevel[]).map((v) => ({ value: v, label: t(`settings.motionLevels.${v}`) }))} />
            </Field>
            <Field label={t("settings.intro")} description={t("settings.introDesc")}>
              <Toggle checked={s.introAnimation} onChange={(v) => update({ introAnimation: v })} />
            </Field>
            <Field label={t("settings.language")}>
              <Segmented value={s.language} onChange={(v) => update({ language: v })} options={[{ value: "de", label: "Deutsch", icon: <Languages className="h-3.5 w-3.5" /> }, { value: "en", label: "English" }]} />
            </Field>
          </Section>

          <Section id="settings-sound" title={t("settings.sound")} icon={<Volume2 className="h-4 w-4" />}>
            <Field label={t("settings.soundOn")} description={t("settings.soundOnDesc")}>
              <Toggle checked={s.sound} onChange={(v) => update({ sound: v })} />
            </Field>
            <Field label={t("settings.volume")}>
              <RangeRow value={s.volume} min={0} max={1} step={0.05} onChange={(v) => update({ volume: v })} format={(v) => `${Math.round(v * 100)} %`} />
            </Field>
            <Field label={t("settings.hoverSounds")} description={t("settings.hoverSoundsDesc")}>
              <Toggle checked={s.hoverSounds} onChange={(v) => update({ hoverSounds: v })} />
            </Field>
            <Field label={t("settings.testSounds")} stacked>
              <div className="flex flex-wrap gap-2">
                {TEST_SOUNDS.map((n) => (
                  <Chip key={n} onClick={() => sound.play(n)}>
                    <Sparkles className="h-3 w-3" /> {t(`settings.soundNames.${n}`)}
                  </Chip>
                ))}
              </div>
            </Field>
          </Section>

          <Section id="settings-monitor" title={t("settings.monitor")} icon={<Activity className="h-4 w-4" />}>
            <Field label={t("settings.monitorRegion")} description={t("settings.monitorRegionDesc")}>
              <Select value={s.monitorRegion} onChange={(v) => (update({ monitorRegion: v }), void useNet.getState().useRegionTarget(v))} options={regionOptions} className="w-64" align="right" />
            </Field>
            <Field label={t("settings.interval")} description={t("settings.intervalDesc")}>
              <RangeRow value={s.pingIntervalMs} min={250} max={5000} step={250} onChange={(v) => update({ pingIntervalMs: v })} format={(v) => `${(v / 1000).toFixed(2).replace(/\.?0+$/, "")} s`} />
            </Field>
            <Field label={t("settings.alert")} description={t("settings.alertDesc")}>
              <RangeRow value={s.pingAlertMs} min={40} max={400} step={10} onChange={(v) => update({ pingAlertMs: v })} format={(v) => `${v} ms`} />
            </Field>
            <Field label={t("settings.notifications")} description={t("settings.notificationsDesc")}>
              <Toggle checked={s.notifications} onChange={(v) => update({ notifications: v })} />
            </Field>
          </Section>

          <Section id="settings-boost" title={t("settings.boost")} icon={<Zap className="h-4 w-4" />}>
            <Field label={t("settings.autoBoost")} description={t("settings.autoBoostDesc")}>
              <Toggle checked={s.autoBoost} onChange={(v) => update({ autoBoost: v })} />
            </Field>
            <Field label={t("optimize.boostProfile")} description={t("optimize.boostProfileDesc")}>
              <Button variant="secondary" icon={<ExternalLink className="h-4 w-4" />} onClick={() => import("@/store/ui").then((m) => m.useUI.getState().navigate({ page: "optimize" }))}>
                {t("nav.optimize")}
              </Button>
            </Field>
          </Section>

          <Section id="settings-overlay" title={t("settings.overlay")} icon={<PictureInPicture2 className="h-4 w-4" />}>
            <Field label={t("settings.overlayEnabled")} description={t("settings.overlayEnabledDesc")}>
              <div className="flex items-center gap-3">
                <Button size="sm" variant="secondary" onClick={() => void api.overlayToggle().catch((e) => toast({ kind: "error", title: errorText(e) }))}>
                  {t("settings.showOverlay")}
                </Button>
                <Toggle checked={s.overlayEnabled} onChange={(v) => update({ overlayEnabled: v })} />
              </div>
            </Field>
            <Field label={t("settings.overlayShortcut")} description={t("settings.overlayShortcutDesc")}>
              <ShortcutRecorder value={s.overlayShortcut} onChange={(v) => update({ overlayShortcut: v })} />
            </Field>
            <Field label={t("settings.overlayCorner")}>
              <Segmented<Corner> size="sm" value={s.overlayCorner} onChange={(v) => update({ overlayCorner: v })} options={(["tl", "tr", "bl", "br"] as Corner[]).map((c) => ({ value: c, label: t(`settings.corners.${c}`) }))} />
            </Field>
            <Field label={t("settings.overlayOpacity")}>
              <RangeRow value={s.overlayOpacity} min={0.3} max={1} step={0.05} onChange={(v) => update({ overlayOpacity: v })} format={(v) => `${Math.round(v * 100)} %`} />
            </Field>
            <Field label={t("settings.overlayItems")} stacked>
              <div className="flex flex-wrap gap-2">
                {OVERLAY_ITEMS.map((item) => {
                  const on = s.overlayItems.includes(item);
                  return (
                    <Chip key={item} active={on} onClick={() => (sound.play(on ? "toggleOff" : "toggleOn"), update({ overlayItems: on ? s.overlayItems.filter((x) => x !== item) : [...s.overlayItems, item] }))}>
                      {t(`settings.overlayItemNames.${item}`)}
                    </Chip>
                  );
                })}
              </div>
            </Field>
          </Section>

          <Section id="settings-behavior" title={t("settings.behavior")} icon={<MonitorSmartphone className="h-4 w-4" />}>
            <Field label={t("settings.closeToTray")} description={t("settings.closeToTrayDesc")}>
              <Toggle checked={s.closeToTray} onChange={(v) => update({ closeToTray: v })} />
            </Field>
            <Field label={t("settings.autostart")} description={t("settings.autostartDesc")}>
              <Toggle checked={s.autostart} onChange={(v) => update({ autostart: v })} />
            </Field>
          </Section>

          <Section id="settings-library" title={t("settings.library")} icon={<Library className="h-4 w-4" />}>
            <Field label={t("settings.scanOnStartup")} description={t("settings.scanOnStartupDesc")}>
              <Toggle checked={s.scanOnStartup} onChange={(v) => update({ scanOnStartup: v })} />
            </Field>
            <Field label={t("settings.sgdbKey")} description={t("settings.sgdbKeyDesc")} stacked>
              <div className="flex gap-2">
                <input value={s.steamGridDbKey} onChange={(e) => update({ steamGridDbKey: e.target.value.trim() })} placeholder="…" spellCheck={false} className="h-10 flex-1 rounded-md border border-line bg-surface-2 px-3 font-mono text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent" />
                <Button variant="secondary" icon={<ExternalLink className="h-4 w-4" />} onClick={() => void api.openUrl("https://www.steamgriddb.com/profile/preferences/api")}>
                  {t("settings.getKey")}
                </Button>
              </div>
            </Field>
          </Section>

          <Section id="settings-data" title={t("settings.data")} icon={<HardDrive className="h-4 w-4" />}>
            <DataSection />
          </Section>

          <Section id="settings-about" title={t("settings.about")} icon={<Info className="h-4 w-4" />}>
            <About />
          </Section>

          <div className="flex items-center gap-2 px-2 text-[12px] text-faint">
            <Keyboard className="h-3.5 w-3.5" /> {t("shortcuts.settings")}: <Kbd>Ctrl</Kbd>
            <Kbd>,</Kbd>
          </div>
        </div>
      </div>
    </div>
  );
}
