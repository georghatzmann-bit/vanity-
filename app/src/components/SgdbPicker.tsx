import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Loader2, Search } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { Game, ImageKind, SgdbGame, SgdbImage } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/ui";
import { Modal } from "./ui/Modal";
import { cn } from "@shared/lib/cn";

/** Bilder bei SteamGridDB suchen und auswählen */
export function SgdbPicker({ game, kind, onClose }: { game: Game; kind: ImageKind; onClose: () => void }) {
  const t = useT();
  const key = useSettings((s) => s.settings.steamGridDbKey);
  const [query, setQuery] = useState(game.name);
  const [results, setResults] = useState<SgdbGame[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [images, setImages] = useState<SgdbImage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  const search = async () => {
    setBusy(true);
    try {
      const r = await api.sgdbSearch(query, key);
      setResults(r);
      if (r[0]) setSelected(r[0].id);
    } catch (e) {
      toast({ kind: "error", title: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (selected === null) return;
    setImages(null);
    api
      .sgdbImages(selected, kind, key)
      .then(setImages)
      .catch((e) => (toast({ kind: "error", title: errorText(e) }), setImages([])));
  }, [selected, kind, key]);

  const choose = async (img: SgdbImage) => {
    setSaving(img.url);
    try {
      const r = await api.imageDownload(img.url, game.id, kind);
      const g = useLibrary.getState().games.find((x) => x.id === game.id) ?? game;
      useLibrary.getState().updateGame(game.id, { images: { ...g.images, [kind]: r.path }, ...(kind === "cover" && r.palette ? { palette: r.palette } : {}) });
      toast({ kind: "success", title: t("game.imagesLoaded") });
      onClose();
    } catch (e) {
      toast({ kind: "error", title: errorText(e) });
    } finally {
      setSaving(null);
    }
  };

  const aspect = kind === "cover" ? "aspect-[2/3]" : kind === "hero" ? "aspect-[96/31] col-span-2" : "aspect-square";

  return (
    <Modal open onClose={onClose} title={t("game.searchImages")} subtitle={game.name} width={860}>
      <div className="flex gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void search()} className="input" />
        <button type="button" onClick={() => void search()} className="grid h-10 w-12 place-items-center rounded-md bg-gradient-accent text-white">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {results.map((r) => (
          <button key={r.id} type="button" onClick={() => setSelected(r.id)} className={cn("h-8 rounded-full px-3 text-[12px] font-medium transition", selected === r.id ? "bg-gradient-accent text-white" : "bg-surface-2 text-muted hover:text-fg")}>
            {r.name} {r.year ? `(${r.year})` : ""}
          </button>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-4 gap-3">
        {images === null && selected !== null && Array.from({ length: 8 }, (_, i) => <div key={i} className={cn("skeleton rounded-lg", aspect)} />)}
        {images?.map((img, i) => (
          <motion.button key={img.url} type="button" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }} whileHover={{ scale: 1.04 }} onClick={() => void choose(img)} className={cn("relative overflow-hidden rounded-lg bg-surface-2 ring-1 ring-line", aspect)}>
            <img src={img.thumb} alt="" className={cn("h-full w-full", kind === "logo" || kind === "icon" ? "object-contain p-2" : "object-cover")} loading="lazy" />
            {saving === img.url && (
              <div className="absolute inset-0 grid place-items-center bg-black/60">
                <Loader2 className="h-6 w-6 animate-spin text-white" />
              </div>
            )}
          </motion.button>
        ))}
      </div>
    </Modal>
  );
}
