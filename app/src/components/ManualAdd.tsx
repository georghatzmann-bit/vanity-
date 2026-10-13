import { useEffect, useState } from "react";
import { FileSearch, Link2 } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { EXE_FILTERS, pickFile } from "@/lib/dialog";
import { useT } from "@/lib/i18n";
import type { GameKind, ScannedEntry } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { toast, useUI } from "@/store/ui";
import { Modal } from "./ui/Modal";
import { Segmented } from "./ui/Segmented";
import { Button } from "@shared/ui/Button";

/** Eintrag von Hand hinzufügen: Programm, Verknüpfung oder Link */
export function ManualAdd() {
  const t = useT();
  const open = useUI((s) => s.manualOpen);
  const setOpen = useUI((s) => s.setManual);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [kind, setKind] = useState<GameKind>("game");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setTarget("");
      setKind("game");
    }
  }, [open]);

  const browse = async () => {
    const p = await pickFile({ filters: EXE_FILTERS });
    if (!p) return;
    setTarget(p);
    if (!name) setName(p.split(/[\\/]/).pop()?.replace(/\.(exe|lnk|url|bat|cmd)$/i, "").replace(/[_-]+/g, " ") ?? "");
  };

  const add = async () => {
    const tg = target.trim();
    if (!tg) return;
    setBusy(true);
    try {
      let entry: ScannedEntry;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tg) && !/^file:/i.test(tg)) {
        const steam = tg.match(/steam:\/\/rungameid\/(\d+)/i);
        entry = { name: name.trim() || tg, kind, source: steam ? "steam" : "manual", sourceId: steam?.[1], launch: { type: "url", target: tg } };
      } else {
        const [inspected] = await api.inspectPaths([tg]);
        entry = inspected ? { ...inspected, name: name.trim() || inspected.name, kind } : { name: name.trim() || tg, kind, source: "manual", launch: { type: "exe", target: tg }, exePath: tg };
        if (entry.source === "folder") entry.source = "manual";
      }
      const [g] = await useLibrary.getState().addEntries([entry]);
      setOpen(false);
      if (g) {
        toast({ kind: "success", title: t("scan.added", { n: 1 }), text: g.name });
        useUI.getState().navigate({ page: "game", id: g.id });
      }
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title={t("manual.title")}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={busy} disabled={!target.trim()} onClick={() => void add()}>
            {t("common.add")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <label>
          <div className="mb-1.5 text-[12px] font-medium text-muted">{t("manual.target")}</div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Link2 className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
              <input autoFocus value={target} onChange={(e) => setTarget(e.target.value)} className="input pl-9 font-mono text-[12px]" placeholder="C:\Games\…\game.exe" spellCheck={false} />
            </div>
            <Button icon={<FileSearch className="h-4 w-4" />} onClick={() => void browse()}>
              {t("manual.chooseFile")}
            </Button>
          </div>
          <div className="mt-1.5 text-[12px] text-faint">{t("manual.targetHint")}</div>
        </label>
        <label>
          <div className="mb-1.5 text-[12px] font-medium text-muted">{t("manual.name")}</div>
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} placeholder={t("manual.namePlaceholder")} className="input" />
        </label>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-muted">{t("manual.kind")}</div>
          <Segmented value={kind} onChange={setKind} options={[{ value: "game", label: t("common.game") }, { value: "app", label: t("common.app") }]} />
        </div>
      </div>
    </Modal>
  );
}
