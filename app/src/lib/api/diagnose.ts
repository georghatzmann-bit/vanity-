/** „Warum laggt es?“ – nur der gemeinsame Befehl `net_metered`; der Ablauf nutzt vorhandene Befehle. */
import { call } from "../api";

export const diagnoseApi = {
  /** Getaktete Verbindung? (null = unbekannt) */
  metered: () => call<boolean | null>("net_metered"),
};
