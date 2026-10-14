import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRelative } from "./format";
import { getLanguage, setLanguage } from "./i18n";

const DAY = 86_400_000;

describe("formatRelative (Einzahl/Mehrzahl)", () => {
  const before = getLanguage();
  afterEach(() => {
    setLanguage(before);
    vi.unstubAllGlobals();
  });
  const use = (lang: "de" | "en") => {
    // setLanguage setzt `document.documentElement.lang` – in Node gibt es kein document
    if (typeof document === "undefined") vi.stubGlobal("document", { documentElement: {} });
    setLanguage(lang);
  };

  it("8 Tage → „vor 1 Woche“ bzw. „1 week ago“", () => {
    use("de");
    expect(formatRelative(Date.now() - 8 * DAY)).toBe("vor 1 Woche");
    expect(formatRelative(Date.now() - 15 * DAY)).toBe("vor 2 Wochen");
    expect(formatRelative(Date.now() - 40 * DAY)).toBe("vor 1 Monat");
    use("en");
    expect(formatRelative(Date.now() - 8 * DAY)).toBe("1 week ago");
    expect(formatRelative(Date.now() - 15 * DAY)).toBe("2 weeks ago");
    expect(formatRelative(Date.now() - 400 * DAY)).toBe("1 year ago");
  });
});
