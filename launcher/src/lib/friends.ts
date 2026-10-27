// Playing with friends: helpers shared by Servers & Friends, Home and Profiles.
// The rules (invite format, addresses, versions) live in Rust (launcher/core/src/friends.rs).
import { toast } from "sonner";
import { api, errorText, inTauri, type JoinCheck, type JoinStarted } from "./api";
import { playlists } from "./demo-data";

/** Team size of a playlist from its name: Squads 4, Trios 3, Duos 2, else 1 (same as Rust). */
export function teamSize(playlist: string): number {
  const p = playlist.toLowerCase();
  if (p.includes("squad")) return 4;
  if (p.includes("trio")) return 3;
  if (p.includes("duo")) return 2;
  return 1;
}

const labelOf = (id: string) => playlists.find((p) => p.id === id)?.label ?? "";
const idOfLabel = (label: string) => playlists.find((p) => p.label === label)?.id;

/** "Against each other" uses the Solo version of the mode: "Zero Build Squads" → "Zero Build Solo". */
export function soloVariant(playlist: string): string {
  if (teamSize(playlist) === 1) return playlist;
  return idOfLabel(labelOf(playlist).replace(/(Duos|Trios|Squads)$/, "Solo")) ?? "Playlist_DefaultSolo";
}

/** "Together" needs teams: "Arena Solo" → "Arena Duos"; anything else → Duos. */
export function teamVariant(playlist: string): string {
  if (teamSize(playlist) > 1) return playlist;
  return idOfLabel(labelOf(playlist).replace(/Solo$/, "Duos")) ?? "Playlist_DefaultDuo";
}

/** Copies the invite of the active profile (Home's "Invite friends" button). */
export async function copyInvite(): Promise<void> {
  try {
    const info = await api.inviteInfo();
    if (!info.text) {
      toast.error("No invite yet", { description: info.problem ?? "Open Servers & Friends for details." });
      return;
    }
    await navigator.clipboard.writeText(info.text);
    toast.success("Invite copied", { description: `${info.summary} · send it to your friend.` });
  } catch (e) {
    toast.error("Couldn't copy the invite", { description: errorText(e) });
  }
}

/** Joins after the check (or "Join anyway"); the toast says what happens next. */
export async function joinAfterCheck(check: JoinCheck): Promise<boolean> {
  if (!inTauri) {
    toast.success("Joining (preview)", { description: `${check.ip}:${check.port}` });
    return true;
  }
  try {
    const started: JoinStarted = await api.joinGame(check.ip, check.port, check.buildId);
    if (started === "pressPlay") {
      toast.success("Ready to join", { description: "Press Play in the game – you'll land in your friend's match." });
    } else {
      toast.success("Your game is starting", { description: "When the lobby shows, press Play – you'll land in your friend's match." });
    }
    return true;
  } catch (e) {
    toast.error("Couldn't join", { description: errorText(e) });
    return false;
  }
}
