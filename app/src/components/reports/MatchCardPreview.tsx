/**
 * Vorschau der Bildkarte (PNG) vor dem Speichern. Gezeichnet mit `renderMatchCard`, gespeichert über
 * `exportBytes` (Speichern-Dialog bzw. Download in der Demo). Dateiname `pulsar-match-<spiel>-<datum>.png`.
 */
import { useEffect, useState } from "react";
import { Download, ShieldCheck } from "lucide-react";
import { errorText } from "@/lib/api";
import { renderMatchCard } from "@/lib/cardexport";
import { exportBytes, matchCardFileName, PNG_FILTER } from "@/lib/exportfile";
import { useT } from "@/lib/i18n";
import type { Game, SessionReport, SessionTimeline } from "@/lib/types";
import { toast } from "@/store/ui";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@shared/ui/Button";

export function MatchCardPreview({ open, onClose, report, timeline, game }: { open: boolean; onClose: () => void; report: SessionReport; timeline: SessionTimeline | null; game: Game | null }) {
  const t = useT();
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let made: string | null = null;
    setBlob(null);
    setUrl(null);
    setFailed(false);
    renderMatchCard(report, timeline, game)
      .then((b) => {
        if (!alive) return;
        made = URL.createObjectURL(b);
        setBlob(b);
        setUrl(made);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [open, report, timeline, game]);

  const save = async () => {
    if (!blob) return;
    setSaving(true);
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (await exportBytes(matchCardFileName(report.gameName, report.start), PNG_FILTER, bytes)) onClose();
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={880}
      title={t("timeline.card.title")}
      subtitle={t("timeline.card.subtitle")}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-[12px] text-muted">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" /> {t("timeline.card.privacy")}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" icon={<Download className="h-4 w-4" />} disabled={!blob || saving} onClick={() => void save()}>
              {t("timeline.card.save")}
            </Button>
          </div>
        </div>
      }
    >
      <div className="p-5">
        <div className="relative aspect-[1200/630] w-full overflow-hidden rounded-xl border border-line bg-surface">
          {url ? (
            <img src={url} alt={t("timeline.card.title")} className="h-full w-full object-contain" data-match-card />
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted">{failed ? t("timeline.card.failed") : t("timeline.card.rendering")}</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
