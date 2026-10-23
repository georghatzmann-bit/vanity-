import { toast } from "sonner";

/** Kurze Rückmeldung für Knöpfe, die in Phase 1 noch nichts Echtes tun. */
export function previewToast(what: string, phase: number) {
  toast(what, {
    description: `Vorschau – das funktioniert ab Phase ${phase}.`,
  });
}
