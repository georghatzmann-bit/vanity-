import type { Dict } from "./de";

/** English texts of the „history“ namespace (Measurement history) – plugged into `en.ts`. */
export const historyEn: Dict["history"] = {
  title: "Measurement history",
  record: "Keep measurement history",
  recordDesc: "For the calendar, match timeline, spikes and ISP log. Off: nothing is stored any more, the live view keeps running.",
  stored: "Stored locally: ping statistics per hour (400 days), events (up to 365 days), raw data of the last 50 rounds (90 days). Nothing leaves your PC.",
  clear: "Delete measurement history",
  clearDesc: "Deletes the hourly statistics, events and raw round data. Your reports stay.",
  clearButton: "Delete",
  clearConfirmTitle: "Delete measurement history?",
  clearConfirm: "The calendar, timelines, spikes and ISP log will start from scratch. Older database backups still contain the history until they are replaced (after 10 more backups at the latest).",
  cleared: "Measurement history deleted",
  clearedCount: "{n} entries removed",
  clearFailed: "Could not delete the measurement history",
};
