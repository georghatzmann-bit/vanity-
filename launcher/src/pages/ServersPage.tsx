import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, Gamepad2, LogIn, Network, Plus, Server, Share2, Signal, Trash2, UserRound, Users, Wifi } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, IconTile, PageHeader, PageShell, Panel } from "@/components/common";
import { Reveal, Skeleton, Stagger } from "@/components/fx";
import { pageGroup } from "@/components/layout/nav";
import { api, inTauri, type Friend } from "@/lib/api";
import { EASE_OUT, SPRING_UI } from "@/lib/motion";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

function isValidAddress(value: string): boolean {
  const m = value.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?$/);
  if (!m) return false;
  const octetsOk = m.slice(1, 5).every((o) => Number(o) <= 255);
  const portOk = m[5] === undefined || (Number(m[5]) > 0 && Number(m[5]) <= 65535);
  return octetsOk && portOk;
}

/** "100.101.12.7" → "100.101.12.7:7777" (without a port, 7777 is used). */
function withPort(address: string): string {
  const a = address.trim();
  return a.includes(":") ? a : `${a}:7777`;
}

/** Network name of a friend in plain English (older entries may say "Netzwerk"). */
function viaLabel(via: string): string {
  if (!via || via === "Netzwerk" || via === "Other") return "Other network";
  return via;
}

export function ServersPage() {
  const friends = useApp((s) => s.config.friends);
  const [address, setAddress] = useState("");
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [shares, setShares] = useState<[string, string][] | null>(null);
  const valid = isValidAddress(address);
  const showError = address.trim().length > 0 && !valid;

  useEffect(() => {
    api
      .shareAddresses()
      .then(setShares)
      .catch(() => setShares([]));
  }, []);

  const join = async (target: string) => {
    if (!inTauri) {
      toast("Joining (preview)", { description: target });
      return;
    }
    try {
      await api.joinIp(target);
    } catch (e) {
      toast.error("Couldn't join", { description: String(e) });
    }
  };

  const removeFriend = async (id: string) => {
    const config = await api.removeFriend(id);
    useApp.getState().setConfig(config);
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow={pageGroup("servers")}
        title="Servers & Friends"
        description="Play with friends over Tailscale or Radmin VPN. The host shares their VPN IP, you join."
      />

      <Panel icon={LogIn} title="Join by IP" description="Your friend gives you the IP. Without a port, 7777 is used.">
        <div className="grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <form
            className="flex flex-wrap items-start gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) join(withPort(address));
            }}
          >
            <div className="min-w-64 flex-1">
              <div className="relative">
                <Network className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" />
                <Input
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="e.g. 100.101.12.7:7777"
                  aria-label="IP address of the host"
                  aria-invalid={showError}
                  className="h-11 pr-10 pl-10 font-mono text-sm"
                />
                <AnimatePresence>
                  {valid && (
                    <motion.span
                      key="ok"
                      initial={{ opacity: 0, scale: 0.4 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.4 }}
                      transition={SPRING_UI}
                      className="absolute top-1/2 right-3 flex size-5 -translate-y-1/2 items-center justify-center rounded-full bg-success/15 text-success"
                    >
                      <Check className="size-3" strokeWidth={3} />
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
              <AnimatePresence mode="wait" initial={false}>
                <motion.p
                  key={showError ? "bad" : "hint"}
                  initial={{ opacity: 0, y: -3 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE_OUT } }}
                  exit={{ opacity: 0, transition: { duration: 0.1 } }}
                  className={cn("mt-2 text-xs", showError ? "text-destructive" : "text-muted-foreground")}
                >
                  {showError ? "That doesn't look like an IP. Example: 100.101.12.7" : "Tailscale IPs usually start with 100., Radmin IPs with 26."}
                </motion.p>
              </AnimatePresence>
            </div>
            <Button type="submit" disabled={!valid} className="h-11 px-5">
              <LogIn />
              Join
            </Button>
          </form>
          <ConnectionVisual ready={valid} target={valid ? withPort(address) : null} />
        </div>
      </Panel>

      <div className="grid items-start gap-6 lg:grid-cols-2">
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
                    <Button size="sm" variant="secondary" onClick={() => join(withPort(f.address))}>
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

        <Panel icon={Share2} title="Share your server" description="Give these addresses to friends when you host.">
          <div className="flex flex-col gap-2">
            {shares === null ? (
              [0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 rounded-lg surface-subtle px-3 py-2.5">
                  <Skeleton className="size-8 rounded-lg" />
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="ml-auto h-3.5 w-32" />
                </div>
              ))
            ) : (
              <Stagger className="flex flex-col gap-2" stagger={0.06}>
                {shares.map(([label, value]) => (
                  <ShareLine key={value} icon={label === "This PC only" ? Signal : Wifi} label={label} value={value} />
                ))}
              </Stagger>
            )}
          </div>
        </Panel>
      </div>

      <HowItWorks />

      <AddFriendDialog open={addFriendOpen} onOpenChange={setAddFriendOpen} />
    </PageShell>
  );
}

/** You ↔ host: the line lights up and a light travels along it once the IP looks right. */
function ConnectionVisual({ ready, target }: { ready: boolean; target: string | null }) {
  return (
    <div aria-hidden className="hidden items-center gap-3 lg:flex">
      <Node icon={Gamepad2} label="You" lit />
      <div className="relative h-[3px] flex-1 overflow-hidden rounded-full bg-white/[0.06]">
        <motion.div
          className="absolute inset-y-0 left-0 rounded-full bg-brand shadow-[0_0_12px_rgb(122_60_255/0.7)]"
          initial={false}
          animate={{ width: ready ? "100%" : "0%" }}
          transition={{ duration: 0.6, ease: EASE_OUT }}
        />
        {ready && (
          <span className="nb-loop absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/80 to-transparent [animation:nb-beam_1.4s_ease-in-out_infinite]" />
        )}
      </div>
      <Node icon={Server} label={target ?? "Host"} lit={ready} mono={Boolean(target)} />
    </div>
  );
}

function Node({ icon: Icon, label, lit, mono }: { icon: typeof Server; label: string; lit: boolean; mono?: boolean }) {
  return (
    <div className="flex w-28 flex-col items-center gap-1.5">
      <motion.div
        animate={{ scale: lit ? 1 : 0.94 }}
        transition={SPRING_UI}
        className={cn(
          "flex size-11 items-center justify-center rounded-xl ring-1 transition-[background-color,box-shadow,color] duration-300",
          lit
            ? "bg-gradient-to-br from-brand-blue/30 to-brand-violet/30 text-violet-text ring-brand-violet/40 shadow-[0_0_24px_-6px_rgb(122_60_255/0.7)]"
            : "bg-white/[0.04] text-faint ring-white/[0.08]",
        )}
      >
        <Icon className="size-5" />
      </motion.div>
      <span className={cn("max-w-full truncate text-[11px]", lit ? "text-foreground" : "text-faint", mono && "font-mono")}>{label}</span>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  // A steady hue per name, kept inside the brand blues and violets
  const hue = 218 + (([...name].reduce((a, c) => a + c.charCodeAt(0), 0) * 7) % 48);
  return (
    <div
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_4px_14px_-6px_rgb(122_60_255/0.6)]"
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
  { title: "Host starts", hint: "The host presses Host & Play and shares their VPN IP." },
  { title: "You join", hint: "Paste the IP above (or pick a saved friend) and press Join." },
];

function HowItWorks() {
  return (
    <Panel title="How playing together works" description="Three steps, then you're in the same match.">
      <Stagger className="grid gap-3 md:grid-cols-3" inView stagger={0.08}>
        {howSteps.map((s, i) => (
          <Reveal key={s.title} kind="scale" className="relative flex gap-3 rounded-lg surface-subtle p-4">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white tabular-nums shadow-[0_0_14px_-3px_rgb(122_60_255/0.8)]">
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

