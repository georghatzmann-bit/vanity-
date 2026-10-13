import { describe, expect, it } from "vitest";
import { setLang, t, type Lang } from "./i18n";

// `setLang` setzt die Sprache am Dokument – im Test reicht ein kleiner Platzhalter.
if (typeof document === "undefined") {
  (globalThis as { document?: unknown }).document = { documentElement: {} };
}

const langs: Lang[] = ["de", "en"];

describe("Setup-Texte", () => {
  it("Willkommenstext sagt ehrlich, wann Adminrechte nötig sind", () => {
    for (const l of langs) {
      setLang(l);
      const text = t("welcome.text");
      expect(text).not.toMatch(/ohne Adminrechte|no admin rights/i);
      expect(text).toMatch(/Konto|account/);
      expect(text).toContain("DNS");
    }
  });

  it("Hinweis nach unvollständigem Zurückstellen gibt es auf Deutsch und Englisch", () => {
    for (const l of langs) {
      setLang(l);
      for (const key of ["revertFailed", "revertFailedKept", "revertFailedForced", "revertFailedHow"]) {
        const text = t(`uninstall.${key}`);
        expect(text, `${l}: uninstall.${key}`).not.toBe(`uninstall.${key}`);
        expect(text.length).toBeGreaterThan(20);
      }
      // Knopf-Name wie in der App: „Alles zurückstellen“ / „Revert everything“, Ort „oben“.
      const how = t("uninstall.revertFailedHow");
      if (l === "de") {
        expect(how).toContain("„Alles zurückstellen“");
        expect(how).toContain("oben");
      } else {
        expect(how).toContain("“Revert everything”");
        expect(how).toContain("at the top");
      }
    }
  });
});
