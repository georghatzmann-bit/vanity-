/**
 * Demo-Backend: „Warum laggt es?“ (`net_metered`). Vertrag: docs/API.md, „„Warum laggt es?““ › „Demo“.
 *
 * Die Prüfung selbst benutzt nur vorhandene Demo-Befehle; die Demo-Schalter (`__pulsarWifiPrimary`,
 * `__pulsarDiagnoseDemo`) wirken dort (lib/mock.ts, ./wifi.ts). Die Demo-Verbindung ist nie getaktet.
 */
import type { MockHandlers } from "./core";

export const diagnoseMock: MockHandlers = {
  net_metered: () => false,
};
