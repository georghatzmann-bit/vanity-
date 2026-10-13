import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity, Archive, CalendarClock, Clock3, Cog, Folder, FolderOpen, Gamepad2, Hash, Heart, History, Image as ImageIcon, MoreHorizontal, Play, Plus, RotateCcw,
  Shield, Square, Timer, Trash2, Wrench, X, Camera, Wand2, Upload, Search,
} from "lucide-react";
import { api, errorText, imgSrc } from "@/lib/api";
import { uid } from "@/lib/defaults";
import { EXE_FILTERS, IMAGE_FILTERS, pickFile, pickFolder } from "@/lib/dialog";
import { formatDate, formatDateTime, formatDuration, formatRelative, startOfDay } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { perDay, sumBetween } from "@/lib/stats";
import type { Game, ImageKind, LaunchType, PlayStatus, SaveBackup, Session } from "@/lib/types";
import { gameMenuItems } from "@/hooks/gameMenu";
import { useNow } from "@/hooks/useNow";
import { liveSeconds, useLibrary } from "@/store/library";
import { useSettings } from "@/store/settings";
import { confirmDialog, toast, useUI } from "@/store/ui";
import { BarChart } from "@/components/charts/BarChart";
import { GameCover } from "@/components/GameCover";
import { Screenshots } from "@/components/Screenshots";
import { SgdbPicker } from "@/components/SgdbPicker";
import { useContextMenu } from "@/components/ui/ContextMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { StarRating } from "@/components/ui/StarRating";
import { Tabs } from "@/components/ui/Tabs";
import { Button } from "@shared/ui/Button";
import { CountUp } from "@shared/ui/CountUp";
import { Toggle } from "@shared/ui/Toggle";
import { cn } from "@shared/lib/cn";
import { spring, staggerContainer, staggerItem } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

type Tab = "overview" | "screens" | "links" | "settings";

function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string }) {
  return (
    <motion.div variants={staggerItem} className="glass rounded-xl px-4 py-3.5">
      <div className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
        <span className="text-accent">{icon}</span>
        {label}
      </div>
      <div className="mt-1.5 font-display text-xl font-bold text-fg tabular">{value}</div>
      {sub && <div className="text-[11px] text-faint">{sub}</div>}
    </motion.div>
  );
}

/** Tags hinzufügen/entfernen */
function TagEditor({ game }: { game: Game }) {
  const t = useT();
  const [value, setValue] = useState("");
  const update = useLibrary((s) => s.updateGame);
  const add = () => {
    const v = value.trim().replace(/^#/, "");
    if (v && !game.tags.includes(v)) {
      sound.play("toggleOn");
      update(game.id, { tags: [...game.tags, v] });
    }
    setValue("");
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <AnimatePresence>
        {game.tags.map((tag) => (
          <motion.span key={tag} layout initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} className="flex h-7 items-center gap-1 rounded-full bg-accent/12 pr-1 pl-3 text-[12px] font-medium text-fg ring-1 ring-accent/30">
            #{tag}
            <button type="button" onClick={() => update(game.id, { tags: game.tags.filter((x) => x !== tag) })} className="grid h-5 w-5 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-fg" aria-label="Tag entfernen">
              <X className="h-3 w-3" />
            </button>
          </motion.span>
        ))}
      </AnimatePresence>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder={t("game.addTag")}
        className="h-7 w-36 rounded-full border border-dashed border-line-strong bg-transparent px-3 text-[12px] text-fg outline-none placeholder:text-faint focus:border-accent"
      />
    </div>
  );
}

function Overview({ game, sessions }: { game: Game; sessions: Session[] }) {
  const t = useT();
  const update = useLibrary((s) => s.updateGame);
  const collections = useLibrary((s) => s.collections);
  const [notes, setNotes] = useState(game.notes);
  const [addMinutes, setAddMinutes] = useState("");

  useEffect(() => setNotes(game.notes), [game.id, game.notes]);
  useEffect(() => {
    if (notes === game.notes) return;
    const id = window.setTimeout(() => update(game.id, { notes }), 600);
    return () => window.clearTimeout(id);
  }, [notes, game.id, game.notes, update]);

  const days = useMemo(() => perDay(sessions, 30), [sessions]);
  const statuses: PlayStatus[] = ["none", "want", "playing", "paused", "done"];

  const addTime = async () => {
    const mins = Number(addMinutes.replace(",", "."));
    if (!mins || mins <= 0) return;
    try {
      await api.playtimeAdd(game.id, Math.round(mins * 60), Date.now() - mins * 60000);
      await useLibrary.getState().refreshStats();
      toast({ kind: "success", title: t("game.timeAdded", { time: formatDuration(mins * 60) }) });
      setAddMinutes("");
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.1fr_1fr]">
      <div className="flex flex-col gap-6">
        {game.kind === "game" && (
          <div className="glass rounded-xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">{t("game.rating")}</div>
                <StarRating value={game.rating} onChange={(v) => update(game.id, { rating: v })} size={26} />
              </div>
              <div>
                <div className="mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">{t("game.status")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {statuses.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        sound.play(s === "done" ? "success" : "click");
                        update(game.id, { status: s });
                      }}
                      className={cn("h-8 rounded-full px-3 text-[12px] font-medium transition", game.status === s ? "bg-gradient-accent text-white shadow-glow" : "bg-surface-2 text-muted hover:text-fg")}
                    >
                      {t(`status.${s}`)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
        <div className="glass rounded-xl p-5">
          <div className="mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">{t("game.notes")}</div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={5} placeholder={t("game.notesPlaceholder")} className="input" />
        </div>
        <div className="glass rounded-xl p-5">
          <div className="mb-3 flex items-center gap-2 text-[12px] font-semibold tracking-wider text-muted uppercase">
            <Hash className="h-3.5 w-3.5" /> {t("game.tags")}
          </div>
          <TagEditor game={game} />
          <div className="mt-5 mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">{t("game.genre")}</div>
          <input value={game.genre ?? ""} onChange={(e) => update(game.id, { genre: e.target.value || undefined })} placeholder={t("game.genrePlaceholder")} className="input max-w-xs" />
          {collections.length > 0 && (
            <>
              <div className="mt-5 mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">{t("game.collections")}</div>
              <div className="flex flex-wrap gap-2">
                {collections.map((c) => {
                  const on = game.collectionIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        sound.play(on ? "toggleOff" : "toggleOn");
                        useLibrary.getState().toggleInCollection(game.id, c.id);
                      }}
                      className={cn("flex h-8 items-center gap-2 rounded-full border px-3 text-[12px] font-medium transition", on ? "border-transparent text-fg" : "border-line text-muted hover:text-fg")}
                      style={on ? { background: `color-mix(in oklab, ${c.color} 22%, transparent)`, boxShadow: `inset 0 0 0 1px ${c.color}` } : undefined}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ background: c.color }} />
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-6">
        <div className="glass rounded-xl p-5">
          <div className="mb-4 flex items-center gap-2 text-[12px] font-semibold tracking-wider text-muted uppercase">
            <Activity className="h-3.5 w-3.5" /> {t("game.activity")}
          </div>
          <BarChart data={days.map((d) => ({ key: d.key, label: new Date(d.start).getDate().toString(), value: d.seconds, tooltip: formatDate(d.start) }))} height={130} format={(v) => formatDuration(v, { short: true })} labelEvery={5} />
        </div>
        <div className="glass rounded-xl p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12px] font-semibold tracking-wider text-muted uppercase">
              <History className="h-3.5 w-3.5" /> {t("game.sessionsList")}
            </div>
          </div>
          {sessions.length === 0 ? (
            <div className="py-4 text-sm text-muted">{t("library.neverPlayed")}</div>
          ) : (
            <div className="flex max-h-64 flex-col overflow-y-auto">
              {sessions.slice(0, 30).map((s) => (
                <div key={s.id} className="group flex items-center justify-between rounded-md px-2 py-2 text-[13px] hover:bg-surface-2">
                  <span className="text-fg-soft">{formatDateTime(s.start)}</span>
                  <span className="flex items-center gap-3">
                    <span className="font-medium text-fg tabular">{formatDuration(s.seconds)}</span>
                    <button
                      type="button"
                      className="text-faint opacity-0 transition group-hover:opacity-100 hover:text-danger"
                      aria-label={t("common.delete")}
                      onClick={async () => {
                        await api.sessionDelete(s.id).catch(() => undefined);
                        await useLibrary.getState().refreshStats();
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 flex items-center gap-2 border-t border-line pt-4">
            <input value={addMinutes} onChange={(e) => setAddMinutes(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void addTime()} placeholder={`${t("game.addTime")} (${t("time.minutes")})`} className="input h-9 flex-1" inputMode="decimal" />
            <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => void addTime()}>
              {t("common.add")}
            </Button>
          </div>
          <div className="mt-1.5 text-[11px] text-faint">{t("game.addTimeHint")}</div>
        </div>
      </div>
    </div>
  );
}

function FolderRow({ label, value, onSet, icon }: { label: string; value?: string; onSet: (v: string | undefined) => void; icon: React.ReactNode }) {
  const t = useT();
  return (
    <div className="flex items-center gap-4 py-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-accent">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg">{label}</div>
        <div className="truncate text-[12px] text-muted">{value || t("common.notSet")}</div>
      </div>
      {value && (
        <Button size="sm" variant="ghost" icon={<FolderOpen className="h-4 w-4" />} onClick={() => void api.openPath(value).catch((e) => toast({ kind: "error", title: errorText(e) }))}>
          {t("common.open")}
        </Button>
      )}
      <Button
        size="sm"
        variant="secondary"
        onClick={async () => {
          const p = await pickFolder(label);
          if (p) onSet(p);
        }}
      >
        {t("game.setFolder")}
      </Button>
      {value && (
        <button type="button" onClick={() => onSet(undefined)} className="text-faint hover:text-danger" aria-label={t("common.remove")}>
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function LinksTab({ game }: { game: Game }) {
  const t = useT();
  const update = useLibrary((s) => s.updateGame);
  const [backups, setBackups] = useState<SaveBackup[]>([]);
  const [busy, setBusy] = useState(false);
  const [toolName, setToolName] = useState("");

  const loadBackups = () => void api.saveBackupList(game.id).then(setBackups).catch(() => setBackups([]));
  useEffect(loadBackups, [game.id]);

  const setLink = (k: "saves" | "config" | "mods" | "screenshots", v?: string) => update(game.id, { links: { ...game.links, [k]: v } });

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <div className="glass rounded-xl px-5 py-2">
        <div className="border-b border-line py-3 text-[12px] font-semibold tracking-wider text-muted uppercase">{t("game.folders")}</div>
        <div className="divide-y divide-line">
          <FolderRow label={t("game.saves")} value={game.links.saves} onSet={(v) => setLink("saves", v)} icon={<Archive className="h-4 w-4" />} />
          <FolderRow label={t("game.config")} value={game.links.config} onSet={(v) => setLink("config", v)} icon={<Cog className="h-4 w-4" />} />
          <FolderRow label={t("game.mods")} value={game.links.mods} onSet={(v) => setLink("mods", v)} icon={<Wand2 className="h-4 w-4" />} />
          <FolderRow label={t("game.screenshotsFolder")} value={game.links.screenshots} onSet={(v) => setLink("screenshots", v)} icon={<Camera className="h-4 w-4" />} />
          {game.installDir && <FolderRow label={t("game.installDir")} value={game.installDir} onSet={(v) => update(game.id, { installDir: v })} icon={<Folder className="h-4 w-4" />} />}
        </div>
      </div>

      <div className="flex flex-col gap-6">
        <div className="glass rounded-xl p-5">
          <div className="mb-3 flex items-center gap-2 text-[12px] font-semibold tracking-wider text-muted uppercase">
            <Wrench className="h-3.5 w-3.5" /> {t("game.tools")}
          </div>
          <div className="flex flex-col gap-1">
            {game.links.tools.map((tool) => (
              <div key={tool.id} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
                <Wrench className="h-4 w-4 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-fg">{tool.name}</div>
                  <div className="truncate text-[11px] text-faint">{tool.path}</div>
                </div>
                <Button size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" />} onClick={() => void api.launchTool(tool.path, tool.args).catch((e) => toast({ kind: "error", title: errorText(e) }))}>
                  {t("common.start")}
                </Button>
                <button type="button" className="text-faint opacity-0 group-hover:opacity-100 hover:text-danger" onClick={() => update(game.id, { links: { ...game.links, tools: game.links.tools.filter((x) => x.id !== tool.id) } })} aria-label={t("common.remove")}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <input value={toolName} onChange={(e) => setToolName(e.target.value)} placeholder={t("game.toolName")} className="input h-9 flex-1" />
            <Button
              size="sm"
              icon={<Plus className="h-4 w-4" />}
              onClick={async () => {
                const p = await pickFile({ filters: EXE_FILTERS });
                if (!p) return;
                const name = toolName.trim() || p.split(/[\\/]/).pop()?.replace(/\.\w+$/, "") || "Tool";
                update(game.id, { links: { ...game.links, tools: [...game.links.tools, { id: uid("tool"), name, path: p }] } });
                setToolName("");
              }}
            >
              {t("game.addTool")}
            </Button>
          </div>
        </div>

        <div className="glass rounded-xl p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12px] font-semibold tracking-wider text-muted uppercase">
              <Shield className="h-3.5 w-3.5" /> {t("game.backups")}
            </div>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              icon={<Archive className="h-4 w-4" />}
              disabled={!game.links.saves}
              onClick={async () => {
                if (!game.links.saves) return;
                setBusy(true);
                try {
                  await api.saveBackupCreate(game.id, game.links.saves);
                  toast({ kind: "success", title: t("game.backupDone") });
                  useLibrary.getState().bump("saveBackups");
                  loadBackups();
                } catch (e) {
                  toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("game.backupNow")}
            </Button>
          </div>
          {!game.links.saves && <div className="text-sm text-muted">{t("game.needSaveFolder")}</div>}
          {game.links.saves && backups.length === 0 && <div className="text-sm text-muted">{t("game.noBackups")}</div>}
          <div className="flex flex-col">
            {backups.map((b) => (
              <div key={b.id} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
                <CalendarClock className="h-4 w-4 text-muted" />
                <div className="flex-1 text-[13px] text-fg">{formatDateTime(b.createdAt)}</div>
                <span className="text-[12px] text-faint">{(b.size / 1048576).toFixed(1)} MB</span>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<RotateCcw className="h-3.5 w-3.5" />}
                  onClick={async () => {
                    if (!game.links.saves) return;
                    const ok = await confirmDialog({ title: t("game.restore"), text: t("game.restoreConfirm", { date: formatDateTime(b.createdAt) }) });
                    if (!ok) return;
                    try {
                      await api.saveBackupRestore(game.id, b.id, game.links.saves);
                      toast({ kind: "success", title: t("game.restored") });
                      loadBackups();
                    } catch (e) {
                      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
                    }
                  }}
                >
                  {t("game.restore")}
                </Button>
                <button type="button" className="text-faint opacity-0 group-hover:opacity-100 hover:text-danger" aria-label={t("common.delete")} onClick={async () => (await api.saveBackupDelete(game.id, b.id).catch(() => undefined), loadBackups())}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ImageSlot({ game, kind, label, aspect }: { game: Game; kind: ImageKind; label: string; aspect: string }) {
  const t = useT();
  const path = game.images[kind];
  const [picker, setPicker] = useState(false);
  const apiKey = useSettings((s) => s.settings.steamGridDbKey);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className={cn("group relative overflow-hidden rounded-lg border border-line bg-surface-2", aspect)}>
        {path ? <img src={imgSrc(path)} alt="" className={cn("h-full w-full", kind === "logo" || kind === "icon" ? "object-contain p-3" : "object-cover")} /> : <div className="grid h-full place-items-center text-faint"><ImageIcon className="h-6 w-6" /></div>}
        <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/60 opacity-0 backdrop-blur-sm transition group-hover:opacity-100">
          {apiKey && (
            <button type="button" title={t("game.searchImages")} onClick={() => setPicker(true)} className="grid h-8 w-8 place-items-center rounded-md bg-white/15 text-white hover:bg-white/25">
              <Search className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            title={t("game.customImage")}
            onClick={async () => {
              const p = await pickFile({ filters: IMAGE_FILTERS });
              if (!p) return;
              try {
                const r = await api.imageSetCustom(game.id, kind, p);
                useLibrary.getState().updateGame(game.id, { images: { ...game.images, [kind]: r.path }, ...(kind === "cover" && r.palette ? { palette: r.palette } : {}) });
              } catch (e) {
                toast({ kind: "error", title: errorText(e) });
              }
            }}
            className="grid h-8 w-8 place-items-center rounded-md bg-white/15 text-white hover:bg-white/25"
          >
            <Upload className="h-4 w-4" />
          </button>
          {path && (
            <button type="button" title={t("common.remove")} onClick={() => useLibrary.getState().updateGame(game.id, { images: { ...game.images, [kind]: undefined } })} className="grid h-8 w-8 place-items-center rounded-md bg-white/15 text-white hover:bg-danger/80">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      {picker && <SgdbPicker game={game} kind={kind} onClose={() => setPicker(false)} />}
    </div>
  );
}

function SettingsTab({ game }: { game: Game }) {
  const t = useT();
  const update = useLibrary((s) => s.updateGame);
  const apiKey = useSettings((s) => s.settings.steamGridDbKey);
  const [loading, setLoading] = useState(false);
  const l = game.launch;
  const setLaunch = (patch: Partial<typeof l>) => update(game.id, { launch: { ...l, ...patch } });

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <div className="glass rounded-xl px-5 py-2">
        <div className="divide-y divide-line">
          <Field label={t("manual.name")} stacked>
            <input value={game.name} onChange={(e) => update(game.id, { name: e.target.value })} className="input" />
          </Field>
          <Field label={t("game.kindLabel")}>
            <Segmented value={game.kind} onChange={(v) => update(game.id, { kind: v })} options={[{ value: "game", label: t("common.game") }, { value: "app", label: t("common.app") }]} />
          </Field>
          <Field label={t("game.launchType")} stacked>
            <Segmented<LaunchType> value={l.type} onChange={(v) => setLaunch({ type: v })} options={[{ value: "exe", label: t("game.launchExe") }, { value: "url", label: t("game.launchUrl") }, { value: "shell", label: t("game.launchShell") }]} />
          </Field>
          <Field label={t("game.target")} stacked>
            <div className="flex gap-2">
              <input value={l.target} onChange={(e) => setLaunch({ target: e.target.value })} className="input font-mono text-[12px]" spellCheck={false} />
              {l.type !== "url" && (
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const p = await pickFile({ filters: EXE_FILTERS });
                    if (p) update(game.id, { launch: { ...l, target: p }, exePath: p.toLowerCase().endsWith(".exe") ? p : game.exePath });
                  }}
                >
                  {t("common.browse")}
                </Button>
              )}
            </div>
          </Field>
          {l.type === "exe" && (
            <>
              <Field label={t("game.args")} stacked>
                <input value={l.args ?? ""} onChange={(e) => setLaunch({ args: e.target.value || undefined })} placeholder={t("game.argsPlaceholder")} className="input font-mono text-[12px]" spellCheck={false} />
              </Field>
              <Field label={t("game.workDir")} stacked>
                <div className="flex gap-2">
                  <input value={l.workDir ?? ""} onChange={(e) => setLaunch({ workDir: e.target.value || undefined })} className="input font-mono text-[12px]" spellCheck={false} />
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      const p = await pickFolder();
                      if (p) setLaunch({ workDir: p });
                    }}
                  >
                    {t("common.browse")}
                  </Button>
                </div>
              </Field>
            </>
          )}
          {l.type !== "url" && (
            <Field label={t("game.asAdmin")} description={t("game.asAdminDesc")}>
              <Toggle checked={!!l.asAdmin} onChange={(v) => setLaunch({ asAdmin: v })} />
            </Field>
          )}
          <Field label={t("game.processNames")} description={t("game.processNamesHint")} stacked>
            <input
              value={(game.processNames ?? []).join(", ")}
              onChange={(e) =>
                update(game.id, {
                  processNames: e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                })
              }
              placeholder="game.exe"
              className="input font-mono text-[12px]"
              spellCheck={false}
            />
          </Field>
        </div>
      </div>

      <div className="glass rounded-xl p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="text-[12px] font-semibold tracking-wider text-muted uppercase">{t("game.images")}</div>
          <Button
            size="sm"
            variant="primary"
            loading={loading}
            icon={<Wand2 className="h-4 w-4" />}
            onClick={async () => {
              setLoading(true);
              const n = await useLibrary.getState().fetchImages([game], { force: true });
              setLoading(false);
              toast(n ? { kind: "success", title: t("game.imagesLoaded") } : { kind: "info", title: game.name, text: t("game.noApiKey") });
            }}
          >
            {t("game.autoImages")}
          </Button>
        </div>
        {!apiKey && game.source !== "steam" && <div className="mb-4 rounded-lg bg-info/10 px-3 py-2 text-[12px] text-fg-soft ring-1 ring-info/30">{t("game.noApiKey")}</div>}
        <div className="grid grid-cols-[1fr_2fr] gap-4">
          <ImageSlot game={game} kind="cover" label={t("game.cover")} aspect="aspect-[2/3]" />
          <div className="flex flex-col gap-4">
            <ImageSlot game={game} kind="hero" label={t("game.hero")} aspect="aspect-[96/31]" />
            <div className="grid grid-cols-2 gap-4">
              <ImageSlot game={game} kind="logo" label={t("game.logo")} aspect="aspect-[2/1]" />
              <ImageSlot game={game} kind="icon" label={t("game.icon")} aspect="aspect-square max-h-28" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GameDetail({ id }: { id: string }) {
  const t = useT();
  const game = useLibrary((s) => s.games.find((g) => g.id === id));
  const stats = useLibrary((s) => s.stats.get(id));
  const run = useLibrary((s) => s.running.get(id));
  const launching = useLibrary((s) => s.launching.has(id));
  const allSessions = useLibrary((s) => s.sessions);
  const [tab, setTab] = useState<Tab>("overview");
  const [sessions, setSessions] = useState<Session[]>([]);
  const now = useNow(1000, !!run);

  useEffect(() => {
    if (game) useUI.getState().setFocusGame(game.id);
  }, [game]);

  useEffect(() => {
    const onTab = (e: Event) => setTab((e as CustomEvent<Tab>).detail);
    document.addEventListener("nova:tab", onTab);
    return () => document.removeEventListener("nova:tab", onTab);
  }, []);

  useEffect(() => {
    void api.sessionsForGame(id, 200).then(setSessions).catch(() => setSessions([]));
  }, [id, stats?.totalSeconds, allSessions.length]);

  if (!game) {
    return <EmptyState icon={<Gamepad2 className="h-7 w-7" />} title={t("game.notFound")} action={<Button onClick={() => useUI.getState().navigate({ page: "library" })}>{t("nav.library")}</Button>} />;
  }

  const total = liveSeconds(stats, run, now);
  const week = sumBetween(sessions, startOfDay(Date.now()) - ((new Date().getDay() + 6) % 7) * 86400000);
  const month = sumBetween(sessions, new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime());

  return (
    <div className="pb-28">
      {/* Kopfbereich */}
      <div className="relative h-[380px] overflow-hidden">
        <motion.div className="absolute inset-0" initial={{ scale: 1.08, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}>
          <GameCover game={game} variant="hero" />
        </motion.div>
        <div className="absolute inset-0 bg-gradient-to-t from-[var(--nv-bg)] via-[color-mix(in_oklab,var(--nv-bg)_55%,transparent)] to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-[color-mix(in_oklab,var(--nv-bg)_80%,transparent)] to-transparent" />
        <div className="relative mx-auto flex h-full max-w-[1500px] items-end gap-8 px-8 pb-8">
          <motion.div layoutId={`cover-${game.id}`} className="card-shadow hidden h-[255px] w-[170px] shrink-0 overflow-hidden rounded-xl ring-1 ring-white/10 lg:block" initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={spring.gentle}>
            <GameCover game={game} />
          </motion.div>
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-black/40 px-2.5 py-1 text-[11px] font-semibold tracking-wider text-white/80 uppercase backdrop-blur">{game.kind === "app" ? t("common.app") : t(`source.${game.source}`)}</span>
              {game.genre && <span className="rounded-full bg-black/40 px-2.5 py-1 text-[11px] font-medium text-white/80 backdrop-blur">{game.genre}</span>}
              {game.status !== "none" && <span className="rounded-full bg-gradient-accent px-2.5 py-1 text-[11px] font-semibold text-white">{t(`status.${game.status}`)}</span>}
            </div>
            {game.images.logo ? (
              <img src={imgSrc(game.images.logo)} alt={game.name} className="mb-5 max-h-28 max-w-[460px] object-contain object-left drop-shadow-[0_6px_30px_rgb(0_0_0/0.6)]" />
            ) : (
              <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-5 font-display text-5xl leading-[1.05] font-bold text-fg [text-shadow:0_4px_30px_rgb(0_0_0/0.35)]">
                {game.name}
              </motion.h1>
            )}
            <div className="flex flex-wrap items-center gap-3">
              {run ? (
                <Button size="lg" variant="danger-solid" icon={<Square className="h-4 w-4" fill="currentColor" />} onClick={async () => (await confirmDialog({ title: t("common.stop"), text: t("game.stopConfirm", { name: game.name }), danger: true, confirmLabel: t("common.stop") })) && void useLibrary.getState().stop(game.id)}>
                  {t("common.stop")} · {formatDuration((now - run.startedAt) / 1000, { showSeconds: true })}
                </Button>
              ) : (
                <Button size="lg" variant="primary" loading={launching} silent icon={<Play className="h-5 w-5" fill="currentColor" />} className="min-w-44" onClick={() => void useLibrary.getState().launch(game)}>
                  {game.kind === "app" ? t("common.start") : t("common.play")}
                </Button>
              )}
              <motion.button
                type="button"
                whileTap={{ scale: 0.85 }}
                onClick={() => {
                  sound.play(game.favorite ? "toggleOff" : "toggleOn");
                  useLibrary.getState().updateGame(game.id, { favorite: !game.favorite });
                }}
                className={cn("glass grid h-12 w-12 place-items-center rounded-lg transition", game.favorite ? "text-accent" : "text-muted hover:text-fg")}
                aria-label={t("game.favorite")}
              >
                <motion.span key={String(game.favorite)} initial={{ scale: 0.5 }} animate={{ scale: [0.5, 1.3, 1] }} transition={{ duration: 0.4 }}>
                  <Heart className="h-5 w-5" fill={game.favorite ? "currentColor" : "none"} />
                </motion.span>
              </motion.button>
              <button type="button" onClick={(e) => useContextMenu.getState().open(e.clientX, e.clientY, gameMenuItems(game))} className="glass grid h-12 w-12 place-items-center rounded-lg text-muted transition hover:text-fg" aria-label="Menü">
                <MoreHorizontal className="h-5 w-5" />
              </button>
              {game.launch.args && <span className="text-[12px] text-faint">{game.launch.args}</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1500px] px-8">
        <motion.div variants={staggerContainer(0.05, 0.1)} initial="initial" animate="enter" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatCard icon={<Clock3 className="h-3.5 w-3.5" />} label={t("game.totalTime")} value={<CountUp value={total / 3600} format={(v) => `${v.toFixed(1).replace(".", ",")} ${t("time.h")}`} />} />
          <StatCard icon={<Timer className="h-3.5 w-3.5" />} label={t("game.lastSession")} value={stats?.lastSessionSeconds ? formatDuration(stats.lastSessionSeconds, { short: true }) : "–"} />
          <StatCard icon={<CalendarClock className="h-3.5 w-3.5" />} label={t("game.thisWeek")} value={formatDuration(week, { short: true })} />
          <StatCard icon={<CalendarClock className="h-3.5 w-3.5" />} label={t("game.thisMonth")} value={formatDuration(month, { short: true })} />
          <StatCard icon={<History className="h-3.5 w-3.5" />} label={t("game.sessions")} value={<CountUp value={stats?.sessions ?? 0} />} />
          <StatCard icon={<Activity className="h-3.5 w-3.5" />} label={t("game.lastPlayed")} value={stats?.lastPlayedAt ? formatRelative(stats.lastPlayedAt) : "–"} sub={stats?.firstPlayedAt ? `${t("game.firstPlayed")}: ${formatDate(stats.firstPlayedAt)}` : `${t("game.added")}: ${formatDate(game.addedAt)}`} />
        </motion.div>

        <Tabs
          className="mt-8 mb-6"
          value={tab}
          onChange={(v) => {
            setTab(v);
            if (v === "screens") useLibrary.getState().bump("galleryOpened");
          }}
          tabs={[
            { value: "overview", label: t("game.tabOverview") },
            { value: "screens", label: t("game.tabScreens") },
            { value: "links", label: t("game.tabLinks") },
            { value: "settings", label: t("game.tabSettings") },
          ]}
        />
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }}>
            {tab === "overview" && <Overview game={game} sessions={sessions} />}
            {tab === "screens" && <Screenshots game={game} />}
            {tab === "links" && <LinksTab game={game} />}
            {tab === "settings" && <SettingsTab game={game} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
