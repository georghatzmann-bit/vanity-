import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/sora";
import "./styles/app.css";
import { App } from "./App";

/** Fängt unerwartete Fehler ab, damit die App nie einfach weiß bleibt */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Pulsar Fehler:", error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    const de = navigator.language.toLowerCase().startsWith("de");
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center", background: "#04070f", color: "#e9f1ff", fontFamily: "Inter Variable, system-ui", padding: 32 }}>
        <div style={{ maxWidth: 520, textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 12, color: "#22d3ee" }}>◉</div>
          <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>{de ? "Hoppla – da ist etwas schiefgelaufen." : "Oops – something went wrong."}</h1>
          <p style={{ color: "#8da2c0", fontSize: 14, lineHeight: 1.6 }}>
            {de ? "Deine Daten sind sicher. Ein Neuladen behebt das meistens." : "Your data is safe. Reloading usually fixes this."}
          </p>
          <pre style={{ textAlign: "left", fontSize: 12, color: "#c6d4ea", background: "rgb(255 255 255 / 0.05)", padding: 12, borderRadius: 10, overflow: "auto", maxHeight: 160 }}>{String(this.state.error?.message)}</pre>
          <button type="button" onClick={() => location.reload()} style={{ marginTop: 16, height: 40, padding: "0 20px", borderRadius: 12, border: 0, background: "linear-gradient(120deg,#22d3ee,#60a5fa,#a78bfa)", color: "#021018", fontWeight: 600, cursor: "pointer" }}>
            {de ? "Neu laden" : "Reload"}
          </button>
        </div>
      </div>
    );
  }
}

window.addEventListener("unhandledrejection", (e) => {
  console.warn("Unbehandelter Fehler:", e.reason);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
