import { describe, expect, it } from "vitest";
import { dictionaries, setLang, t, type Lang } from "./i18n";

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

type Tree = { [k: string]: string | Tree };

/** Alle Blätter als „a.b.c“ → Text */
function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of leaves(v, key)) out.set(kk, vv);
  }
  return out;
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("Wörterbücher de/en (I.6)", () => {
  const de = leaves(dictionaries.de as unknown as Tree);
  const en = leaves(dictionaries.en as unknown as Tree);

  it("identische Schlüsselbäume (rekursiv)", () => {
    expect([...en.keys()].sort()).toEqual([...de.keys()].sort());
  });

  it("gleiche Platzhaltermenge je Schlüssel", () => {
    for (const [k, v] of de) expect(placeholders(en.get(k) ?? ""), k).toEqual(placeholders(v));
  });

  it("kein leerer Text", () => {
    for (const [k, v] of [...de, ...en]) expect(v.trim().length, k).toBeGreaterThan(0);
  });

  it("Knopfnamen unverändert (Tour und E2E klicken darauf)", () => {
    setLang("de");
    expect(t("welcome.start")).toBe("Los geht's");
    expect(t("common.next")).toBe("Weiter");
    expect(t("options.install")).toBe("Installieren");
    expect(t("errors.retry")).toBe("Erneut versuchen");
    expect(t("uninstall.confirm")).toBe("Deinstallieren");
    expect(t("install.cancel")).toBe("Abbrechen");
    expect(t("common.close")).toBe("Schließen");
    expect(t("done.launch")).toBe("Pulsar jetzt starten");
    expect(t("maintenance.update")).toBe("Aktualisieren oder reparieren");
    expect(t("install.cancelConfirmBtn")).toBe("Installation abbrechen");
  });

  it("Titel: Signal steht / verloren / erfasst", () => {
    setLang("de");
    expect(t("done.title")).toBe("Signal steht.");
    expect(t("uninstall.doneTitle")).toBe("Signal verloren.");
    expect(t("intro.acquired")).toBe("Signal erfasst.");
    setLang("en");
    expect(t("done.title")).toBe("Signal locked.");
    expect(t("uninstall.doneTitle")).toBe("Signal lost.");
    expect(t("intro.acquired")).toBe("Signal acquired.");
  });

  it("Fertig-Text ohne Ping-Versprechen", () => {
    setLang("de");
    expect(t("done.installed", { v: "1.0.0" })).toBe("Pulsar 1.0.0 ist installiert. Viel Spaß beim Spielen.");
    setLang("en");
    expect(t("done.installed", { v: "1.0.0" })).toBe("Pulsar 1.0.0 is installed. Have fun playing.");
    for (const d of [dictionaries.de, dictionaries.en]) expect(d.done.installed).not.toMatch(/ping/i);
  });

  it("Fakten wörtlich: Entdeckung und Katalognamen", () => {
    expect(dictionaries.de.intro.object).toBe("PSR B1919+21 · CP 1919 · entdeckt 1967 von Jocelyn Bell Burnell und Antony Hewish");
    expect(dictionaries.en.intro.object).toBe("PSR B1919+21 · CP 1919 · discovered in 1967 by Jocelyn Bell Burnell and Antony Hewish");
    expect(dictionaries.de.obs.ref.b1919).toBe("Erster Pulsar (1967)");
    expect(dictionaries.en.obs.heard.buzz).toBe("Buzz");
  });

  it("dreistufige Schlüssel werden aufgelöst, Platzhalter ersetzt", () => {
    setLang("de");
    expect(t("obs.heard.rattle")).toBe("Knattern");
    expect(t("install.phaseStatus", { n: 2, total: 6, phase: "Herunterladen" })).toBe("Phase 2/6 · Herunterladen");
    expect(t("intro.timelapse", { n: 9 })).toBe("×9 Zeitraffer");
  });

  it("nur Glyphen aus dem Plex-Mono-latin-Subset in Mono-Texten (keine Pfeile, kein Σ, keine schmalen Leerzeichen)", () => {
    for (const [k, v] of [...de, ...en]) expect(v, k).not.toMatch(/[→←▲▼▸■□│⏎↵✓✕⚠Σ\u202f\u2009]/);
  });
});
