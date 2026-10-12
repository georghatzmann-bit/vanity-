import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { FolderPlus, Pencil, Plus, Trash2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import { SMART } from "@/lib/smart";
import type { Collection, Game } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { confirmDialog, useUI } from "@/store/ui";
import { GameCover } from "@/components/GameCover";
import { GameCard } from "@/components/GameCard";
import { COLLECTION_ICONS, Icon } from "@/components/ui/icons";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@shared/ui/Button";
import { cn } from "@shared/lib/cn";
import { staggerContainer, staggerItem } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

const COLORS = ["#ff4f8b", "#ff8a4c", "#fbbf24", "#34d399", "#22d3ee", "#60a5fa", "#8b5cf6", "#f472b6", "#a3e635", "#94a3b8"];

function CollectionEditor({ initial, onClose }: { initial?: Collection; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(initial?.name ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "Folder");
  const [color, setColor] = useState(initial?.color ?? COLORS[0]);
  const [desc, setDesc] = useState(initial?.description ?? "");
  const save = async () => {
    if (!name.trim()) return;
    const c = await useLibrary.getState().saveCollection({ id: initial?.id, name: name.trim(), icon, color, description: desc.trim() || undefined });
    sound.play("success");
    onClose();
    if (!initial) useUI.getState().navigate({ page: "collections", id: c.id });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? t("common.edit") : t("collections.new")}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void save()}>
            {initial ? t("common.save") : t("common.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-4">
          <motion.div key={icon + color} initial={{ scale: 0.7, rotate: -20 }} animate={{ scale: 1, rotate: 0 }} className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl" style={{ background: `color-mix(in oklab, ${color} 22%, transparent)`, color, boxShadow: `0 0 30px -8px ${color}` }}>
            <Icon name={icon} className="h-7 w-7" />
          </motion.div>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} placeholder={t("collections.namePlaceholder")} className="input h-12 text-base" />
        </div>
        <div>
          <div className="mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">{t("collections.icon")}</div>
          <div className="grid grid-cols-11 gap-1.5">
            {COLLECTION_ICONS.map((ic) => (
              <button key={ic} type="button" onClick={() => (sound.play("tick"), setIcon(ic))} className={cn("grid h-9 w-9 place-items-center rounded-lg transition", icon === ic ? "bg-surface-3 text-fg ring-1 ring-accent" : "text-muted hover:bg-surface-2 hover:text-fg")}>
                <Icon name={ic} className="h-4 w-4" />
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">{t("collections.color")}</div>
          <div className="flex gap-2">
            {COLORS.map((c) => (
              <button key={c} type="button" onClick={() => (sound.play("tick"), setColor(c))} className={cn("h-8 w-8 rounded-full transition", color === c ? "scale-110 ring-2 ring-white/80 ring-offset-2 ring-offset-[var(--nv-bg-elev)]" : "hover:scale-110")} style={{ background: c }} aria-label={c} />
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">
            {t("collections.description")} <span className="font-normal normal-case">({t("common.optional")})</span>
          </div>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} className="input" />
        </div>
      </div>
    </Modal>
  );
}

function Collage({ games, color }: { games: Game[]; color: string }) {
  const four = games.slice(0, 4);
  return (
    <div className="relative h-36 overflow-hidden rounded-t-xl" style={{ background: `linear-gradient(135deg, color-mix(in oklab, ${color} 35%, var(--nv-bg-elev)), var(--nv-bg-elev))` }}>
      <div className="absolute inset-0 flex items-end justify-center gap-2 px-4 pt-4">
        {four.map((g, i) => (
          <div key={g.id} className="h-28 w-[19%] shrink-0 overflow-hidden rounded-md shadow-lg transition-transform duration-500 group-hover:-translate-y-2" style={{ transform: `rotate(${(i - 1.5) * 5}deg) translateY(${Math.abs(i - 1.5) * 8}px)`, transitionDelay: `${i * 40}ms` }}>
            <GameCover game={g} />
          </div>
        ))}
      </div>
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--nv-bg-elev)] via-transparent to-transparent" />
    </div>
  );
}

function CollectionTile({ name, icon, color, games, onClick, desc, smart }: { name: string; icon: string; color: string; games: Game[]; onClick: () => void; desc?: string; smart?: boolean }) {
  const t = useT();
  return (
    <motion.button variants={staggerItem} type="button" onMouseEnter={() => sound.play("hover")} onClick={onClick} whileHover={{ y: -6 }} className="glow-edge glass group overflow-hidden rounded-xl text-left [--glow-opacity:0] hover:[--glow-opacity:1]">
      <Collage games={games} color={color} />
      <div className="flex items-center gap-3 p-4 pt-2">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: `color-mix(in oklab, ${color} 22%, transparent)`, color }}>
          <Icon name={icon} className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <div className="truncate font-semibold text-fg">{name}</div>
          <div className="truncate text-[12px] text-muted">
            {t("collections.games", { n: games.length })}
            {desc ? ` · ${desc}` : ""}
            {smart ? " · ✦" : ""}
          </div>
        </div>
      </div>
    </motion.button>
  );
}

export function Collections({ id }: { id?: string }) {
  const t = useT();
  const collections = useLibrary((s) => s.collections);
  const games = useLibrary((s) => s.games);
  const stats = useLibrary((s) => s.stats);
  const running = useLibrary((s) => s.running);
  const launching = useLibrary((s) => s.launching);
  const [editing, setEditing] = useState<Collection | "new" | null>(null);
  const now = Date.now();
  const visible = useMemo(() => games.filter((g) => !g.hidden), [games]);

  const smartLists = useMemo(() => SMART.map((s) => ({ ...s, games: visible.filter((g) => s.filter(g, stats.get(g.id), now)) })), [visible, stats, now]);

  if (id) {
    const col = collections.find((c) => c.id === id);
    const smart = smartLists.find((s) => s.id === id);
    const list = col ? visible.filter((g) => g.collectionIds.includes(col.id)) : smart?.games ?? [];
    const name = col?.name ?? (smart ? t(smart.nameKey) : "");
    const icon = col?.icon ?? smart?.icon ?? "Folder";
    const color = col?.color ?? smart?.color ?? "#ff4f8b";
    return (
      <div className="mx-auto max-w-[1600px] px-8 pt-4 pb-28">
        <div className="flex items-center gap-5">
          <motion.div initial={{ scale: 0.5, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} className="grid h-16 w-16 place-items-center rounded-2xl" style={{ background: `color-mix(in oklab, ${color} 22%, transparent)`, color, boxShadow: `0 0 40px -10px ${color}` }}>
            <Icon name={icon} className="h-8 w-8" />
          </motion.div>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-3xl font-bold text-fg">{name}</h1>
            <p className="mt-1 text-sm text-muted">
              {t("collections.games", { n: list.length })}
              {col?.description ? ` · ${col.description}` : ""}
            </p>
          </div>
          {col && (
            <div className="flex gap-2">
              <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(col)}>
                {t("common.edit")}
              </Button>
              <Button
                variant="danger"
                icon={<Trash2 className="h-4 w-4" />}
                onClick={async () => {
                  if (await confirmDialog({ title: t("common.delete"), text: t("collections.deleteConfirm", { name: col.name }), danger: true, confirmLabel: t("common.delete") })) {
                    await useLibrary.getState().deleteCollection(col.id);
                    useUI.getState().navigate({ page: "collections" });
                  }
                }}
              >
                {t("common.delete")}
              </Button>
            </div>
          )}
        </div>
        {list.length === 0 ? (
          <EmptyState icon={<Icon name={icon} className="h-7 w-7" />} title={name} text={t("collections.empty")} />
        ) : (
          <motion.div variants={staggerContainer(0.03, 0.1)} initial="initial" animate="enter" className="mt-8 grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))" }}>
            {list.map((g) => (
              <motion.div key={g.id} variants={staggerItem}>
                <GameCard game={g} stats={stats.get(g.id)} running={running.has(g.id)} launching={launching.has(g.id)} fluid />
              </motion.div>
            ))}
          </motion.div>
        )}
        {editing && <CollectionEditor initial={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] px-8 pt-4 pb-28">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold text-fg">{t("collections.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("collections.subtitle")}</p>
        </div>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing("new")}>
          {t("collections.new")}
        </Button>
      </div>

      <h2 className="mt-8 mb-4 text-lg font-semibold text-fg">{t("collections.mine")}</h2>
      {collections.length === 0 ? (
        <button type="button" onClick={() => setEditing("new")} className="flex w-full items-center justify-center gap-3 rounded-xl border-2 border-dashed border-line py-10 text-muted transition hover:border-accent/60 hover:text-fg">
          <FolderPlus className="h-5 w-5" /> {t("collections.noCollections")} {t("collections.new")}
        </button>
      ) : (
        <motion.div variants={staggerContainer(0.05, 0.05)} initial="initial" animate="enter" className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {collections.map((c) => (
            <CollectionTile key={c.id} name={c.name} icon={c.icon} color={c.color} desc={c.description} games={visible.filter((g) => g.collectionIds.includes(c.id))} onClick={() => useUI.getState().navigate({ page: "collections", id: c.id })} />
          ))}
        </motion.div>
      )}

      <h2 className="mt-10 mb-4 text-lg font-semibold text-fg">{t("collections.smart")}</h2>
      <motion.div variants={staggerContainer(0.05, 0.1)} initial="initial" animate="enter" className="grid gap-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {smartLists.map((s) => (
          <CollectionTile key={s.id} smart name={t(s.nameKey)} icon={s.icon} color={s.color} games={s.games} onClick={() => useUI.getState().navigate({ page: "collections", id: s.id })} />
        ))}
      </motion.div>
      {editing && <CollectionEditor initial={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
