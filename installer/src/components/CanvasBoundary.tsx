/**
 * Fehlergrenze für Canvas-Bilder (H): bei Absturz oder fehlendem 2D-Kontext ein statisches
 * SVG-Zeichen mit Text statt eines leeren Fensters. Meldet per `console.warn`.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { PulsarMark } from "@shared/ui/PulsarMark";

export interface CanvasBoundaryProps {
  children: ReactNode;
  /** Größe des Ersatzbilds (Box), Standard 380 × 320 wie der Schirm-Canvas */
  width?: number;
  height?: number;
  /** Text unter dem Zeichen (z. B. „Schema · nicht maßstäblich“) */
  label?: string;
  /** eigener Ersatz statt Zeichen + Text */
  fallback?: ReactNode;
}

interface State {
  failed: boolean;
}

export class CanvasBoundary extends Component<CanvasBoundaryProps, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("[setup] Canvas ausgefallen, zeige statisches Bild:", error.message, info.componentStack ?? "");
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    const { width = 380, height = 320, label } = this.props;
    return (
      <div className="grid place-items-center" style={{ width, height }} data-testid="canvas-fallback">
        <div className="flex flex-col items-center gap-3">
          <PulsarMark size={Math.min(width, height) * 0.6} variant="rays" />
          {label && <span className="obs-label">{label}</span>}
        </div>
      </div>
    );
  }
}
