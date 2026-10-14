/**
 * Gemeinsamer Rahmen (C.0): Titelleiste y 0–40, Statusleiste y 600–640, Haarlinien bei y 40,
 * y 600 und (außer im Intro) x 420. Kinder liegen in Fensterkoordinaten (0,0)–(980,640).
 * Taste M schaltet den Ton, außer der Fokus liegt in einem Eingabefeld.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { PulsarMark } from "@shared/ui/PulsarMark";
import { WindowControls } from "@shared/ui/WindowControls";
import type { Lang } from "../i18n";
import { LangSwitch } from "./LangSwitch";
import { SoundSwitch } from "./SoundSwitch";

export interface FrameStatus {
  /** Beschriftung links (fg-3), z. B. „Ziel“ */
  label?: string;
  /** Wert links (fg-2), z. B. die Koordinatenzeile */
  left: string;
  /** rechts, z. B. „Setup 1.0.0 · Wartung“ */
  right: string;
}

export interface FrameProps {
  lang: Lang;
  onLang(l: Lang): void;
  muted: boolean;
  onMute(m: boolean): void;
  onClose(): void;
  status: FrameStatus;
  /** Trennlinie Schirm | Bedienfeld bei x 420 (im Intro aus) */
  split?: boolean;
  reduced?: boolean;
  children: ReactNode;
}

function isTextField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(el.type);
}

export function Frame({ lang, onLang, muted, onMute, onClose, status, split = true, reduced = false, children }: FrameProps) {
  const muteRef = useRef({ muted, onMute });
  muteRef.current = { muted, onMute };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "m" && e.key !== "M") return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      if (isTextField(e.target) || isTextField(document.activeElement)) return;
      const { muted: m, onMute: set } = muteRef.current;
      set(!m);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="relative h-[640px] w-[980px] overflow-hidden bg-obs-bg text-obs-fg" data-reduced={reduced}>
      {/* Titelleiste */}
      <header data-tauri-drag-region className="absolute inset-x-0 top-0 z-30 h-10 bg-obs-bg">
        <PulsarMark size={18} variant="solid" className="pointer-events-none absolute top-[11px] left-4" />
        <span data-tauri-drag-region className="absolute top-3 left-[42px] text-[12px] leading-4 font-semibold tracking-[0.32em] text-obs-fg">
          PULSAR
        </span>
        <span data-tauri-drag-region className="obs-label absolute top-[13px] left-[140px]">
          Setup
        </span>
        <div className="absolute top-0 right-0 flex h-10 items-stretch">
          <LangSwitch lang={lang} onLang={onLang} />
          <SoundSwitch muted={muted} onMute={onMute} />
          <WindowControls maximizable={false} onClose={onClose} />
        </div>
      </header>

      {/* Inhalt in Fensterkoordinaten */}
      <div className="absolute inset-0 z-10">{children}</div>

      {/* Statusleiste */}
      <footer className="absolute inset-x-0 top-[601px] z-30 flex h-[39px] items-center justify-between bg-obs-bg pr-10 pl-6">
        <span className="obs-label min-w-0 truncate">
          {status.label && <span className="text-obs-fg-3">{status.label} </span>}
          <span className="text-obs-fg-2 normal-case" data-testid="status-left">
            {status.left}
          </span>
        </span>
        <span className="obs-label shrink-0 pl-4 text-obs-fg-3" data-testid="status-right">
          {status.right}
        </span>
      </footer>

      {/* Haarlinien (1 CSS-px, auf dem Pixelraster) */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-40">
        <div className="absolute inset-x-0 top-10 h-px bg-obs-rule" />
        <div className="absolute inset-x-0 top-[600px] h-px bg-obs-rule" />
        {split && <div className="absolute top-[41px] left-[420px] h-[559px] w-px bg-obs-rule" />}
      </div>
    </div>
  );
}
