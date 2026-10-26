/*
 * Rules and texts of the F9 menu that depend on the Fortnite version, for the launcher's copy of the
 * menu (In-game Menu page). The real rules live in the client DLL:
 *   - native/client/ATLAS/Public/EditFeatureRoutes.h  (Edit on release, Reset on release, pre-edits)
 *   - native/client/ATLAS/Public/QuickReset.h         (Reset builds)
 *   - native/client/ATLAS/Private/GUI.cpp             (the wording)
 * Keep them in sync.
 */
import { parseVersionNumber } from "./bubble";

/** Fortnite version as whole hundredths ("19.10" → 1910). 0 = unknown. */
export function versionHundredths(version: string | null | undefined): number {
  const v = parseVersionNumber(version ?? "");
  return v ? v[0] * 100 + v[1] : 0;
}

// ---- Editing: each switch uses exactly one route per version ----------------------------------

export type EditFeature = "editOnRelease" | "resetOnRelease" | "disablePreEdits";
/** hook = Niobium does it (old versions, the switch in client.json); native = Fortnite's own setting. */
export type EditRoute = "hook" | "native";

/** First version (hundredths) where Fortnite's own setting is used instead of Niobium's (EpicSettingSince). */
export const EPIC_SETTING_SINCE: Record<EditFeature, number> = {
  editOnRelease: 1100,
  resetOnRelease: 2430,
  disablePreEdits: 1520,
};

/** Same as PlannedRoute in EditFeatureRoutes.h. An unknown version keeps Niobium's own way. */
export function editRoute(feature: EditFeature, version: string | null | undefined): EditRoute {
  const v = versionHundredths(version);
  return v < EPIC_SETTING_SINCE[feature] ? "hook" : "native";
}

export const editText: Record<EditFeature, { label: string; hookHint: string }> = {
  editOnRelease: { label: "Edit on release", hookHint: "Your edit is confirmed as soon as you let go of the key." },
  resetOnRelease: { label: "Reset on release", hookHint: "Your reset is confirmed as soon as you let go of the key." },
  disablePreEdits: { label: "Disable pre-edits", hookHint: "You never edit the see-through preview piece by accident." },
};

/** The F9 hint on versions where the row uses Fortnite's own setting (GUI.cpp, Main > Editing). */
export function nativeEditHint(feature: EditFeature, version: string | null | undefined): string {
  const autoConfirmEdits = versionHundredths(version) >= EPIC_SETTING_SINCE.resetOnRelease;
  switch (feature) {
    case "editOnRelease":
      return autoConfirmEdits
        ? 'Uses Fortnite\'s own "Auto Confirm Edits" setting (Edit).'
        : 'Uses Fortnite\'s own setting on this version ("Confirm Edit on Release"). Changing it here changes it there too.';
    case "resetOnRelease":
      return 'Uses Fortnite\'s own "Auto Confirm Edits" setting (Reset). Edit and Reset both on = "Both".';
    case "disablePreEdits":
      return 'Uses Fortnite\'s own "Disable Pre-Edits" setting.';
  }
}

/** Name of Fortnite's own setting, for the launcher row ("Confirm Edit on Release"). */
export function epicSettingName(feature: EditFeature, version: string | null | undefined): string {
  const autoConfirmEdits = versionHundredths(version) >= EPIC_SETTING_SINCE.resetOnRelease;
  switch (feature) {
    case "editOnRelease":
      return autoConfirmEdits ? '"Auto Confirm Edits" (Edit)' : '"Confirm Edit on Release"';
    case "resetOnRelease":
      return '"Auto Confirm Edits" (Reset)';
    case "disablePreEdits":
      return '"Disable Pre-Edits"';
  }
}

/** Free camera is only offered up to 10.40 (GUI.cpp). Unknown version: shown, like the old menu. */
export function freeCameraAvailable(version: string | null | undefined): boolean {
  const v = versionHundredths(version);
  return v === 0 || v <= 1040;
}

// ---- Reset builds (F9 > Options) --------------------------------------------------------------

/** From this version on Fortnite has its own "Reset Building" key, so Niobium's is off (QuickReset.h). */
export const EPIC_RESET_BUILDING_SINCE = 3700;

export function epicOwnsResetBuilding(version: string | null | undefined): boolean {
  return versionHundredths(version) >= EPIC_RESET_BUILDING_SINCE;
}

/** Keys the console always uses (~, F8 and the / key): never the Reset builds key. */
const CONSOLE_KEYS = [0xc0, 0x77, 0xbf];
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;

export const resetBuildsText = {
  label: "Reset builds",
  hint: "Aim at one of your edited builds and press your Reset builds key. It goes back to normal without opening edit mode. Editing and resetting the normal way still works.",
  keyLabel: "Reset builds key",
  keyTip: "Tip: use the same key you use for Reset in Fortnite. Fortnite still gets the key, so pick one that does nothing else outside edit mode.",
  serverNote: "Works on Niobium servers.",
  epicOwns: "This Fortnite version has its own Reset Building key. Set it in Fortnite: Settings > Keyboard Controls.",
  mouseRefused: "The left and right mouse buttons can't be used here: they shoot and aim.",
  keyTaken: "That key is already used for something else.",
  statusNoKey: "Pick a key first.",
  statusCommandKey: "That key is also used by one of your commands. Pick another key.",
  statusOverlayKey: "That key is also your menu, join or console key. Pick another key.",
  statusNotInMatch: "Join a match to use it.",
} as const;

/** Why a key can't be the Reset builds key (null = it can). Same checks as the F9 menu. */
export function resetBuildsKeyProblem(
  vk: number,
  taken: { menuKey: number; joinKey: number; commandKeys: number[] },
): string | null {
  if (vk === VK_LBUTTON || vk === VK_RBUTTON) return resetBuildsText.mouseRefused;
  if (vk <= 0 || vk > 254) return resetBuildsText.keyTaken;
  if (vk === taken.menuKey || vk === taken.joinKey || CONSOLE_KEYS.includes(vk) || taken.commandKeys.includes(vk)) {
    return resetBuildsText.keyTaken;
  }
  return null;
}

/** The F9 status line under the switch while it is on (outside a match). */
export function resetBuildsStatus(
  key: number,
  taken: { menuKey: number; joinKey: number; commandKeys: number[] },
): { text: string; warn: boolean } {
  if (!key) return { text: resetBuildsText.statusNoKey, warn: true };
  if (taken.commandKeys.includes(key)) return { text: resetBuildsText.statusCommandKey, warn: true };
  if (key === taken.menuKey || key === taken.joinKey || CONSOLE_KEYS.includes(key)) return { text: resetBuildsText.statusOverlayKey, warn: true };
  return { text: resetBuildsText.statusNotInMatch, warn: false };
}

// ---- Bubble look (F9 > Main > Graphics) -------------------------------------------------------

export const bubbleLookText = {
  label: "Bubble look",
  hint: "Makes the see-through part of builds soft and bubbly by lowering the detail of the build blueprint textures. Only you see it. Works right away, no restart. Close to the old effect, not Epic's exact one.",
  strength: "Bubble strength",
  strengthHint: "Higher = softer bubbles.",
  waiting: "Bubble look: waiting for the build textures. Place one build piece.",
  paused: "Paused: Bubble Builds are already on. Bubble look would only blur them more.",
  tooBlurry: "Lower Bubble strength if builds look too blurry.",
} as const;

export const BUBBLE_STRENGTH = { min: 1, max: 8, default: 5 } as const;

export function bubbleStrengthOf(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return BUBBLE_STRENGTH.default;
  return Math.min(BUBBLE_STRENGTH.max, Math.max(BUBBLE_STRENGTH.min, Math.round(value)));
}
