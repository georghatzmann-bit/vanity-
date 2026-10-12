import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ExternalLink, Gift, Pencil, Plus, ShoppingBag, Tag, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { WishItem } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { confirmDialog, toast } from "@/store/ui";
import { GenCover } from "@/components/GenCover";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Button } from "@shared/ui/Button";
import { spring } from "@shared/design/motion";
import { cn } from "@shared/lib/cn";

function parsePrice(s?: string): number | null {
  if (!s) return null;
  const m = s.replace(/\s/g, "").replace(",", ".").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function WishEditor({ initial, onClose }: { initial?: WishItem; onClose: () => void }) {
  const t = useT();
  const [w, setW] = useState<Partial<WishItem>>(initial ?? { priority: 2 });
  const set = (p: Partial<WishItem>) => setW({ ...w, ...p });
  const save = async () => {
    if (!w.name?.trim()) return;
    await useLibrary.getState().saveWish({ ...w, name: w.name.trim() } as WishItem);
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? t("common.edit") : t("wishlist.add")}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={!w.name?.trim()} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <label className="col-span-2">
          <div className="mb-1.5 text-[12px] font-medium text-muted">{t("wishlist.name")}</div>
          <input autoFocus value={w.name ?? ""} onChange={(e) => set({ name: e.target.value })} className="input" />
        </label>
        <label>
          <div className="mb-1.5 text-[12px] font-medium text-muted">{t("wishlist.price")}</div>
          <input value={w.price ?? ""} onChange={(e) => set({ price: e.target.value })} placeholder="59,99 €" className="input" />
        </label>
        <label>
          <div className="mb-1.5 text-[12px] font-medium text-muted">{t("wishlist.targetPrice")}</div>
          <input value={w.targetPrice ?? ""} onChange={(e) => set({ targetPrice: e.target.value })} placeholder="29,99 €" className="input" />
        </label>
        <label>
          <div className="mb-1.5 text-[12px] font-medium text-muted">{t("wishlist.store")}</div>
          <input value={w.store ?? ""} onChange={(e) => set({ store: e.target.value })} placeholder="Steam" className="input" />
        </label>
        <label>
          <div className="mb-1.5 text-[12px] font-medium text-muted">{t("wishlist.url")}</div>
          <input value={w.url ?? ""} onChange={(e) => set({ url: e.target.value })} placeholder="https://" className="input" />
        </label>
        <div className="col-span-2">
          <div className="mb-1.5 text-[12px] font-medium text-muted">{t("wishlist.priority")}</div>
          <Segmented<"1" | "2" | "3">
            value={String(w.priority ?? 2) as "1" | "2" | "3"}
            onChange={(v) => set({ priority: Number(v) as 1 | 2 | 3 })}
            options={[
              { value: "1", label: t("wishlist.p1") },
              { value: "2", label: t("wishlist.p2") },
              { value: "3", label: t("wishlist.p3") },
            ]}
          />
        </div>
        <label className="col-span-2">
          <div className="mb-1.5 text-[12px] font-medium text-muted">{t("wishlist.note")}</div>
          <textarea value={w.note ?? ""} onChange={(e) => set({ note: e.target.value })} rows={2} className="input" />
        </label>
      </div>
    </Modal>
  );
}

export function Wishlist() {
  const t = useT();
  const items = useLibrary((s) => s.wishlist);
  const [editing, setEditing] = useState<WishItem | "new" | null>(null);
  const sorted = [...items].sort((a, b) => a.priority - b.priority || b.addedAt - a.addedAt);
  const prioColor = { 1: "var(--nv-danger)", 2: "var(--nv-warning)", 3: "var(--nv-info)" } as const;

  return (
    <div className="mx-auto max-w-[1200px] px-8 pt-4 pb-28">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold text-fg">{t("wishlist.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("wishlist.subtitle")}</p>
        </div>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing("new")}>
          {t("wishlist.add")}
        </Button>
      </div>
      {items.length === 0 ? (
        <EmptyState icon={<Gift className="h-7 w-7" />} title={t("wishlist.empty")} text={t("wishlist.emptyText")} action={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing("new")}>{t("wishlist.add")}</Button>} />
      ) : (
        <div className="mt-8 flex flex-col gap-3">
          <AnimatePresence initial={false}>
            {sorted.map((w, i) => {
              const price = parsePrice(w.price);
              const target = parsePrice(w.targetPrice);
              const reached = price !== null && target !== null && price <= target;
              return (
                <motion.div key={w.id} layout initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0, transition: { ...spring.gentle, delay: i * 0.04 } }} exit={{ opacity: 0, x: 60, transition: { duration: 0.25 } }} className="glass group flex items-center gap-5 rounded-xl p-3 pr-5">
                  <div className="h-24 w-16 shrink-0 overflow-hidden rounded-lg shadow">
                    <GenCover name={w.name} kind="game" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: prioColor[w.priority], boxShadow: `0 0 8px ${prioColor[w.priority]}` }} />
                      <span className="truncate font-display text-lg font-semibold text-fg">{w.name}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
                      {w.store && (
                        <span className="flex items-center gap-1">
                          <ShoppingBag className="h-3.5 w-3.5" /> {w.store}
                        </span>
                      )}
                      <span>{formatRelative(w.addedAt)}</span>
                      {w.note && <span className="truncate italic">„{w.note}“</span>}
                    </div>
                  </div>
                  <div className="text-right">
                    {w.price && <div className={cn("font-display text-xl font-bold tabular", reached ? "text-success" : "text-fg")}>{w.price}</div>}
                    {w.targetPrice && (
                      <div className="flex items-center justify-end gap-1 text-[12px] text-muted">
                        <Tag className="h-3 w-3" /> {t("wishlist.targetPrice")}: {w.targetPrice}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1 opacity-0 transition group-hover:opacity-100">
                    {w.url && (
                      <button type="button" onClick={() => void api.openUrl(w.url!)} className="grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg" aria-label="Link">
                        <ExternalLink className="h-4 w-4" />
                      </button>
                    )}
                    <button type="button" onClick={() => setEditing(w)} className="grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg" aria-label={t("common.edit")}>
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (await confirmDialog({ title: t("common.remove"), text: t("wishlist.deleteConfirm", { name: w.name }), danger: true, confirmLabel: t("common.remove") })) {
                          await useLibrary.getState().deleteWish(w.id);
                          toast({ kind: "info", title: t("game.removed", { name: w.name }) });
                        }
                      }}
                      className="grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-danger/15 hover:text-danger"
                      aria-label={t("common.delete")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
      {editing && <WishEditor initial={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
