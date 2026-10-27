import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  CircleCheck,
  Copy,
  Download,
  Loader2,
  LogIn,
  Network,
  PackageX,
  Plus,
  RefreshCw,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UserRound,
  Users,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, IconTile, PageHeader, PageShell, Panel } from "@/components/common";
import { Reveal, Skeleton, Stagger } from "@/components/fx";
import { pageGroup } from "@/components/layout/nav";
import { api, errorText, GAME_SERVER_PORT, type FirewallStatus, type Friend, type HostInfo, type InviteInfo, type JoinCheck } from "@/lib/api";
import { useDownloads } from "@/lib/downloads";
import { joinAfterCheck } from "@/lib/friends";
import { EASE_OUT } from "@/lib/motion";
import { activeProfile, previewParam, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Network name of a friend in plain English (older entries may say "Netzwerk"). */
function viaLabel(via: string): string {
  if (!via || via === "Netzwerk" || via === "Other") return "Other network";
  return via;
}

export function ServersPage() {
  const friends = useApp((s) => s.config.friends);
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const join = useJoinFlow();

  const removeFriend = async (id: string) => {
    const config = await api.removeFriend(id);
    useApp.getState().setConfig(config);
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow={pageGroup("servers")}
        title="Servers & Friends"
        description="Play with friends over Tailscale or Radmin VPN. The host copies an invite, the friend pastes it here."
      />

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <InviteCard />
        <JoinCard flow={join} />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <ReachCard />
        <Panel
          icon={Users}
          title="Friends"
          description="Saved friends with their VPN IP. To join, your friend has to be hosting right now."
          actions={
            friends.length > 0 ? (
              <Button variant="secondary" size="sm" onClick={() => setAddFriendOpen(true)}>
                <Plus />
                Add a friend
              </Button>
            ) : undefined
          }
        >
          {friends.length === 0 ? (
            <EmptyState
              icon={UserRound}
              title="No friends saved yet"
              hint="Add a friend with their Tailscale or Radmin IP."
              action={
                <Button size="sm" onClick={() => setAddFriendOpen(true)}>
                  <Plus />
                  Add a friend
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col gap-2">
              <AnimatePresence>
                {friends.map((f, i) => (
                  <motion.li
                    key={f.id}
                    layout
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0, transition: { duration: 0.36, ease: EASE_OUT, delay: 0.12 + i * 0.05 } }}
                    exit={{ opacity: 0, x: 10, transition: { duration: 0.16 } }}
                    className="group flex items-center gap-3 rounded-lg surface-subtle px-3 py-2.5 transition-colors hover:bg-white/[0.05]"
                  >
                    <Avatar name={f.name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{f.name}</p>
                      <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{viaLabel(f.via)}</span>
                        <span aria-hidden className="size-1 rounded-full bg-white/20" />
                        <span className="selectable truncate font-mono">{f.address}</span>
                      </p>
                    </div>
                    <Button size="sm" variant="secondary" disabled={join.busy} onClick={() => join.run(f.address)}>
                      <LogIn />
                      Join
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => removeFriend(f.id)}
                      className="opacity-60 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                    >
                      <Trash2 />
                    </Button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </Panel>
      </div>

      <HowItWorks />

      <AddFriendDialog open={addFriendOpen} onOpenChange={setAddFriendOpen} />
    </PageShell>
  );
}

// ---- Host: the invite --------------------------------------------------------------------------

function InviteCard() {
  const setPage = useApp((s) => s.setPage);
  const hosting = useApp((s) => s.services.server !== "stopped");
  const profileKey = useApp((s) => {
    const p = activeProfile(s.config);
    return p ? `${p.id}|${p.buildId}|${p.playlist}|${p.friendsTogether}|${p.bots}|${p.lategame}` : "";
  });
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => {
    api
      .inviteInfo()
      .then(setInfo)
      .catch((e) => setInfo({ code: null, text: null, summary: "", address: null, others: [], version: null, cl: null, problem: errorText(e), hint: null }));
  }, []);
  useEffect(refresh, [refresh, profileKey]);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    if (!info?.text) return;
    try {
      await navigator.clipboard.writeText(info.text);
      setCopied(true);
      toast.success("Invite copied", { description: "Send it to your friend (Discord, WhatsApp …)." });
    } catch {
      toast.error("Couldn't copy", { description: "Select the code and copy it by hand." });
    }
  };

  return (
    <Panel
      className="min-w-0"
      icon={Share2}
      title="Invite friends"
      description={hosting ? "You're hosting. Send this invite to your friend." : "Send this to your friend, then press Host & Play."}
      actions={
        <Button variant="ghost" size="icon-sm" aria-label="Refresh the invite" onClick={refresh}>
          <RefreshCw />
        </Button>
      }
    >
      {info === null ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : info.problem || !info.code ? (
        <Notice tone="warning" icon={TriangleAlert} title="No invite yet" text={info.problem ?? "Something is missing."} />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary" className="max-w-full whitespace-normal">
              <Users />
              {info.summary}
            </Badge>
            <Badge variant="secondary">Fortnite {info.version}</Badge>
            {info.address && (
              <Badge variant="secondary">
                <Wifi />
                {info.address.label}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-stretch gap-2">
            <code className="selectable min-w-0 flex-1 rounded-lg surface-subtle px-3 py-2.5 font-mono text-[13px] leading-relaxed break-all text-foreground">
              {info.code}
            </code>
            <Button className="h-auto min-h-11 px-4" onClick={copy}>
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy invite"}
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Your friend pastes it in Rift → Servers &amp; Friends → Join. They need Fortnite {info.version} and the same VPN network.{" "}
            <button type="button" className="text-violet-text underline-offset-2 hover:underline" onClick={() => setPage("profiles")}>
              Change the mode
            </button>
          </p>
          {info.hint && <Notice tone="warning" icon={TriangleAlert} text={info.hint} />}
          {info.others.length > 0 && (
            <details className="group text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none hover:text-foreground">Other addresses of this PC</summary>
              <div className="mt-2 flex flex-col gap-2">
                {info.others.map((a) => (
                  <ShareLine key={a.ip} icon={Wifi} label={a.label} value={`${a.ip}:${GAME_SERVER_PORT}`} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---- Host: Windows Firewall ----------------------------------------------------------------------

function ReachCard() {
  const [fw, setFw] = useState<FirewallStatus | null>(null);
  const [busy, setBusy] = useState<"check" | "allow" | "remove" | null>("check");

  const check = useCallback(() => {
    setBusy("check");
    api
      .firewallStatus()
      .then(setFw)
      .catch((e) => setFw({ state: "unknown", network: "", riftRules: false, checkRule: false, detail: errorText(e) }))
      .finally(() => setBusy(null));
  }, []);
  useEffect(check, [check]);

  const change = async (what: "allow" | "remove") => {
    setBusy(what);
    try {
      setFw(await (what === "allow" ? api.firewallAllow() : api.firewallRemove()));
      toast.success(what === "allow" ? "Friends can connect now" : "Rift's firewall rules removed");
    } catch (e) {
      toast.error(what === "allow" ? "Nothing was changed" : "Couldn't remove the rules", { description: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const good = fw?.state === "allowed" || fw?.state === "off";
  const canAllow = fw && (fw.state === "blocked" || fw.state === "notAllowed" || fw.state === "unknown");

  return (
    <Panel
      className="min-w-0"
      icon={ShieldCheck}
      title="Can friends reach me?"
      description="Windows Firewall must let your friends in when you host."
      actions={
        <Button variant="ghost" size="icon-sm" aria-label="Check again" disabled={busy !== null} onClick={check}>
          <RefreshCw className={cn(busy === "check" && "animate-spin")} />
        </Button>
      }
    >
      {fw === null ? (
        <Skeleton className="h-12 w-full rounded-lg" />
      ) : (
        <div className="flex flex-col gap-3">
          <Notice
            tone={good ? "success" : fw.state === "unsupported" ? "muted" : "warning"}
            icon={good ? ShieldCheck : ShieldAlert}
            title={good ? "Yes" : fw.state === "unsupported" ? "Windows only" : fw.state === "unknown" ? "Not sure" : fw.state === "blocked" ? "Blocked" : "Not yet"}
            text={fw.detail}
          />
          {canAllow && (
            <div className="flex flex-col gap-2 rounded-lg surface-subtle p-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                This adds one Windows Firewall rule so friends can join your game (Fortnite, UDP port 7777), plus a small one so
                their Rift can check your game first (TCP 7777). If a Windows rule blocks this Fortnite, Rift switches it off.
                Windows asks you first. You can remove it any time.
              </p>
              <Button className="self-start" disabled={busy !== null} onClick={() => change("allow")}>
                <ShieldCheck />
                {busy === "allow" ? "Waiting for Windows …" : "Allow friends to connect"}
              </Button>
            </div>
          )}
          {fw.riftRules && (
            <Button variant="ghost" size="sm" className="self-start" disabled={busy !== null} onClick={() => change("remove")}>
              <Trash2 />
              {busy === "remove" ? "Waiting for Windows …" : "Remove the rule"}
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---- Friend: paste, check, join ----------------------------------------------------------------

interface JoinFlow {
  text: string;
  setText: (t: string) => void;
  busy: boolean;
  check: JoinCheck | null;
  run: (text: string) => Promise<void>;
  joinAnyway: () => Promise<void>;
}

function useJoinFlow(): JoinFlow {
  const [text, setText] = useState(() => previewParam("join") ?? "");
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<JoinCheck | null>(null);

  const run = useCallback(async (input: string) => {
    setText(input);
    setBusy(true);
    setCheck(null);
    try {
      const c = await api.checkJoin(input);
      setCheck(c);
      if (c.ok) await joinAfterCheck(c);
    } catch (e) {
      toast.error("Couldn't check", { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }, []);

  // Preview only: ?join=<invite> shows the check result right away (screenshots)
  useEffect(() => {
    const t = previewParam("join");
    if (t) void run(t);
  }, [run]);

  const joinAnyway = async () => {
    if (!check) return;
    setBusy(true);
    await joinAfterCheck(check);
    setBusy(false);
  };

  return { text, setText, busy, check, run, joinAnyway };
}

function JoinCard({ flow }: { flow: JoinFlow }) {
  const { text, setText, busy, check, run, joinAnyway } = flow;
  const setPage = useApp((s) => s.setPage);
  const canJoin = text.trim().length > 0 && !busy;

  const download = (key: string) => {
    useDownloads.setState({ openKey: key });
    setPage("download");
  };

  return (
    <Panel className="min-w-0" icon={LogIn} title="Join a friend" description="Paste the invite your friend copied (or just their IP). Rift checks everything first.">
      <form
        className="flex flex-wrap items-start gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canJoin) void run(text);
        }}
      >
        <div className="relative min-w-48 flex-1">
          <Network className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" />
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Invite (RIFT1:…) or IP"
            aria-label="Invite code or IP address of the host"
            className="h-11 pl-10 font-mono text-sm"
          />
        </div>
        <Button type="submit" disabled={!canJoin} className="h-11 px-5">
          {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
          {busy ? "Checking …" : "Join"}
        </Button>
      </form>

      <AnimatePresence mode="wait" initial={false}>
        {check && (
          <motion.div
            key={`${check.status}-${check.ip}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE_OUT } }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            className="mt-4"
          >
            <CheckResult check={check} busy={busy} onRetry={() => run(text)} onJoinAnyway={joinAnyway} onDownload={download} />
          </motion.div>
        )}
      </AnimatePresence>
    </Panel>
  );
}

function CheckResult({
  check,
  busy,
  onRetry,
  onJoinAnyway,
  onDownload,
}: {
  check: JoinCheck;
  busy: boolean;
  onRetry: () => void;
  onJoinAnyway: () => void;
  onDownload: (key: string) => void;
}) {
  const tone = check.ok ? "success" : check.status === "badInput" ? "danger" : "warning";
  const icon = check.ok ? CircleCheck : check.status === "wrongVersion" ? PackageX : check.status === "badInput" ? TriangleAlert : WifiOff;
  const phase = check.host ? hostPhaseText(check.host) : null;
  return (
    <div className="flex flex-col gap-3 rounded-lg surface-subtle p-4">
      <div className="flex items-start gap-3">
        <IconTile icon={icon} tone={tone} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{check.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{check.detail}</p>
          {(check.summary || phase) && (
            <div className="mt-2 flex flex-wrap gap-2">
              {check.summary && (
                <Badge variant="secondary">
                  <Users />
                  {check.summary}
                </Badge>
              )}
              {phase && <Badge variant="secondary">{phase}</Badge>}
              {check.ok && check.ip && <Badge variant="secondary" className="font-mono">{check.ip}</Badge>}
            </div>
          )}
        </div>
      </div>
      {!check.ok && (check.downloadKey || check.joinAnyway || check.status !== "badInput") && (
        <div className="flex flex-wrap gap-2">
          {check.downloadKey && (
            <Button size="sm" onClick={() => onDownload(check.downloadKey!)}>
              <Download />
              Download it
            </Button>
          )}
          {check.status !== "badInput" && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={onRetry}>
              <RefreshCw />
              Check again
            </Button>
          )}
          {check.joinAnyway && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onJoinAnyway}>
              <LogIn />
              Join anyway
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function hostPhaseText(host: HostInfo): string {
  const players = host.players === 1 ? "1 player" : `${host.players} players`;
  switch (host.phase) {
    case "starting":
      return "Server is loading";
    case "started":
      return `Match running · ${players}`;
    case "ended":
      return "Match over";
    default:
      return `Waiting for players · ${players}`;
  }
}

function Notice({ tone, icon, title, text }: { tone: "success" | "warning" | "muted"; icon: LucideIcon; title?: string; text: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg surface-subtle p-3">
      <IconTile icon={icon} tone={tone} size="sm" />
      <div className="min-w-0 text-xs leading-relaxed">
        {title && <p className="text-sm font-semibold text-foreground">{title}</p>}
        <p className="text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  // A steady hue per name, kept inside the brand blues and violets
  const hue = 218 + (([...name].reduce((a, c) => a + c.charCodeAt(0), 0) * 7) % 48);
  return (
    <div
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_4px_14px_-6px_rgb(139_92_246/0.6)]"
      style={{ backgroundImage: `linear-gradient(135deg, hsl(${hue} 88% 60%), hsl(${hue + 22} 82% 56%))` }}
    >
      {name[0]?.toUpperCase()}
    </div>
  );
}

function ShareLine({ icon, label, value }: { icon: typeof Wifi; label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Copied", { description: value });
    } catch {
      toast.error("Couldn't copy");
    }
  };

  return (
    <Reveal kind="slide" className="flex items-center gap-3 rounded-lg surface-subtle px-3 py-2.5 transition-colors hover:bg-white/[0.05]">
      <IconTile icon={icon} size="sm" tone={label === "This PC only" ? "muted" : "brand"} />
      <span className="w-28 shrink-0 text-sm">{label}</span>
      <span className="selectable min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{value}</span>
      <Button variant="ghost" size="icon-sm" aria-label={`Copy the ${label} address`} onClick={copy}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={copied ? "done" : "copy"}
            initial={{ opacity: 0, scale: 0.5, rotate: -30 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            exit={{ opacity: 0, scale: 0.5 }}
            transition={{ duration: 0.16 }}
            className="flex"
          >
            {copied ? <Check className="text-success" /> : <Copy />}
          </motion.span>
        </AnimatePresence>
      </Button>
    </Reveal>
  );
}

const howSteps = [
  { title: "Same network", hint: "You both install Tailscale or Radmin VPN and join the same network." },
  { title: "Host invites", hint: "The host presses Host & Play, then Copy invite, and sends it to the friend." },
  { title: "Friend joins", hint: "Paste the invite above and press Join. Rift checks the version and starts the game." },
];

function HowItWorks() {
  return (
    <Panel title="How playing together works" description="Three steps, then you're in the same match.">
      <Stagger className="grid gap-3 md:grid-cols-3" inView stagger={0.08}>
        {howSteps.map((s, i) => (
          <Reveal key={s.title} kind="scale" className="relative flex gap-3 rounded-lg surface-subtle p-4">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white tabular-nums shadow-[0_0_14px_-3px_rgb(139_92_246/0.8)]">
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{s.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{s.hint}</p>
            </div>
          </Reveal>
        ))}
      </Stagger>
    </Panel>
  );
}

function AddFriendDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [via, setVia] = useState("Tailscale");
  const addrOk = /^(\d{1,3}\.){3}\d{1,3}(:\d{1,5})?$/.test(address.trim());

  useEffect(() => {
    if (!open) {
      setName("");
      setAddress("");
    }
  }, [open]);

  const save = async () => {
    const friend: Friend = { id: `f-${Date.now()}`, name: name.trim(), address: address.trim(), via };
    const config = await api.addFriend(friend);
    useApp.getState().setConfig(config);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a friend</DialogTitle>
          <DialogDescription>Save their name and VPN IP, then join with one click.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && addrOk) save();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="fr-name">Name</Label>
            <Input id="fr-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Max" autoFocus />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="fr-addr">IP address</Label>
            <Input
              id="fr-addr"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="100.101.12.7"
              aria-invalid={address.length > 0 && !addrOk}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="fr-via">Network</Label>
            <Select value={via} onValueChange={setVia}>
              <SelectTrigger id="fr-via" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Tailscale">Tailscale</SelectItem>
                <SelectItem value="Radmin VPN">Radmin VPN</SelectItem>
                <SelectItem value="Other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || !addrOk}>
              <Plus />
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

