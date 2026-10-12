import { useT } from "@/lib/i18n";
import { useUI } from "@/store/ui";
import { Button } from "@shared/ui/Button";
import { Modal } from "./ui/Modal";

export function ConfirmDialog() {
  const t = useT();
  const c = useUI((s) => s.confirmState);
  const close = useUI((s) => s.closeConfirm);
  return (
    <Modal
      open={!!c}
      onClose={() => close(false)}
      title={c?.title}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant={c?.danger ? "danger" : "primary"} onClick={() => close(true)} autoFocus>
            {c?.confirmLabel ?? t("common.yes")}
          </Button>
        </>
      }
    >
      {c?.text && <p className="text-sm leading-relaxed text-fg-soft">{c.text}</p>}
    </Modal>
  );
}
