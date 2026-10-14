/** Raum-Scan: Räume anlegen/umbenennen/löschen, „Hier messen“, Rangliste je Band mit „Bester Platz“. */
import { useState, type FormEvent } from "react";
import { Check, Crown, House, Pencil, Plus, Ruler, Trash2, X } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { getLanguage, useT } from "@/lib/i18n";
import { bandNumber } from "@/lib/wifichan";
import { MAX_ROOMS, mixedBands, NAME_MAX, rankRooms, rateRssi, roomBand, roomRssi } from "@/lib/rooms";
import type { Room, RoomRating } from "@/lib/types";
import { confirmDialog, toast } from "@/store/ui";
import { useWifiScan } from "@/store/wifiscan";
import { Button } from "@shared/ui/Button";
import { ProgressBar } from "@shared/ui/ProgressBar";
import { cn } from "@shared/lib/cn";

const RATING_COLOR: Record<RoomRating, string> = {
  veryGood: "var(--nv-success)",
  good: "var(--nv-accent)",
  fair: "var(--nv-warning)",
  weak: "var(--nv-danger)",
};
const bandText = (b: string | null) => (b ? `${bandNumber(b, getLanguage())} GHz` : "–");

function NameForm({ initial, onSave, onCancel }: { initial: string; onSave: (name: string) => void; onCancel: () => void }) {
  const t = useT();
  const [name, setName] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSave(name);
  };
  return (
    <form onSubmit={submit} className="flex min-w-0 flex-1 items-center gap-2">
      <input
        autoFocus
        value={name}
        maxLength={NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        placeholder={t("wifiScan.rooms.namePlaceholder")}
        aria-label={t("wifiScan.rooms.nameLabel")}
        className="h-8 min-w-0 flex-1 rounded-sm border border-line bg-surface px-2.5 text-[13px] text-fg outline-none focus:border-accent"
      />
      <Button type="submit" size="icon-sm" variant="primary" icon={<Check className="h-4 w-4" />} aria-label={t("wifiScan.rooms.save")} disabled={!name.trim()} />
      <Button type="button" size="icon-sm" variant="ghost" icon={<X className="h-4 w-4" />} aria-label={t("wifiScan.rooms.cancel")} onClick={onCancel} />
    </form>
  );
}

function RoomRow({ room, best, canMeasure }: { room: Room; best: boolean; canMeasure: boolean }) {
  const t = useT();
  const { measuring, measureProgress, measure, renameRoom, deleteRoom } = useWifiScan();
  const [editing, setEditing] = useState(false);
  const rssi = roomRssi(room);
  const rating = rssi === null ? null : rateRssi(rssi);
  const busy = measuring === room.id;
  const remove = async () => {
    const ok = await confirmDialog({ title: t("wifiScan.rooms.deleteTitle", { name: room.name }), text: t("wifiScan.rooms.deleteText"), danger: true, confirmLabel: t("wifiScan.rooms.delete") });
    if (ok) await deleteRoom(room.id);
  };
  return (
    <div className={cn("rounded-lg bg-surface px-3 py-2.5", best && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nv-success)_45%,transparent)]")}>
      <div className="flex items-center gap-3">
        {editing ? (
          <NameForm
            initial={room.name}
            onCancel={() => setEditing(false)}
            onSave={(name) => {
              setEditing(false);
              void renameRoom(room.id, name);
            }}
          />
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-semibold text-fg">{room.name}</span>
                {best && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold text-success">
                    <Crown className="h-3 w-3" /> {t("wifiScan.rooms.best")}
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[11px] text-muted tabular">
                {rssi === null ? (
                  t("wifiScan.rooms.notMeasured")
                ) : (
                  <>
                    <span style={{ color: rating ? RATING_COLOR[rating] : undefined }} className="font-semibold">
                      {t(`wifiScan.rooms.rating.${rating}`)}
                    </span>
                    {` · ${Math.round(rssi)} dBm · ${bandText(roomBand(room))} · ${t("wifiScan.rooms.samples", { n: room.samples.length })}`}
                  </>
                )}
              </div>
            </div>
            <Button size="sm" variant={busy ? "secondary" : "glass"} icon={<Ruler className="h-3.5 w-3.5" />} loading={busy} disabled={!canMeasure || (measuring !== null && !busy)} title={canMeasure ? undefined : t("wifiScan.rooms.onlyWifi")} onClick={() => void measure(room.id)}>
              {busy ? t("wifiScan.rooms.measuring") : t("wifiScan.rooms.measure")}
            </Button>
            <Button size="icon-sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} aria-label={t("wifiScan.rooms.rename")} title={t("wifiScan.rooms.rename")} disabled={busy} onClick={() => setEditing(true)} />
            <Button size="icon-sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} aria-label={t("wifiScan.rooms.delete")} title={t("wifiScan.rooms.delete")} disabled={busy} onClick={() => void remove()} />
          </>
        )}
      </div>
      {busy && <ProgressBar value={measureProgress} className="mt-2" />}
    </div>
  );
}

export function RoomScan() {
  const t = useT();
  const { rooms, wifiState, measureError, addRoom } = useWifiScan();
  const [adding, setAdding] = useState(false);
  const list = rooms.rooms;
  const connected = wifiState?.state === "connected";
  const ranking = rankRooms(list);
  // „Bester Platz“ je Band – erst, wenn es dort etwas zu vergleichen gibt
  const bestIds = new Set(ranking.filter((g) => g.rooms.length > 1).map((g) => g.rooms[0].room.id));
  const full = list.length >= MAX_ROOMS;

  const add = async (name: string) => {
    const ok = await addRoom(name);
    if (ok) setAdding(false);
    else toast({ kind: "warning", title: t("wifiScan.rooms.maxRooms") });
  };

  return (
    <div className="glass rounded-xl p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
            <House className="h-4 w-4 text-accent" /> {t("wifiScan.rooms.title")}
          </div>
          <p className="mt-1 text-[13px] text-fg-soft">{t("wifiScan.rooms.intro")}</p>
        </div>
        {!adding && (
          <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} disabled={full} title={full ? t("wifiScan.rooms.maxRooms") : undefined} onClick={() => setAdding(true)}>
            {t("wifiScan.rooms.add")}
          </Button>
        )}
      </div>

      {!connected && (
        <div className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">{wifiState?.state === "locked" ? t("wifiScan.rooms.err.locked") : t("wifiScan.rooms.onlyWifi")}</div>
      )}
      {measureError && <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{t(`wifiScan.rooms.err.${measureError}`)}</div>}

      <div className="mt-3 flex flex-col gap-2">
        {adding && (
          <div className="rounded-lg bg-surface px-3 py-2.5">
            <NameForm initial="" onSave={(n) => void add(n)} onCancel={() => setAdding(false)} />
          </div>
        )}
        {list.length === 0 && !adding && <div className="rounded-lg bg-surface px-3 py-6 text-center text-[13px] text-muted">{t("wifiScan.rooms.empty")}</div>}
        {list.map((r) => (
          <RoomRow key={r.id} room={r} best={bestIds.has(r.id)} canMeasure={connected} />
        ))}
      </div>

      {ranking.some((g) => g.rooms.length > 0) && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="text-[10px] font-semibold tracking-[0.1em] text-faint uppercase">{t("wifiScan.rooms.ranking")}</div>
          <div className="mt-2 grid gap-4 xl:grid-cols-2">
            {ranking.map((g) => (
              <div key={String(g.band)}>
                <div className="text-[11px] font-semibold text-fg-soft">{bandText(g.band)}</div>
                <ol className="mt-1 space-y-1">
                  {g.rooms.map((r) => (
                    <li key={r.room.id} className="grid grid-cols-[52px_minmax(0,1fr)_64px_84px] items-center gap-2 text-[12px] tabular lg:grid-cols-[52px_minmax(0,1fr)_64px_84px_88px]">
                      <span className="text-faint">{t("wifiScan.rooms.rank", { n: r.rank })}</span>
                      <span className="truncate text-fg">{r.room.name}</span>
                      <span className="text-right" style={{ color: RATING_COLOR[r.rating] }}>
                        {Math.round(r.rssi)} dBm
                      </span>
                      <span className="text-right text-muted">{r.linkMbps !== null ? t("wifiScan.rooms.rate", { n: Math.round(r.linkMbps) }) : "–"}</span>
                      <span className="hidden text-right text-muted lg:block">{r.gatewayMs !== null ? t("wifiScan.rooms.router", { n: formatNumber(r.gatewayMs, 1) }) : ""}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
          {mixedBands(list) && <p className="mt-2 text-[12px] text-warning">{t("wifiScan.rooms.mixedBands")}</p>}
        </div>
      )}

      <p className="mt-4 text-[12px] leading-relaxed text-muted">
        {t("wifiScan.rooms.deviceHint")} {t("wifiScan.rooms.routerHint")}
      </p>
    </div>
  );
}
