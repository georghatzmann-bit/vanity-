import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Check, Download, ExternalLink, FolderOpen, FolderPlus, HardDrive, HeartPulse, Info, Keyboard, Languages, Library, LayoutDashboard, Loader2, MapPin,
  Palette, RefreshCw, Save, Search, Sparkles, Trash2, Upload, UserPlus, Users, Volume2, Wand2, X, MonitorSmartphone,
} from "lucide-react";
import { api, errorText } from "@/lib/api";
import { pickFile, pickFolder, saveFile } from "@/lib/dialog";
import { formatBytes, formatDateTime } from "@/lib/format";
import { useLanguage, useT } from "@/lib/i18n";
import { THEME_PREVIEW, THEMES, transitionTheme } from "@/lib/theme";
import type { GeoPlace, LibraryBackup, MotionLevel, ProfilesState, ThemeId } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { useSettings } from "@/store/settings";
import { confirmDialog, toast } from "@/store/ui";
import { useUpdate } from "@/store/update";
import { Field, Section } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { Button } from "@shared/ui/Button";
import { Kbd } from "@shared/ui/Kbd";
import { NovaLogo } from "@shared/ui/NovaLogo";
import { Toggle } from "@shared/ui/Toggle";
import { cn } from "@shared/lib/cn";
import { sound, type SoundName } from "@shared/sound/engine";

const SECTIONS = [
  { id: "appearance", icon: Palette, key: "settings.appearance" },
  { id: "sound", icon: Volume2, key: "settings.sound" },
  { id: "library", icon: Library, key: "settings.library" },
  { id: "behavior", icon: MonitorSmartphone, key: "settings.behavior" },
  { id: "wellbeing", icon: HeartPulse, key: "settings.wellbeing" },
  { id: "widgets", icon: LayoutDashboard, key: "settings.widgets" },
  { id: "profiles", icon: Users, key: "settings.profiles" },
  { id: "data", icon: HardDrive, key: "settings.data" },
  { id: "about", icon: Info, key: "settings.about" },
];

const PROFILE_COLORS = ["#ff4f8b", "#ff8a4c", "#fbbf24", "#34d399", "#22d3ee", "#60a5fa", "#8b5cf6", "#f472b6"];

function ThemeCard({ id, active, onPick }: { id: ThemeId; active: boolean; onPick: (e: React.MouseEvent) => void }) {
  const t = useT();
  const p = THEME_PREVIEW[id];
  return (
    <motion.button type="button" whileHover={{ y: -4 }} whileTap={{ scale: 0.97 }} onMouseEnter={() => sound.play("hover")} onClick={onPick} className={cn("relative overflow-hidden rounded-xl border-2 text-left transition-colors", active ? "border-accent" : "border-line hover:border-line-strong")}>
      <div className="relative h-24 overflow-hidden" style={{ background: p.bg }}>
        <div className="absolute -top-6 -left-4 h-20 w-24 rounded-full blur-xl" style={{ background: p.b, opacity: 0.45 }} />
        <div className="absolute -right-4 -bottom-8 h-20 w-24 rounded-full blur-xl" style={{ background: p.c, opacity: 0.4 }} />
        <div className="absolute top-3 left-3 flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-10 w-7 rounded-md" style={{ background: i === 1 ? `linear-gradient(135deg, ${p.a}, ${p.b}, ${p.c})` : p.fg, opacity: i === 1 ? 1 : 0.12 }} />
          ))}
        </div>
        <div className="absolute right-3 bottom-3 h-2 w-16 rounded-full" style={{ background: `linear-gradient(90deg, ${p.a}, ${p.b}, ${p.c})` }} />
      </div>
      <div className="flex items-center justify-between bg-surface px-3 py-2.5">
        <div>
          <div className="text-[13px] font-semibold text-fg">{t(`settings.themes.${id}`)}</div>
          <div className="text-[11px] text-muted">{t(`settings.themeDesc.${id}`)}</div>
        </div>
        {active && (
          <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="grid h-6 w-6 place-items-center rounded-full bg-gradient-accent text-white">
            <Check className="h-3.5 w-3.5" strokeWidth={3} />
          </motion.span>
        )}
      </div>
    </motion.button>
  );
}

function WeatherPicker() {
  const t = useT();
  const lang = useLanguage();
  const place = useSettings((s) => s.settings.weatherPlace);
  const update = useSettings((s) => s.update);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GeoPlace[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const id = window.setTimeout(async () => {
      setBusy(true);
      try {
        setResults(await api.geocode(q.trim(), lang));
      } catch {
        setResults([]);
      } finally {
        setBusy(false);
      }
    }, 350);
    return () => window.clearTimeout(id);
  }, [q, lang]);
  return (
    <div className="w-full">
      {place && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm text-fg">
          <MapPin className="h-4 w-4 text-accent" /> {place.name}
          {place.country ? `, ${place.country}` : ""}
          <button type="button" onClick={() => update({ weatherPlace: null })} className="ml-auto text-faint hover:text-fg" aria-label={t("common.remove")}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("settings.weatherSearch")} className="input pl-9" />
        {busy && <Loader2 className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin text-muted" />}
      </div>
      {results.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {results.map((r) => (
            <button
              key={`${r.lat},${r.lon}`}
              type="button"
              onClick={() => {
                sound.play("success");
                update({ weatherPlace: r });
                setQ("");
                setResults([]);
              }}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-fg-soft transition hover:bg-surface-2 hover:text-fg"
            >
              <MapPin className="h-3.5 w-3.5 text-muted" />
              {r.name}
              <span className="text-muted">{[r.admin, r.country].filter(Boolean).join(", ")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
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
      {rec ? (
        <span className="animate-pulse text-[13px] text-fg">{t("settings.overlayRecord")}</span>
      ) : (
        value.split("+").map((k) => <Kbd key={k}>{k}</Kbd>)
      )}
    </button>
  );
}

function Profiles() {
  const t = useT();
  const [state, setState] = useState<ProfilesState | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState(PROFILE_COLORS[1]);
  const load = () => void api.profilesList().then(setState).catch(() => undefined);
  useEffect(load, []);
  const create = async () => {
    if (!name.trim()) return;
    try {
      await api.profileCreate(name.trim(), color, name.trim()[0]?.toUpperCase());
      setName("");
      sound.play("success");
      load();
    } catch (e) {
      toast({ kind: "error", title: errorText(e) });
    }
  };
  const switchTo = async (id: string) => {
    try {
      await api.profileSwitch(id);
      await useSettings.getState().load();
      await useLibrary.getState().reload();
      sound.play("success");
      load();
    } catch (e) {
      toast({ kind: "error", title: errorText(e) });
    }
  };
  return (
    <div className="w-full py-2">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {state?.profiles.map((p) => (
          <div key={p.id} className={cn("flex items-center gap-3 rounded-xl border p-3", p.id === state.activeId ? "border-accent/50 bg-accent/8" : "border-line bg-surface")}>
            <span className="grid h-10 w-10 place-items-center rounded-full text-sm font-bold text-white" style={{ background: p.color }}>
              {p.avatar || p.name[0]?.toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-fg">{p.name}</div>
              <div className="text-[11px] text-muted">{p.id === state.activeId ? t("settings.active") : formatDateTime(p.createdAt)}</div>
            </div>
            {p.id !== state.activeId && (
              <>
                <Button size="sm" variant="secondary" onClick={() => void switchTo(p.id)}>
                  {t("settings.switchProfile")}
                </Button>
                <button
                  type="button"
                  className="text-faint hover:text-danger"
                  aria-label={t("common.delete")}
                  onClick={async () => {
                    if (await confirmDialog({ title: t("common.delete"), text: t("settings.deleteProfileConfirm", { name: p.name }), danger: true, confirmLabel: t("common.delete") })) {
                      await api.profileDelete(p.id).catch((e) => toast({ kind: "error", title: errorText(e) }));
                      load();
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} placeholder={t("settings.profileName")} className="input h-10 max-w-60" />
        <div className="flex gap-1.5">
          {PROFILE_COLORS.map((c) => (
            <button key={c} type="button" onClick={() => setColor(c)} className={cn("h-7 w-7 rounded-full transition", color === c ? "scale-110 ring-2 ring-white/80" : "hover:scale-110")} style={{ background: c }} aria-label={c} />
          ))}
        </div>
        <Button variant="primary" icon={<UserPlus className="h-4 w-4" />} disabled={!name.trim()} onClick={() => void create()}>
          {t("settings.newProfile")}
        </Button>
      </div>
    </div>
  );
}

function DataSection() {
  const t = useT();
  const [backups, setBackups] = useState<LibraryBackup[]>([]);
  const [cache, setCache] = useState<number | null>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const load = () => {
    void api.backupsList().then(setBackups).catch(() => setBackups([]));
    void api.cacheSize().then(setCache).catch(() => setCache(null));
  };
  useEffect(load, []);
  return (
    <>
      <Field label={t("settings.export")} description={t("settings.exportDesc")}>
        <Button
          icon={<Download className="h-4 w-4" />}
          onClick={async () => {
            const p = await saveFile(`nova-bibliothek-${new Date().toISOString().slice(0, 10)}.json`, [{ name: "NOVA Bibliothek", extensions: ["json"] }]);
            if (!p) return;
            try {
              await api.libraryExport(p);
              toast({ kind: "success", title: t("settings.exported") });
            } catch (e) {
              toast({ kind: "error", title: errorText(e) });
            }
          }}
        >
          {t("settings.export")}
        </Button>
      </Field>
      <Field label={t("settings.import")} description={t("settings.importDesc")}>
        <div className="flex items-center gap-2">
          <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: "merge", label: t("settings.importMerge") }, { value: "replace", label: t("settings.importReplace") }]} />
          <Button
            icon={<Upload className="h-4 w-4" />}
            onClick={async () => {
              const p = await pickFile({ filters: [{ name: "NOVA Bibliothek", extensions: ["json"] }] });
              if (!p) return;
              try {
                const r = await api.libraryImport(p, mode);
                await useLibrary.getState().reload();
                toast({ kind: "success", title: t("settings.imported", { games: r.games, sessions: r.sessions }) });
              } catch (e) {
                toast({ kind: "error", title: errorText(e) });
              }
            }}
          >
            {t("settings.import")}
          </Button>
        </div>
      </Field>
      <Field label={t("settings.autoBackups")} description={t("settings.autoBackupsDesc")} stacked>
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
                  if (!(await confirmDialog({ title: t("game.restore"), text: t("settings.backupRestoreConfirm", { date: formatDateTime(b.createdAt) }), danger: true, confirmLabel: t("game.restore") }))) return;
                  try {
                    await api.backupRestore(b.file);
                    await useSettings.getState().load();
                    await useLibrary.getState().reload();
                    toast({ kind: "success", title: t("game.restored") });
                  } catch (e) {
                    toast({ kind: "error", title: errorText(e) });
                  }
                }}
              >
                {t("game.restore")}
              </Button>
            </div>
          ))}
          <div>
            <Button
              size="sm"
              variant="secondary"
              icon={<Save className="h-4 w-4" />}
              onClick={async () => {
                try {
                  await api.backupNow();
                  toast({ kind: "success", title: t("toast.saved") });
                  load();
                } catch (e) {
                  toast({ kind: "error", title: errorText(e) });
                }
              }}
            >
              {t("settings.backupNow")}
            </Button>
          </div>
        </div>
      </Field>
      <Field label={t("settings.cache")} description={`${t("settings.cacheDesc")} ${cache !== null ? `(${formatBytes(cache)})` : ""}`}>
        <Button
          variant="secondary"
          icon={<Trash2 className="h-4 w-4" />}
          onClick={async () => {
            try {
              if (!(await confirmDialog({ title: t("settings.clearCache"), text: t("settings.clearCacheConfirm"), confirmLabel: t("settings.clearCache") }))) return;
              const freed = await api.cacheClear();
              toast({ kind: "success", title: t("settings.cacheCleared", { size: formatBytes(freed) }), text: t("settings.cacheReloading") });
              load();
              // Bilder neu laden – die Dateien sind ja weg
              const lib = useLibrary.getState();
              for (const g of lib.games) lib.updateGame(g.id, { images: {}, palette: undefined, imagesCheckedAt: undefined });
              void lib.fetchImages(useLibrary.getState().games.filter((g) => !g.hidden), { quiet: true });
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
  const update = useSettings((x) => x.update);
  const [version, setVersion] = useState("1.0.0");
  const [dataDir, setDataDir] = useState("");
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    void api
      .appInfo()
      .then((i) => (setVersion(i.version), setDataDir(i.dataDir)))
      .catch(() => undefined);
  }, []);
  return (
    <>
      <div className="flex items-center gap-5 py-5">
        <NovaLogo size={64} mode="idle" />
        <div>
          <div className="font-display text-2xl font-bold tracking-[0.2em] text-fg">NOVA</div>
          <div className="text-sm text-muted">{t("settings.version", { v: version })}</div>
          <div className="mt-1 text-[12px] text-faint">{t("settings.madeWith")}</div>
        </div>
      </div>
      <Field label={t("settings.checkUpdates")} description={info ? (info.available ? t("settings.updateAvailable", { v: info.latest ?? "" }) : t("settings.upToDate")) : error ? `${t("settings.updateError")}: ${error}` : undefined}>
        <div className="flex items-center gap-3">
          <Toggle checked={s.checkUpdates} onChange={(v) => update({ checkUpdates: v })} />
          {info?.available && info.setupUrl ? (
            <Button
              variant="primary"
              loading={installing}
              icon={<Download className="h-4 w-4" />}
              onClick={async () => {
                setInstalling(true);
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
        </div>
      </Field>
      {info?.notes && <div className="rounded-lg bg-surface-2 p-3 text-[13px] whitespace-pre-wrap text-fg-soft">{info.notes}</div>}
      <Field label={t("settings.dataFolder")} description={dataDir}>
        <Button variant="secondary" icon={<FolderOpen className="h-4 w-4" />} onClick={() => dataDir && void api.openPath(dataDir)}>
          {t("common.open")}
        </Button>
      </Field>
      <Field label={t("settings.keyboard")} stacked>
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-[13px]">
          {[
            ["Ctrl+K", t("shortcuts.palette")],
            ["Ctrl+F", t("shortcuts.search")],
            ["Ctrl+D", t("shortcuts.dice")],
            ["Ctrl+B", t("shortcuts.bigPicture")],
            ["Ctrl+,", t("shortcuts.settings")],
            ["Ctrl+1…7", t("shortcuts.pages")],
            ["Alt+←", t("shortcuts.back")],
            ["/", t("shortcuts.quickPalette")],
            [s.overlayShortcut, t("settings.overlay")],
          ].map(([k, label]) => (
            <div key={label} className="flex items-center justify-between gap-3">
              <span className="text-fg-soft">{label}</span>
              <span className="flex gap-1">
                {(k === "/" ? ["/"] : k.split("+")).map((x) => (
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

export function SettingsPage({ section }: { section?: string }) {
  const t = useT();
  const s = useSettings((x) => x.settings);
  const update = useSettings((x) => x.update);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(section ?? "appearance");

  useEffect(() => {
    if (section) window.setTimeout(() => document.getElementById(`settings-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
  }, [section]);

  useEffect(() => {
    const root = scrollRef.current?.closest(".overflow-y-auto") as HTMLElement | null;
    if (!root) return;
    const onScroll = () => {
      let current = SECTIONS[0].id;
      for (const sec of SECTIONS) {
        const el = document.getElementById(`settings-${sec.id}`);
        if (el && el.getBoundingClientRect().top < 200) current = sec.id;
      }
      setActive(current);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, []);

  const pickTheme = (id: ThemeId, e: React.MouseEvent) => {
    sound.play("whoosh");
    transitionTheme(() => update({ theme: id }), { x: e.clientX, y: e.clientY });
  };

  const sounds: SoundName[] = ["click", "hover", "switch", "success", "error", "launch", "achievement", "startup"];

  return (
    <div ref={scrollRef} className="mx-auto flex max-w-[1300px] gap-8 px-8 pt-4 pb-28">
      <aside className="sticky top-4 hidden h-fit w-56 shrink-0 lg:block">
        <h1 className="mb-6 font-display text-3xl font-bold text-fg">{t("settings.title")}</h1>
        <nav className="flex flex-col gap-0.5">
          {SECTIONS.map((sec) => (
            <button
              key={sec.id}
              type="button"
              onMouseEnter={() => sound.play("hover")}
              onClick={() => {
                sound.play("click");
                document.getElementById(`settings-${sec.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className={cn("relative flex h-9 items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition", active === sec.id ? "text-fg" : "text-muted hover:text-fg")}
            >
              {active === sec.id && <motion.span layoutId="settings-nav" className="absolute inset-0 rounded-lg bg-surface-2" transition={{ type: "spring", stiffness: 500, damping: 36 }} />}
              <sec.icon className={cn("relative h-4 w-4", active === sec.id && "text-accent")} />
              <span className="relative">{t(sec.key)}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <div id="settings-appearance" className="scroll-mt-4">
          <Section title={t("settings.appearance")} icon={<Palette className="h-4 w-4" />}>
            <div className="py-4">
              <div className="mb-3 text-sm font-medium text-fg">{t("settings.theme")}</div>
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                {THEMES.map((id) => (
                  <ThemeCard key={id} id={id} active={s.theme === id} onPick={(e) => pickTheme(id, e)} />
                ))}
              </div>
            </div>
            <Field label={t("settings.accent")} description={t("settings.accentDesc")}>
              <div className="flex items-center gap-2">
                <label className="relative h-10 w-10 cursor-pointer overflow-hidden rounded-full ring-2 ring-line-strong" style={{ background: s.accent || "var(--nv-gradient)" }}>
                  <input type="color" value={s.accent || "#ff4f8b"} onChange={(e) => update({ accent: e.target.value })} className="absolute inset-0 cursor-pointer opacity-0" aria-label={t("settings.accent")} />
                </label>
                {s.accent && (
                  <Button size="sm" variant="ghost" onClick={() => update({ accent: "" })}>
                    {t("settings.accentReset")}
                  </Button>
                )}
              </div>
            </Field>
            <Field label={t("settings.dynamicBg")} description={t("settings.dynamicBgDesc")}>
              <Toggle checked={s.dynamicBackground} onChange={(v) => update({ dynamicBackground: v })} />
            </Field>
            <Field label={t("settings.motion")} description={t("settings.motionDesc")}>
              <Segmented<MotionLevel>
                value={s.motion}
                onChange={(v) => update({ motion: v })}
                options={[
                  { value: "full", label: t("settings.motionFull") },
                  { value: "reduced", label: t("settings.motionReduced") },
                  { value: "off", label: t("settings.motionOff") },
                ]}
              />
            </Field>
            <Field label={t("settings.parallax")} description={t("settings.parallaxDesc")}>
              <Toggle checked={s.parallax} onChange={(v) => update({ parallax: v })} disabled={s.motion !== "full"} />
            </Field>
            <Field label={t("settings.particles")} description={t("settings.particlesDesc")}>
              <Toggle checked={s.particles} onChange={(v) => update({ particles: v })} disabled={s.motion === "off"} />
            </Field>
            <Field label={t("settings.intro")} description={t("settings.introDesc")}>
              <Toggle checked={s.introAnimation} onChange={(v) => update({ introAnimation: v })} />
            </Field>
            <Field label={t("settings.ritual")} description={t("settings.ritualDesc")}>
              <Toggle checked={s.launchRitual} onChange={(v) => update({ launchRitual: v })} />
            </Field>
            <Field label={t("settings.language")} description={t("settings.languageDesc")}>
              <Segmented
                value={s.language}
                onChange={(v) => update({ language: v })}
                options={[
                  { value: "de", label: "Deutsch", icon: <Languages className="h-3.5 w-3.5" /> },
                  { value: "en", label: "English" },
                ]}
              />
            </Field>
          </Section>
        </div>

        <div id="settings-sound" className="scroll-mt-4">
          <Section title={t("settings.sound")} icon={<Volume2 className="h-4 w-4" />}>
            <Field label={t("settings.volume")} description={`${Math.round(s.soundVolume * 100)} %`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={s.soundVolume}
                onChange={(e) => update({ soundVolume: Number(e.target.value) })}
                onPointerUp={() => sound.play("success")}
                className="range w-56"
                style={{ ["--fill" as string]: `${s.soundVolume * 100}%` }}
                aria-label={t("settings.volume")}
              />
            </Field>
            <Field label={t("settings.mute")} description={t("settings.muteDesc")}>
              <Toggle checked={s.soundMuted} onChange={(v) => update({ soundMuted: v })} />
            </Field>
            <Field label={t("settings.hoverSounds")} description={t("settings.hoverSoundsDesc")}>
              <Toggle checked={s.hoverSounds} onChange={(v) => update({ hoverSounds: v })} />
            </Field>
            <Field label={t("settings.testSounds")} stacked>
              <div className="flex flex-wrap gap-2">
                {sounds.map((n) => (
                  <Button key={n} size="sm" variant="secondary" silent onClick={() => sound.play(n)} icon={<Sparkles className="h-3.5 w-3.5" />}>
                    {t(`soundNames.${n}`)}
                  </Button>
                ))}
              </div>
            </Field>
          </Section>
        </div>

        <div id="settings-library" className="scroll-mt-4">
          <Section title={t("settings.library")} icon={<Library className="h-4 w-4" />}>
            <Field label={t("settings.sgdbKey")} description={t("settings.sgdbKeyDesc")} stacked>
              <div className="flex gap-2">
                <input type="password" value={s.steamGridDbKey} onChange={(e) => update({ steamGridDbKey: e.target.value.trim() })} placeholder="z. B. 1a2b3c4d5e6f…" className="input font-mono text-[12px]" autoComplete="off" spellCheck={false} />
                <Button variant="secondary" icon={<ExternalLink className="h-4 w-4" />} onClick={() => void api.openUrl("https://www.steamgriddb.com/profile/preferences/api")}>
                  {t("settings.sgdbGet")}
                </Button>
              </div>
            </Field>
            <Field label={t("settings.scanOnStart")} description={t("settings.scanOnStartDesc")}>
              <Toggle checked={s.scanOnStart} onChange={(v) => update({ scanOnStart: v })} />
            </Field>
            <Field label={t("settings.scanSources")} stacked>
              <div className="flex flex-wrap gap-4">
                {(["steam", "epic", "gog", "startMenu"] as const).map((k) => (
                  <label key={k} className="flex items-center gap-2 text-sm text-fg-soft">
                    <Toggle size="sm" checked={s.scan[k]} onChange={(v) => update({ scan: { ...s.scan, [k]: v } })} />
                    {t(`scan.${k}`)}
                  </label>
                ))}
              </div>
              <div className="mt-4 flex flex-col gap-1">
                {s.scan.folders.map((f) => (
                  <div key={f} className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-fg">
                    <FolderOpen className="h-4 w-4 text-muted" />
                    <span className="flex-1 truncate font-mono text-[12px]">{f}</span>
                    <button type="button" onClick={() => update({ scan: { ...s.scan, folders: s.scan.folders.filter((x) => x !== f) } })} className="text-faint hover:text-danger" aria-label={t("common.remove")}>
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <div>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<FolderPlus className="h-4 w-4" />}
                    onClick={async () => {
                      const p = await pickFolder();
                      if (p && !s.scan.folders.includes(p)) update({ scan: { ...s.scan, folders: [...s.scan.folders, p] } });
                    }}
                  >
                    {t("scan.addFolder")}
                  </Button>
                </div>
              </div>
            </Field>
          </Section>
        </div>

        <div id="settings-behavior" className="scroll-mt-4">
          <Section title={t("settings.behavior")} icon={<MonitorSmartphone className="h-4 w-4" />}>
            <Field label={t("settings.minimizeOnLaunch")} description={t("settings.minimizeOnLaunchDesc")}>
              <Toggle checked={s.minimizeOnLaunch} onChange={(v) => update({ minimizeOnLaunch: v })} />
            </Field>
            <Field label={t("settings.closeToTray")} description={t("settings.closeToTrayDesc")}>
              <Toggle checked={s.closeToTray} onChange={(v) => update({ closeToTray: v })} />
            </Field>
            <Field label={t("settings.autostart")} description={t("settings.autostartDesc")}>
              <Toggle checked={s.autostart} onChange={(v) => update({ autostart: v })} />
            </Field>
            <Field label={t("settings.dock")} description={t("settings.dockDesc")}>
              <Toggle checked={s.showDock} onChange={(v) => update({ showDock: v })} />
            </Field>
            <Field label={t("settings.overlayShortcut")} description={t("settings.overlayShortcutDesc")}>
              <div className="flex items-center gap-2">
                <ShortcutRecorder value={s.overlayShortcut} onChange={(v) => update({ overlayShortcut: v })} />
                <Button size="sm" variant="ghost" icon={<Wand2 className="h-4 w-4" />} onClick={() => void api.overlayToggle()}>
                  {t("common.show")}
                </Button>
              </div>
            </Field>
          </Section>
        </div>

        <div id="settings-wellbeing" className="scroll-mt-4">
          <Section title={t("settings.wellbeing")} icon={<HeartPulse className="h-4 w-4" />}>
            <Field label={t("settings.breakReminder")} description={t("settings.breakReminderDesc")}>
              <div className="flex items-center gap-3">
                <select value={s.breakReminderMinutes} onChange={(e) => update({ breakReminderMinutes: Number(e.target.value) })} disabled={!s.breakReminder} className="input h-9 w-32" aria-label={t("settings.breakAfter")}>
                  {[30, 45, 60, 90, 120, 180, 240].map((m) => (
                    <option key={m} value={m}>
                      {m >= 60 ? `${m / 60} ${t("time.h")}` : `${m} ${t("time.m")}`}
                    </option>
                  ))}
                </select>
                <Toggle checked={s.breakReminder} onChange={(v) => update({ breakReminder: v })} />
              </div>
            </Field>
            <Field label={t("settings.dailyGoal")} description={t("settings.dailyGoalDesc")}>
              <div className="flex items-center gap-3">
                <Segmented size="sm" value={s.dailyGoalMode} onChange={(v) => update({ dailyGoalMode: v })} options={[{ value: "goal", label: t("settings.goalModeGoal") }, { value: "limit", label: t("settings.goalModeLimit") }]} />
                <select value={s.dailyGoalMinutes} onChange={(e) => update({ dailyGoalMinutes: Number(e.target.value) })} className="input h-9 w-28" aria-label={t("settings.dailyGoal")}>
                  {[30, 60, 90, 120, 180, 240, 300, 360].map((m) => (
                    <option key={m} value={m}>
                      {m >= 60 ? `${m / 60} ${t("time.h")}` : `${m} ${t("time.m")}`}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
            <Field label={t("settings.notifications")} description={t("settings.notificationsDesc")}>
              <Toggle checked={s.notifications} onChange={(v) => update({ notifications: v })} />
            </Field>
          </Section>
        </div>

        <div id="settings-widgets" className="scroll-mt-4">
          <Section title={t("settings.widgets")} icon={<LayoutDashboard className="h-4 w-4" />}>
            <Field label={t("settings.weatherPlace")} description={t("settings.weatherPlaceDesc")} stacked>
              <WeatherPicker />
            </Field>
          </Section>
        </div>

        <div id="settings-profiles" className="scroll-mt-4">
          <Section title={t("settings.profiles")} icon={<Users className="h-4 w-4" />}>
            <div className="pt-3 text-[13px] text-muted">{t("settings.profilesDesc")}</div>
            <Profiles />
          </Section>
        </div>

        <div id="settings-data" className="scroll-mt-4">
          <Section title={t("settings.data")} icon={<HardDrive className="h-4 w-4" />}>
            <DataSection />
          </Section>
        </div>

        <div id="settings-about" className="scroll-mt-4">
          <Section title={t("settings.about")} icon={<Keyboard className="h-4 w-4" />}>
            <About />
          </Section>
        </div>
      </div>
    </div>
  );
}
