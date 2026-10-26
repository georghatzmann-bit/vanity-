import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRight,
  Gamepad2,
  Keyboard,
  ListChecks,
  LogIn,
  MonitorCog,
  PanelsTopLeft,
  PencilRuler,
  Plus,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { EmptyState, Kbd, PageHeader, PageShell, Panel, Reveal, SettingRow, ValueChip } from "@/components/common";
import { LogoMark } from "@/components/layout/Logo";
import { pageGroup, pageLabel } from "@/components/layout/nav";
import { useBubbleSupport } from "@/hooks/use-bubble-support";
import { useCalmMotion } from "@/hooks/use-calm-motion";
import { api, inTauri, type ClientPreferences, type ClientSettings } from "@/lib/api";
import { bubbleText, isExperimentalLevel, needsLowMeshes, unavailableHint, type BubbleBuildsInfo } from "@/lib/bubble";
import {
  BUBBLE_STRENGTH,
  bubbleLookText,
  bubbleStrengthOf,
  editRoute,
  editText,
  epicOwnsResetBuilding,
  epicSettingName,
  freeCameraAvailable,
  nativeEditHint,
  resetBuildsKeyProblem,
  resetBuildsStatus,
  resetBuildsText,
  type EditFeature,
} from "@/lib/f9";
import { EASE_OUT, SPRING_UI } from "@/lib/motion";
import { levelWord, parkours } from "@/lib/parkours";
import { activeProfile, buildOf, keyName, useApp, vkFromEvent } from "@/lib/store";
import { cn } from "@/lib/utils";

const JOIN_IP_KEY = "niobium.joinIp";

/** Which tab of the F9 preview shows a setting, and the id of its row there. */
type Spot = { tab: F9Tab; id: string };
/** "Always sprint" (sprintByDefault) was removed, so it has no row anywhere. */
const prefSpot: Record<Exclude<keyof ClientPreferences, "sprintByDefault">, Spot> = {
  editOnRelease: { tab: 0, id: "eor" },
  resetOnRelease: { tab: 0, id: "ror" },
  disablePreEdits: { tab: 0, id: "pre" },
  mobileBuilds: { tab: 0, id: "mobile" },
  inGameFog: { tab: 0, id: "fog" },
  respawnsEnabled: { tab: 0, id: "respawn" },
  firstPerson: { tab: 0, id: "fp" },
  slashKey: { tab: 2, id: "slash" },
  saveTogglePreferences: { tab: 2, id: "remember" },
  bubbleLook: { tab: 0, id: "bubblelook" },
  bubbleStrength: { tab: 0, id: "bubblelook" },
  resetBuilds: { tab: 2, id: "resetbuilds" },
  resetBuildsKey: { tab: 2, id: "resetkey" },
};

/** The three Editing switches, in menu order, and their row ids in the F9 preview. */
const EDIT_FEATURES: { feature: EditFeature; spot: string }[] = [
  { feature: "editOnRelease", spot: "eor" },
  { feature: "resetOnRelease", spot: "ror" },
  { feature: "disablePreEdits", spot: "pre" },
];

/** Keys Niobium already uses (menu, join, saved commands) – the Reset builds key must differ. */
function takenKeys(s: ClientSettings) {
  return { menuKey: s.hotkey, joinKey: s.joinHotkey, commandKeys: savedCommands(s).map((e) => e.vk).filter((vk) => vk > 0) };
}

/** Fortnite version of the active profile's build (for the Bubble Builds status). */
function useActiveVersion(): string {
  const config = useApp((st) => st.config);
  return buildOf(config, activeProfile(config)?.buildId)?.version ?? "";
}

export function IngameMenuPage() {
  const s = useApp((st) => st.clientSettings);
  const save = useApp((st) => st.saveClientSettings);
  const presets = useApp((st) => st.config.trickshotPresets);
  const savePresets = useApp((st) => st.saveTrickshotPresets);
  const bubbleOn = useApp((st) => st.config.settings.bubbleBuilds);
  const setPage = useApp((st) => st.setPage);
  const version = useActiveVersion();
  const bubble = useBubbleSupport(version || null);

  const [joinIp, setJoinIp] = useState(() => {
    try {
      return localStorage.getItem(JOIN_IP_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [presetName, setPresetName] = useState("");
  const [presetCmds, setPresetCmds] = useState("");
  /** Last changed setting: the preview jumps to it and lights it up. */
  const [flash, setFlash] = useState<Flash | null>(null);
  const point = (spot: Spot) => setFlash((f) => ({ ...spot, n: (f?.n ?? 0) + 1 }));

  const pref = (patch: Partial<ClientPreferences>) => {
    save({ preferences: { ...s.preferences, ...patch } });
    const key = Object.keys(patch)[0] as keyof typeof prefSpot | undefined;
    const spot = key ? prefSpot[key] : undefined;
    if (spot) point(spot);
  };

  const rememberIp = (ip: string) => {
    setJoinIp(ip);
    try {
      localStorage.setItem(JOIN_IP_KEY, ip);
    } catch {
      /* preview without storage */
    }
  };

  const join = async (target: string) => {
    if (!inTauri) return toast("Join (preview)", { description: target });
    try {
      await api.joinIp(target);
    } catch (e) {
      toast.error("Couldn't join", { description: String(e) });
    }
  };

  const addPreset = () => {
    const commands = presetCmds.split(/\r?\n|;/).map((c) => c.trim()).filter(Boolean);
    if (!presetName.trim() || commands.length === 0) return;
    savePresets([...presets, { name: presetName.trim(), commands }]);
    setPresetName("");
    setPresetCmds("");
    toast.success("Preset saved", { description: "Run it on Match Control → Trickshot → Your presets." });
  };

  const removePreset = (i: number) => savePresets(presets.filter((_, idx) => idx !== i));

  // Stable keys, so the right row slides out when one in the middle is deleted
  const presetKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return presets.map((p) => {
      const base = `${p.name}\u0000${p.commands.join(";")}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return `${base}\u0000${n}`;
    });
  }, [presets]);

  const menuKey = keyName(s.hotkey);
  const bubbleChip = bubbleChipFor(bubble, bubbleOn, version);
  const p = s.preferences;
  const taken = takenKeys(s);
  const resetKey = p.resetBuildsKey ?? 0;
  const epicResets = epicOwnsResetBuilding(version);
  // Bubble look pauses in the game while Epic's own bubbles are on (Performance Mode, Meshes Low)
  const bubbleLookPaused = bubbleOn && needsLowMeshes(bubble?.level);
  const [strengthDraft, setStrengthDraft] = useState<number | null>(null);
  const strength = strengthDraft ?? bubbleStrengthOf(p.bubbleStrength);

  /** Menu and join key: never the Reset builds key while that is on (like the F9 menu). */
  const keyFree = (vk: number) => {
    if (p.resetBuilds && resetKey && vk === resetKey) {
      toast.error(resetBuildsText.keyTaken);
      return false;
    }
    return true;
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow={pageGroup("ingame")}
        title={pageLabel("ingame")}
        icon={PanelsTopLeft}
        description={
          <>
            Press <Kbd className="mx-0.5 align-[1px]">{menuKey}</Kbd> in the game to open it. The launcher and the menu share one settings file:
            changes here apply on your next game start, and you can change everything in the game, too.
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex min-w-0 flex-col gap-6">
          {/* Same names as in the F9 menu ("Main" tab), so you find the same words there */}
          <Panel title="Editing" icon={PencilRuler} description="Faster edits, like in Arena.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              {EDIT_FEATURES.map(({ feature }) =>
                editRoute(feature, version) === "hook" ? (
                  <SettingRow key={feature} label={editText[feature].label} hint={editText[feature].hookHint}>
                    <Switch checked={p[feature]} onCheckedChange={(v) => pref({ [feature]: v })} />
                  </SettingRow>
                ) : (
                  <SettingRow
                    key={feature}
                    label={editText[feature].label}
                    hint={
                      <>
                        On {version}, this is Fortnite's own setting {epicSettingName(feature, version)}. Change it in the game ({menuKey} → Main) or in
                        Fortnite's settings.
                      </>
                    }
                  >
                    <ValueChip className="font-sans">In game</ValueChip>
                  </SettingRow>
                ),
              )}
              {epicResets ? (
                <SettingRow label={resetBuildsText.label} hint={resetBuildsText.epicOwns}>
                  <ValueChip className="font-sans">In Fortnite</ValueChip>
                </SettingRow>
              ) : (
                <>
                  <SettingRow
                    label={resetBuildsText.label}
                    badge={<Badge variant="gold">New</Badge>}
                    hint={
                      <>
                        {resetBuildsText.hint} <span className="text-faint">{resetBuildsText.serverNote}</span>
                      </>
                    }
                  >
                    <Switch checked={p.resetBuilds ?? false} onCheckedChange={(v) => pref({ resetBuilds: v })} />
                  </SettingRow>
                  <SettingRow label={resetBuildsText.keyLabel} hint={resetBuildsText.keyTip}>
                    <VkCapture
                      value={resetKey}
                      emptyLabel="None"
                      onChange={(vk) => {
                        const problem = resetBuildsKeyProblem(vk, taken);
                        if (problem) return void toast.error(problem);
                        pref({ resetBuildsKey: vk });
                      }}
                    />
                  </SettingRow>
                </>
              )}
            </div>
          </Panel>

          <Panel title="Graphics" icon={MonitorCog} description="How builds and the world look in the game.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Mobile Builds" hint="Draws builds and the world with less detail, like on phones. Works on every version, right away.">
                <Switch checked={s.preferences.mobileBuilds} onCheckedChange={(v) => pref({ mobileBuilds: v })} />
              </SettingRow>
              <SettingRow
                label={bubbleLookText.label}
                badge={<Badge variant="gold">New</Badge>}
                hint={
                  <>
                    {bubbleLookText.hint}
                    {bubbleLookPaused && <span className="text-faint"> It pauses while Bubble Builds are on.</span>}
                  </>
                }
              >
                <Switch checked={p.bubbleLook ?? false} onCheckedChange={(v) => pref({ bubbleLook: v })} />
              </SettingRow>
              {p.bubbleLook && (
                <SettingRow label={bubbleLookText.strength} hint={bubbleLookText.strengthHint}>
                  <Slider
                    className="w-36"
                    min={BUBBLE_STRENGTH.min}
                    max={BUBBLE_STRENGTH.max}
                    step={1}
                    value={[strength]}
                    aria-label={bubbleLookText.strength}
                    onValueChange={([v]) => setStrengthDraft(v)}
                    onValueCommit={([v]) => {
                      setStrengthDraft(null);
                      pref({ bubbleStrength: v });
                    }}
                  />
                  <ValueChip className="min-w-9">{strength}</ValueChip>
                </SettingRow>
              )}
              <SettingRow label="In-game fog" hint="Off = clearer view into the distance.">
                <Switch checked={s.preferences.inGameFog} onCheckedChange={(v) => pref({ inGameFog: v })} />
              </SettingRow>
              <SettingRow
                label={bubbleText.label}
                badge={isExperimentalLevel(bubble?.level) ? <Badge variant="warning">{bubbleText.experimentalBadge}</Badge> : undefined}
                hint={
                  <>
                    {bubble?.note ?? unavailableHint(version)}{" "}
                    {bubble && bubble.level !== "unavailable" && <span className="text-faint">You switch it in Settings.</span>}
                  </>
                }
              >
                <Badge variant={bubbleChip.variant} className="tabular-nums">
                  {bubbleChip.label}
                </Badge>
                {bubble && bubble.level !== "unavailable" && (
                  <Button variant="ghost" size="icon-sm" onClick={() => setPage("settings")} aria-label="Change Bubble Builds in Settings" title="Change it in Settings">
                    <ArrowRight />
                  </Button>
                )}
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Game" icon={Gamepad2} description="Comfort switches the menu sets when the game starts.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Respawn after you die" hint="You drop back in from the sky – great for practice.">
                <Switch checked={s.preferences.respawnsEnabled} onCheckedChange={(v) => pref({ respawnsEnabled: v })} />
              </SettingRow>
              <SettingRow label="First person" hint="You see through your character's eyes.">
                <Switch checked={s.preferences.firstPerson} onCheckedChange={(v) => pref({ firstPerson: v })} />
              </SettingRow>
              <SettingRow
                label="Field of view (normal: 80)"
                hint={
                  <>
                    In the game: {menuKey} → Main → Field of view, or type <span className="font-mono text-foreground/80">fov 110</span> in the console.
                  </>
                }
              >
                <ValueChip className="font-sans">In game</ValueChip>
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Keys" icon={Keyboard} description="Click a key, then press the new one. Esc cancels.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Open menu" hint="Opens and closes the in-game menu.">
                <VkCapture
                  value={s.hotkey}
                  onChange={(vk) => {
                    if (!keyFree(vk)) return;
                    save({ hotkey: vk });
                    point({ tab: 2, id: "menukey" });
                  }}
                />
              </SettingRow>
              <SettingRow label="Join key" hint="When the menu is closed, this joins the server picked in “Main”.">
                <VkCapture
                  value={s.joinHotkey}
                  onChange={(vk) => {
                    if (!keyFree(vk)) return;
                    save({ joinHotkey: vk });
                    point({ tab: 2, id: "joinkey" });
                  }}
                />
              </SettingRow>
              <SettingRow label="Console" hint="Always F8 – it opens the console.">
                <Kbd className="h-9 min-w-24 rounded-lg text-xs">F8</Kbd>
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Console" icon={SquareTerminal} description="Type commands for your own server in the game, e.g. “/god”.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Which console?" hint="Niobium: knows shortcuts like /god. Original: the normal Unreal console.">
                <Segmented
                  id="console-mode"
                  options={["Niobium", "Original"]}
                  value={s.consoleMode}
                  onChange={(i) => {
                    save({ consoleMode: i });
                    point({ tab: 2, id: "console" });
                  }}
                />
              </SettingRow>
              <SettingRow
                label="Open the console with the # key"
                hint="The # key (/ on US keyboards) opens the console with / already typed – then just type god. Only with the Niobium console."
              >
                <Switch checked={s.preferences.slashKey} onCheckedChange={(v) => pref({ slashKey: v })} />
              </SettingRow>
              <SettingRow label="Remember my settings" hint="Off = every toggle is back to normal the next time you start the game.">
                <Switch checked={s.preferences.saveTogglePreferences} onCheckedChange={(v) => pref({ saveTogglePreferences: v })} />
              </SettingRow>
            </div>
          </Panel>

          <Panel title="Join a server" icon={LogIn} description="Pick a server here, then press Play in the game.">
            <div className="flex flex-col divide-y divide-white/[0.05]">
              <SettingRow label="Server on this PC" hint="Your own server (127.0.0.1).">
                <Button variant="secondary" size="sm" onClick={() => join("127.0.0.1")}>
                  <LogIn />
                  Join
                </Button>
              </SettingRow>
              <SettingRow label="Server at this IP" hint="IP of the other PC, e.g. over Tailscale.">
                <Input
                  value={joinIp}
                  onChange={(e) => rememberIp(e.target.value)}
                  placeholder="100.101.12.7"
                  aria-label="IP address of the other PC"
                  className="h-8 w-40 font-mono text-xs"
                />
                <Button variant="secondary" size="sm" disabled={!joinIp} onClick={() => join(joinIp)}>
                  Join
                </Button>
              </SettingRow>
            </div>
          </Panel>

          <Panel
            title="Trickshot presets"
            icon={ListChecks}
            description="A list of server commands. One click on Match Control → Trickshot → Your presets sends them all to your server, one after another (you need to be in a match)."
            actions={
              <Button variant="ghost" size="sm" onClick={() => setPage("match")}>
                Match Control
                <ArrowRight />
              </Button>
            }
          >
            <div className="flex flex-col gap-3">
              {presets.length === 0 ? (
                <EmptyState icon={ListChecks} title="No presets yet" hint="Give it a name, add a few commands below and click Save." className="py-7" />
              ) : (
                <ul className="flex flex-col gap-2">
                  <AnimatePresence initial={false}>
                    {presets.map((p, i) => (
                      <motion.li
                        key={presetKeys[i]}
                        layout
                        initial={{ opacity: 0, y: -6, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, x: -12, transition: { duration: 0.16 } }}
                        transition={{ duration: 0.28, ease: EASE_OUT }}
                        className="group surface-subtle flex items-center gap-3 rounded-lg px-4 py-2.5 transition-colors hover:bg-white/[0.045]"
                      >
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-brand-violet/15 font-mono text-[11px] font-semibold text-violet-text tabular-nums ring-1 ring-brand-violet/25">
                          {p.commands.length}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{p.name}</p>
                          <p className="truncate font-mono text-xs text-muted-foreground">{p.commands.join(" ; ")}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete preset “${p.name}”`}
                          onClick={() => removePreset(i)}
                          className="text-muted-foreground opacity-60 group-hover:opacity-100 hover:text-destructive"
                        >
                          <Trash2 />
                        </Button>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              )}
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
                <Input
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="Name, e.g. Launch up"
                  aria-label="Preset name"
                  className="h-9 sm:col-span-2 2xl:col-span-1"
                />
                <Input
                  value={presetCmds}
                  onChange={(e) => setPresetCmds(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addPreset();
                  }}
                  placeholder="Commands with ; between, e.g. l 2500; giveammo"
                  aria-label="Commands of the preset"
                  className="h-9 font-mono text-xs"
                />
                <Button size="sm" className="h-9" onClick={addPreset} disabled={!presetName.trim() || !presetCmds.trim()}>
                  <Plus />
                  Save
                </Button>
              </div>
              {/* Only commands the Niobium server really knows (the same as the buttons on the Match Control page) */}
              <p className="text-xs leading-relaxed text-muted-foreground">
                Examples: <Cmd>l 2500</Cmd> = launch up · <Cmd>giveammo</Cmd> = ammo · <Cmd>regen</Cmd> = full health · <Cmd>givetraps</Cmd> = launch pads and
                other traps · <Cmd>god</Cmd> = invincible on/off
              </p>
            </div>
          </Panel>
        </div>

        <Reveal kind="scale" className="min-w-0 lg:sticky lg:top-6 lg:self-start">
          <OverlayPreview s={s} flash={flash} bubble={bubble} bubbleOn={bubbleOn} version={version} />
        </Reveal>
      </div>
    </PageShell>
  );
}

function Cmd({ children }: { children: ReactNode }) {
  return <span className="rounded bg-white/[0.06] px-1 py-px font-mono text-[11px] text-foreground/85">{children}</span>;
}

/** Status chip for the Bubble Builds row: what the next launch will do. */
function bubbleChipFor(
  info: BubbleBuildsInfo | null,
  on: boolean,
  version: string,
): { label: string; variant: "success" | "muted" | "secondary" } {
  if (!info || info.level === "unavailable") return { label: version ? `Not on ${version}` : "No build", variant: "muted" };
  return on ? { label: "On", variant: "success" } : { label: "Off", variant: "secondary" };
}

/** Two or more choices in a pill; the highlight springs to the chosen one. */
function Segmented({ id, options, value, onChange }: { id: string; options: string[]; value: number; onChange: (i: number) => void }) {
  return (
    <div role="radiogroup" className="relative flex rounded-lg bg-black/25 p-0.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
      {options.map((label, i) => {
        const active = value === i;
        return (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(i)}
            className={cn(
              "focus-ring relative rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors duration-150",
              active ? "text-white" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId={`${id}-pill`}
                transition={SPRING_UI}
                className="absolute inset-0 rounded-md bg-brand shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_4px_14px_-4px_rgb(122_60_255/0.7)]"
              />
            )}
            <span className="relative">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Button that waits for the next key and saves it as a Windows key code. */
function VkCapture({ value, onChange, emptyLabel }: { value: number; onChange: (vk: number) => void; emptyLabel?: string }) {
  const label = value ? keyName(value) : (emptyLabel ?? keyName(value));
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== "Escape") {
        const vk = vkFromEvent(e);
        if (vk) onChange(vk);
        else toast.error("This key can't be used");
      }
      setListening(false);
    };
    window.addEventListener("keydown", onKey, { capture: true, once: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [listening, onChange]);
  return (
    <button
      type="button"
      onClick={() => setListening(true)}
      aria-label={listening ? "Waiting for a key – press it now, Esc cancels" : `Change key, now ${label}`}
      className={cn(
        "relative h-9 min-w-24 overflow-hidden rounded-lg px-3 font-mono text-xs font-semibold transition-[background-color,box-shadow,color] duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        listening
          ? "bg-brand-violet/20 text-violet-text shadow-[inset_0_0_0_1px_rgb(122_60_255/0.6),0_0_18px_-4px_rgb(122_60_255/0.7)]"
          : "bg-[linear-gradient(180deg,rgb(255_255_255/0.09),rgb(255_255_255/0.035))] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1),inset_0_-2px_0_rgb(0_0_0/0.35)] hover:bg-white/[0.1]",
      )}
    >
      {listening && <span aria-hidden className="nb-loop absolute inset-0 animate-pulse bg-brand-violet/10" />}
      <span className="relative">{listening ? "Press a key…" : label}</span>
    </button>
  );
}

/* -------------------------------------------------------------------------------------------
 * F9 menu preview
 * A copy of the real menu over a hinted game scene. Layout and texts as in
 * native/client/ATLAS/Private/GUI.cpp and NiobiumTrickshotTab.cpp: title bar on top, tabs
 * Main / Commands / Options / Trickshot / Credits on the left, content with grey hints on the right.
 * ----------------------------------------------------------------------------------------- */
const F9_TABS = ["Main", "Commands", "Options", "Trickshot", "Credits"] as const;
type F9Tab = 0 | 1 | 2 | 3 | 4;

interface Flash extends Spot {
  n: number;
}
const FlashContext = createContext<Flash | null>(null);

interface SavedEntry {
  text: string;
  vk: number;
}

/** Saved commands from client.json (written by the F9 DLL): command or macro name, plus its key. */
function savedCommands(s: ClientSettings): SavedEntry[] {
  const entry = (item: unknown, key: "command" | "name"): SavedEntry | null => {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const text = record[key];
    if (typeof text !== "string" || !text.trim()) return null;
    const vk = typeof record.vk === "number" && record.vk > 0 && record.vk <= 254 ? record.vk : 0;
    return { text: text.trim(), vk };
  };
  const commands = Array.isArray(s.commands) ? s.commands.map((c) => entry(c, "command")) : [];
  const macros = Array.isArray(s.macros) ? s.macros.map((m) => entry(m, "name")) : [];
  return [...commands, ...macros].filter((e): e is SavedEntry => e !== null);
}

function OverlayPreview({
  s,
  flash,
  bubble,
  bubbleOn,
  version,
}: {
  s: ClientSettings;
  flash: Flash | null;
  bubble: BubbleBuildsInfo | null;
  bubbleOn: boolean;
  version: string;
}) {
  const [tab, setTab] = useState<F9Tab>(0);
  const calm = useCalmMotion();
  const saved = savedCommands(s);

  // A setting changed on the left: show the tab where it lives
  useEffect(() => {
    if (flash) setTab(flash.tab);
  }, [flash]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="relative flex size-2">
            <span className="nb-loop absolute inline-flex size-full animate-ping rounded-full bg-brand-violet opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-violet-text shadow-[0_0_8px_rgb(122_60_255/0.8)]" />
          </span>
          <p className="text-[15px] font-semibold">Live preview</p>
        </div>
        <p className="text-[11px] text-faint">Click the tabs</p>
      </div>

      <div className="relative overflow-hidden rounded-xl p-4 xl:p-5 shadow-[0_24px_60px_-28px_rgb(0_0_0/0.9)] ring-1 ring-white/[0.07]">
        {/* Hinted game scene: sky, two hills, a house – then darkened like behind the real menu */}
        <div aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,#1d3157_0%,#2f4c7c_42%,#46679a_62%)]" />
        <div aria-hidden className="absolute top-[30%] right-[7%] h-[16%] w-[18%]">
          <div className="absolute inset-x-[-14%] top-0 h-1/2 bg-[#5a2b23] [clip-path:polygon(50%_0,100%_100%,0_100%)]" />
          <div className="absolute inset-x-0 top-1/2 bottom-0 bg-[#7a5236]" />
        </div>
        <div aria-hidden className="absolute top-[46%] -left-[30%] h-[90%] w-[110%] rounded-[50%] bg-[#2f5a2b]" />
        <div aria-hidden className="absolute top-[58%] -right-[35%] h-[90%] w-[120%] rounded-[50%] bg-[#264b23]" />
        <div aria-hidden className="absolute inset-0 bg-[#0a0b12]/50" />
        <div
          aria-hidden
          className="absolute top-1/2 left-1/2 size-[130%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(122_60_255/0.28),rgb(43_91_255/0.1)_55%,transparent)]"
        />

        <motion.div
          initial={calm ? false : { opacity: 0, y: 14, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, ease: EASE_OUT, delay: 0.15 }}
          className="relative overflow-hidden rounded-lg bg-[#11131c]/[0.97] shadow-[0_30px_70px_-24px_rgb(0_0_0/0.95),0_0_0_1px_rgb(122_60_255/0.18)] ring-1 ring-white/[0.06]"
        >
          {/* Title bar: logo, "Niobium | Menu", menu key, close */}
          <div className="flex items-center gap-2 border-b border-[#232a3e] bg-[#0a0b12] px-3 py-2">
            <LogoMark size={20} variant="simple" />
            <p className="text-[11px]">
              <span className="font-semibold text-violet-text">Niobium</span> <span className="text-muted-foreground">| Menu</span>
            </p>
            <F9Spot id="menukey" className="ml-auto">
              <span className="font-mono text-[10px] text-faint">[{keyName(s.hotkey)}]</span>
            </F9Spot>
            <X className="size-3.5 text-muted-foreground" aria-hidden />
          </div>

          <div className="grid h-[33rem] grid-cols-[5rem_minmax(0,1fr)] xl:grid-cols-[5.5rem_minmax(0,1fr)]">
            {/* Sidebar with the tabs */}
            <div role="tablist" aria-label="F9 menu tabs" className="flex flex-col border-r border-[#232a3e] bg-[#0d0f17] py-2">
              {F9_TABS.map((label, i) => {
                const active = tab === i;
                return (
                  <button
                    key={label}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTab(i as F9Tab)}
                    className={cn(
                      "relative px-3 py-2.5 text-left text-[11px] transition-colors outline-none focus-visible:bg-white/[0.06]",
                      active ? "text-violet-text" : "text-muted-foreground hover:bg-white/[0.03] hover:text-foreground",
                    )}
                  >
                    {active && (
                      <motion.span layoutId="f9-tab-active" transition={SPRING_UI} className="absolute inset-0 bg-brand-violet/[0.13]">
                        <span className="absolute top-1/2 left-0 h-[60%] w-[2px] -translate-y-1/2 rounded-full bg-brand-violet shadow-[0_0_8px_rgb(122_60_255/0.9)]" />
                      </motion.span>
                    )}
                    <span className="relative">{label}</span>
                  </button>
                );
              })}
            </div>

            <div data-f9-scroll className="relative min-w-0 overflow-y-auto overscroll-contain">
              <FlashContext.Provider value={flash}>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={tab}
                    role="tabpanel"
                    initial={calm ? { opacity: 0 } : { opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, transition: { duration: 0.08 } }}
                    transition={{ duration: 0.22, ease: EASE_OUT }}
                    className="flex min-w-0 flex-col gap-2 p-3 pr-3.5"
                  >
                    {tab === 0 && <MainTab s={s} version={version} bubble={bubble} bubbleOn={bubbleOn} />}
                    {tab === 1 && <CommandsTab saved={saved} />}
                    {tab === 2 && <OptionsTab s={s} bubble={bubble} bubbleOn={bubbleOn} version={version} />}
                    {tab === 3 && <TrickshotTab />}
                    {tab === 4 && <CreditsTab />}
                  </motion.div>
                </AnimatePresence>
              </FlashContext.Provider>
            </div>
          </div>
          {/* resize grip, like in the real window */}
          <span aria-hidden className="absolute right-0 bottom-0 size-2.5 bg-brand-violet/70 [clip-path:polygon(100%_0,100%_100%,0_100%)]" />
        </motion.div>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-faint">
        A copy of the {keyName(s.hotkey)} menu for {version ? `Fortnite ${version}` : "your build"}, not a picture from the game. It shows your current
        settings.
        {EDIT_FEATURES.some(({ feature }) => editRoute(feature, version) === "native") && " A dash means Fortnite's own setting decides on this version."}
      </p>
    </div>
  );
}

function MainTab({
  s,
  version,
  bubble,
  bubbleOn,
}: {
  s: ClientSettings;
  version: string;
  bubble: BubbleBuildsInfo | null;
  bubbleOn: boolean;
}) {
  const p = s.preferences;
  const strength = bubbleStrengthOf(p.bubbleStrength);
  // Same states as DrawBubbleLookControls in GUI.cpp. The launcher can't see the game, so it shows
  // what you see first: paused when Epic's own bubbles are on, otherwise waiting for the textures.
  const paused = bubbleOn && needsLowMeshes(bubble?.level);
  return (
    <>
      <F9Section label="Join a server" />
      <F9Body>
        <F9Combo label="Where is the server running?" value="On this PC" />
        <F9Buttons labels={["Join the server on this PC"]} />
        <F9Hint text={`Tip: when the menu is closed, press ${keyName(s.joinHotkey)} to join right away.`} />
      </F9Body>
      <F9Section label="Editing" />
      <F9Body>
        {/* One route per version (EditFeatureRoutes.h): Niobium's switch, or Fortnite's own setting */}
        {EDIT_FEATURES.map(({ feature, spot }) =>
          editRoute(feature, version) === "hook" ? (
            <F9Check key={feature} id={spot} label={editText[feature].label} on={p[feature]} hint={editText[feature].hookHint} />
          ) : (
            <F9Check key={feature} id={spot} label={editText[feature].label} on={false} fromGame hint={nativeEditHint(feature, version)} />
          ),
        )}
      </F9Body>
      <F9Section label="Graphics" />
      <F9Body>
        <F9Check
          id="mobile"
          label="Mobile Builds"
          on={p.mobileBuilds}
          hint="Draws builds and the world with less detail, like on phones. Works on every version, right away."
        />
        <F9Check id="bubblelook" label={bubbleLookText.label} on={p.bubbleLook ?? false} hint={bubbleLookText.hint} />
        {p.bubbleLook && (
          <div className="flex flex-col gap-1.5 pl-[22px]">
            {paused ? (
              <F9Status text={bubbleLookText.paused} />
            ) : (
              <>
                <F9Status text={bubbleLookText.waiting} />
                <F9Slider label={bubbleLookText.strength} value={String(strength)} fill={(strength - BUBBLE_STRENGTH.min) / (BUBBLE_STRENGTH.max - BUBBLE_STRENGTH.min)} />
                <F9Hint text={bubbleLookText.strengthHint} />
                {bubbleOn && bubble?.level === "experimental" && <F9Hint text={bubbleLookText.tooBlurry} />}
              </>
            )}
          </div>
        )}
        <F9Check id="fog" label="In-game fog" on={p.inGameFog} hint="Off = clearer view into the distance." />
        <F9Slider label="Simpler textures" value="0" fill={0} />
        <F9Hint text="0 = normal. Higher = blurrier, but often runs smoother." />
      </F9Body>
      <F9Section label="Field of view" />
      <F9Body>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
          <F9Slider label="Degrees (normal: 80)" value="80" fill={0.45} />
          <F9Button label="Back to 80" />
        </div>
        <F9Hint text="Higher = you see more at the edges." />
      </F9Body>
      <F9Section label="Respawn" />
      <F9Body>
        <F9Check
          id="respawn"
          label="Respawn after you die"
          on={p.respawnsEnabled}
          hint="You drop back in from the sky after you die. Applies from your next game start."
        />
      </F9Body>
      <F9Section label="Other" />
      <F9Body>
        <F9Check id="fp" label="First person" on={p.firstPerson} hint="You see through your character's eyes." />
        {freeCameraAvailable(version) && (
          <F9Check id="freecam" label="Free camera" on={false} hint="The camera flies around freely while your character stays put." />
        )}
        <F9Check id="targetinfo" label="Target info" on={false} hint="Shows info about whatever you are aiming at." />
      </F9Body>
    </>
  );
}

function CommandsTab({ saved }: { saved: SavedEntry[] }) {
  return (
    <>
      <F9Section label="New command" />
      <F9Body>
        <F9Hint text='Type a command, pick a key and click "Save". For several commands in a row, add each one with "+ Step" first.' />
        <F9Field text="Command, e.g. cheat giveammo" />
        <div className="grid grid-cols-[minmax(0,1fr)_4.5rem] gap-2">
          <F9Field text="Wait afterwards (ms)" />
          <F9Button label="+ Step" />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_4.5rem] gap-2">
          <F9Button label="Pick a key [none]" />
          <F9Button label="Save" />
        </div>
      </F9Body>
      <F9Section label="Your commands" />
      <F9Body>
        {saved.length === 0 ? (
          <F9Hint text="No saved commands yet." />
        ) : (
          <>
            <F9Hint text="Double-click a command to change its text." />
            {saved.slice(0, 4).map((entry, i) => (
              <div key={`${entry.text}-${i}`} className="flex flex-col gap-1.5 border-b border-white/[0.06] pb-2">
                <p className="truncate font-mono text-[11px]">{entry.text}</p>
                <p className="text-[10px] text-muted-foreground">Key: {entry.vk ? keyName(entry.vk) : "none"}</p>
                <F9Buttons labels={["Run now", entry.vk ? "Remove key" : "Pick a key", "Delete"]} />
              </div>
            ))}
            {saved.length > 4 && <F9Hint text={`… and ${saved.length - 4} more`} />}
          </>
        )}
      </F9Body>
    </>
  );
}

function OptionsTab({
  s,
  bubble,
  bubbleOn,
  version,
}: {
  s: ClientSettings;
  bubble: BubbleBuildsInfo | null;
  bubbleOn: boolean;
  version: string;
}) {
  const p = s.preferences;
  // Same states as DrawBubbleBuildsStatus in GUI.cpp (the launcher adds -FeatureLevelES31 when it is
  // on, and sets Meshes to Low on 15.40 – 16.00 and 19.x)
  const level = bubble?.level ?? "unavailable";
  const unavailable = level === "unavailable";
  const status = unavailable
    ? `Bubble Builds: Not available on ${version || "this version"}`
    : !bubbleOn
      ? "Bubble Builds: Off – turn it on in the launcher, then restart the game."
      : needsLowMeshes(level)
        ? "Bubble Builds: On (Performance Mode, Meshes Low)"
        : "Bubble Builds: On (set in the launcher)";
  const hint = unavailable
    ? "Only on Fortnite 15.40 – 16.00 (Chapter 2, Seasons 5–6), and as an experiment on 19.x (Chapter 3, Season 1). Try Bubble look or Mobile Builds in the Main tab."
    : level === "lowMeshes"
      ? "Chapter 3 version: Performance Mode with Meshes set to Low. Builds look whiter and more see-through while they go up. The whole game has lower graphics. Turn it on or off in the launcher. Applies on next launch."
      : `The see-through "bubble wrap" build look from Chapter 2 Seasons 5–6. ${bubbleText.restartHint}`;
  const taken = takenKeys(s);
  const resetKey = p.resetBuildsKey ?? 0;
  const resetStatus = resetBuildsStatus(resetKey, taken);
  return (
    <>
      <F9Section label="Build look" />
      <F9Body>
        <F9Spot id="bubble">
          <F9Status text={status} tone={!unavailable && bubbleOn ? "success" : "muted"} filled={!unavailable && bubbleOn} />
        </F9Spot>
        {isExperimentalLevel(level) && (
          <span className="w-fit rounded-full bg-warning/15 px-2 py-px text-[10px] text-warning ring-1 ring-warning/55">{bubbleText.experimentalBadge}</span>
        )}
        {level === "experimental" && <F9Hint text={bubbleText.experimentalHint} />}
        <F9Hint text={hint} />
      </F9Body>
      <F9Section label="General" />
      <F9Body>
        <F9Spot id="console">
          <F9Combo label="Which console?" value={s.consoleMode === 0 ? "Niobium console" : "Original console (Unreal)"} />
        </F9Spot>
        <F9Hint text="Open the console with F8. The Niobium console knows shortcuts like /god." />
        <F9Check
          id="slash"
          label="Open the console with the # key"
          on={p.slashKey}
          hint="It opens with / already typed – then just type god and press Enter. Only with the Niobium console."
        />
        <F9Check id="remember" label="Remember my settings" on={p.saveTogglePreferences} hint="Off = every toggle is back to normal the next time you start the game." />
      </F9Body>
      <F9Section label="Reset builds" />
      <F9Body>
        {epicOwnsResetBuilding(version) ? (
          <F9Status text={resetBuildsText.epicOwns} />
        ) : (
          <>
            <F9Check id="resetbuilds" label={resetBuildsText.label} on={p.resetBuilds ?? false} hint={resetBuildsText.hint} />
            <F9Spot id="resetkey">
              <F9Buttons labels={[`${resetBuildsText.keyLabel} [${resetKey ? keyName(resetKey) : "none"}]`]} />
            </F9Spot>
            <F9Hint text={resetBuildsText.keyTip} />
            {p.resetBuilds && <F9Status text={resetStatus.text} tone={resetStatus.warn ? "warning" : "muted"} />}
          </>
        )}
      </F9Body>
      <F9Section label="Keys" />
      <F9Body>
        <F9Spot id="menukey">
          <F9Buttons labels={[`Change menu key [${keyName(s.hotkey)}]`]} />
        </F9Spot>
        <F9Spot id="joinkey">
          <F9Buttons labels={[`Change join key [${keyName(s.joinHotkey)}]`]} />
        </F9Spot>
        <F9Buttons labels={["Reset everything"]} />
        <F9Hint text="Careful: resets all toggles and keys and deletes your saved commands." />
      </F9Body>
    </>
  );
}

/** "Trickshot" tab of the F9 menu (NiobiumTrickshotTab.cpp): load a parkour, target bot, gear, practice. */
function TrickshotTab() {
  return (
    <>
      <F9Section label="Load a parkour" />
      <F9Body>
        <F9Hint text="Pick a course. You start at the beginning and get a sniper." />
        {parkours.map((p) => (
          <div key={p.id} className="rounded-[5px] bg-white/[0.02] px-2.5 py-2 ring-1 ring-white/[0.07] transition-colors hover:ring-brand-violet/40">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 truncate text-[11px] font-medium">{p.name}</span>
              <span className="flex shrink-0 gap-0.5" aria-label={`Level ${p.level} of 3`}>
                {[1, 2, 3].map((n) => (
                  <span key={n} className={cn("size-1.5 rounded-full", n <= p.level ? "bg-brand-violet" : "ring-1 ring-white/30")} />
                ))}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{levelWord(p.level)}</span>
              <span className="ml-auto shrink-0 rounded-[3px] bg-brand-violet/35 px-2.5 py-0.5 text-[10px] font-medium text-white">Load</span>
            </div>
            {p.description && <p className="mt-1 text-[10px] leading-snug text-muted-foreground">{p.description}</p>}
          </div>
        ))}
        <F9Buttons labels={["Start over", "Clear everything"]} />
      </F9Body>

      <F9Section label="Target bot" />
      <F9Body>
        <F9Hint text="A bot that stands still in front of you – great for aiming." />
        <div className="grid grid-cols-2 gap-2">
          <F9Slider label="Health" value="50" fill={0.25} />
          <F9Slider label="Distance" value="30 m" fill={0.26} />
        </div>
        <F9Button label="Place bot in front of me" primary />
        <F9Buttons labels={["Remove all bots", "Bring bots to me"]} />
      </F9Body>

      <F9Section label="Gear" />
      <F9Body>
        <F9Buttons labels={["Give sniper", "Give launch pads"]} />
        <F9Buttons labels={["Refill ammo", "Refill health"]} />
      </F9Body>

      <F9Section label="Practice" />
      <F9Body>
        <F9Hint text="Save a spot and jump back to it with one click." />
        <F9Buttons labels={["Save spot", "Back to spot"]} />
        <F9Buttons labels={["Launch me up", "Slow motion: off"]} />
        <F9Buttons labels={["Low gravity", "Normal gravity"]} />
        <F9Buttons labels={["Invincible on/off", "Pause storm"]} />
        <F9Hint text="Slow motion and the storm affect everyone in the match." />
      </F9Body>
    </>
  );
}

function CreditsTab() {
  return (
    <div className="flex flex-col gap-1.5 pt-1 text-[11px]">
      <div className="flex items-center gap-3">
        <LogoMark size={34} variant="simple" />
        <div>
          <p className="font-semibold text-violet-text">Niobium</p>
          <p className="text-muted-foreground">In-game menu</p>
        </div>
      </div>
      <p className="mt-3 text-[10px] font-semibold tracking-wide text-violet-text/85">CREDITS</p>
      <div className="mb-1 h-px bg-brand-violet/40" />
      <F9Hint text="Niobium is built on these projects. Thank you! Click a name to open its page in your browser." />
      {/* The credits themselves stay as in the original (ATLAS Console license) */}
      <p className="pt-1">
        <span className="font-medium text-violet-text">Erbium</span> <span className="text-muted-foreground">- Base of the project</span>
      </p>
      <p>
        <span className="font-medium text-violet-text">ATLAS Console</span>{" "}
        <span className="text-muted-foreground">- Base of this in-game menu (cipherfps, ralz and contributors)</span>
      </p>
      <p className="pt-4 text-[10px] text-faint">Niobium is based on ATLAS Console by cipherfps, ralz and contributors.</p>
    </div>
  );
}

/**
 * A row the preview can point at: when its setting was just changed on the left, the preview
 * scrolls it into the middle and lights it up once.
 */
function F9Spot({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const flash = useContext(FlashContext);
  const calm = useCalmMotion();
  const ref = useRef<HTMLDivElement>(null);
  const hit = flash?.id === id;

  useEffect(() => {
    const el = ref.current;
    if (!hit || !el) return;
    // Only scroll the preview itself, never the page around it
    const box = el.closest<HTMLElement>("[data-f9-scroll]");
    if (!box) return;
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTo({ top: box.scrollTop + delta - box.clientHeight / 2 + el.offsetHeight / 2, behavior: calm ? "auto" : "smooth" });
  }, [hit, flash?.n, calm]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      {hit && (
        <motion.span
          key={flash.n}
          aria-hidden
          className="pointer-events-none absolute -inset-1 rounded-md bg-brand-violet/[0.12] shadow-[inset_0_0_0_1px_rgb(155_123_255/0.7),0_0_18px_-4px_rgb(122_60_255/0.8)]"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{ duration: 1.8, times: [0, 0.12, 0.6, 1], ease: "easeOut" }}
        />
      )}
      <div className="relative">{children}</div>
    </div>
  );
}

/** Status row like StatusDotRow in GUI.cpp: a small dot, then the text. */
function F9Status({ text, tone = "muted", filled = false }: { text: string; tone?: "success" | "warning" | "muted"; filled?: boolean }) {
  return (
    <div className={cn("flex items-start gap-2 text-[11px] leading-snug", tone === "warning" && "text-warning")}>
      <span
        className={cn(
          "mt-[3px] size-2 shrink-0 rounded-full",
          filled && tone === "success" && "bg-success shadow-[0_0_0_3px_rgb(34_197_94/0.18)]",
          !filled && tone === "warning" && "ring-[1.4px] ring-warning ring-inset",
          !filled && tone !== "warning" && "ring-[1.4px] ring-muted-foreground ring-inset",
        )}
      />
      <span>{text}</span>
    </div>
  );
}

function F9Section({ label }: { label: string }) {
  return (
    <p className="mt-1 rounded-[3px] bg-white/[0.045] px-2 py-1 text-[11px] font-medium shadow-[inset_2px_0_0_var(--nb-violet)] first:mt-0">{label}</p>
  );
}
function F9Body({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1.5 pl-1.5">{children}</div>;
}
function F9Hint({ text }: { text: string }) {
  return <p className="text-[10px] leading-snug text-muted-foreground/90">{text}</p>;
}
function F9Field({ text }: { text: string }) {
  return <span className="truncate rounded-[3px] bg-white/[0.05] px-2 py-1 text-[10.5px] text-faint">{text}</span>;
}
function F9Button({ label, primary = false }: { label: string; primary?: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center justify-center rounded-[3px] px-2 py-1 text-center text-[10.5px] leading-tight",
        primary ? "bg-brand-violet/35 font-medium text-white" : "bg-white/[0.06]",
      )}
    >
      {label}
    </span>
  );
}
function F9Buttons({ labels }: { labels: string[] }) {
  return (
    <div className={cn("grid gap-1.5", labels.length > 2 ? "grid-cols-3" : labels.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
      {labels.map((l) => (
        <F9Button key={l} label={l} />
      ))}
    </div>
  );
}
function F9Combo({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 text-[11px]">
      <span>{label}</span>
      <span className="flex items-center justify-between rounded-[3px] bg-white/[0.06] px-2 py-1 text-[10.5px]">
        {value}
        <span aria-hidden className="text-[8px] text-foreground/90">
          ▼
        </span>
      </span>
    </div>
  );
}
function F9Slider({ label, value, fill }: { label: string; value: string; fill: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-[11px]">
      <span className="truncate">{label}</span>
      <div className="relative h-[18px] rounded-[3px] bg-white/[0.06]">
        <span className="absolute top-0.5 bottom-0.5 w-5 rounded-[3px] bg-brand-violet" style={{ left: `calc(${fill} * (100% - 1.5rem) + 0.125rem)` }} />
        <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] tabular-nums">{value}</span>
      </div>
    </div>
  );
}

/** Checkbox like in the F9 menu (violet tick), the grey explanation below. */
function F9Check({ id, label, on, hint, fromGame = false }: { id: string; label: string; on: boolean; hint?: string; fromGame?: boolean }) {
  return (
    <F9Spot id={id}>
      <div className="flex items-start gap-2">
        <span className="mt-px flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-white/[0.07]">
          <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
            {fromGame ? (
              // Fortnite's own value: only the game knows it
              <path d="M3.2 6h5.6" fill="none" stroke="#9b7bff" strokeOpacity={0.7} strokeWidth={1.8} strokeLinecap="round" />
            ) : (
              <motion.path
                d="M2.4 6.3 4.9 8.7 9.7 3.4"
                fill="none"
                stroke="#9b7bff"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={false}
                animate={{ pathLength: on ? 1 : 0, opacity: on ? 1 : 0 }}
                transition={{ duration: 0.25, ease: EASE_OUT }}
              />
            )}
          </svg>
        </span>
        <div className="min-w-0">
          <p className="text-[11px] leading-tight">
            {label}
            <span className="sr-only">{fromGame ? " (Fortnite's own setting)" : on ? " (on)" : " (off)"}</span>
          </p>
          {hint && <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground/90">{hint}</p>}
        </div>
      </div>
    </F9Spot>
  );
}
