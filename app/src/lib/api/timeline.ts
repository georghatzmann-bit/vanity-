/** Match-Zeitleiste. Vertrag: docs/API.md, „Match-Zeitleiste“. */
import { call } from "../api";
import type { SessionTimeline } from "../types";

export const timelineApi = {
  /** Messwerte und Ereignisse einer Spielsitzung (sonst „Für diese Sitzung gibt es keine Messwerte.“) */
  sessionTimeline: (sessionId: number) => call<SessionTimeline>("net_session_timeline", { sessionId }),
};
