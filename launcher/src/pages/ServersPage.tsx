import { useEffect, useState } from "react";
import { Copy, LogIn, Plus, Signal, Trash2, UserRound, Wifi } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, PageHeader, PageShell, Panel, Reveal } from "@/components/common";
import { api, inTauri, type Friend } from "@/lib/api";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

function isValidAddress(value: string): boolean {
  const m = value.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?$/);
  if (!m) return false;
  const octetsOk = m.slice(1, 5).every((o) => Number(o) <= 255);
  const portOk = m[5] === undefined || (Number(m[5]) > 0 && Number(m[5]) <= 65535);
  return octetsOk && portOk;
}

export function ServersPage() {
  const friends = useApp((s) => s.config.friends);
  const [address, setAddress] = useState("");
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [shares, setShares] = useState<[string, string][]>([]);
  const valid = isValidAddress(address);

  useEffect(() => {
    api.shareAddresses().then(setShares).catch(() => {});
  }, []);

  const join = async (target: string) => {
    if (!inTauri) {
      toast("Beitreten (Vorschau)", { description: target });
      return;
    }
    try {
      await api.joinIp(target);
    } catch (e) {
      toast.error("Beitreten fehlgeschlagen", { description: String(e) });
    }
  };

  const removeFriend = async (id: string) => {
    const config = await api.removeFriend(id);
    useApp.getState().setConfig(config);
  };

  return (
    <PageShell>
      <PageHeader
        title="Server & Freunde"
        description="Mit Freunden spielen: Ihr seid über Tailscale oder Radmin VPN wie in einem gemeinsamen Netzwerk. Der Host gibt seine VPN-IP weiter."
      />

      <Panel title="Per IP beitreten" description="Die IP bekommst du von deinem Freund. Ohne Port wird 7777 benutzt.">
        <form className="flex flex-wrap items-start gap-3" onSubmit={(e) => { e.preventDefault(); if (valid) join(address.includes(":") ? address : `${address}:7777`); }}>
          <div className="min-w-64 flex-1">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="z. B. 100.101.12.7:7777" aria-invalid={address.length > 0 && !valid} className="h-10 font-mono" />
            <p className={cn("mt-2 text-xs", address && !valid ? "text-destructive" : "text-muted-foreground")}>
              {address && !valid ? "Das sieht nicht wie eine IP aus. Beispiel: 100.101.12.7" : "Tailscale-IPs beginnen meist mit 100., Radmin-IPs mit 26."}
            </p>
          </div>
          <Button type="submit" disabled={!valid} className="h-10"><LogIn />Beitreten</Button>
        </form>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Freunde"
          description="Gespeicherte Freunde mit ihrer VPN-IP. Zum Beitreten muss der Freund gerade hosten."
          actions={<Button variant="secondary" size="sm" onClick={() => setAddFriendOpen(true)}><Plus />Hinzufügen</Button>}
        >
          {friends.length === 0 ? (
            <EmptyState icon={UserRound} title="Noch keine Freunde gespeichert" hint="Füge einen Freund mit seiner Tailscale- oder Radmin-IP hinzu." action={<Button size="sm" onClick={() => setAddFriendOpen(true)}><Plus />Hinzufügen</Button>} />
          ) : (
            <ul className="flex flex-col gap-2">
              {friends.map((f) => (
                <li key={f.id} className="flex items-center gap-3 rounded-lg bg-white/[0.02] px-4 py-3">
                  <div className="flex size-9 items-center justify-center rounded-full bg-white/[0.06] text-sm font-semibold">{f.name[0]?.toUpperCase()}</div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{f.name}</p>
                    <p className="text-xs text-muted-foreground">{f.via || "Netzwerk"} · <span className="font-mono">{f.address}</span></p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => join(f.address.includes(":") ? f.address : `${f.address}:7777`)}>Beitreten</Button>
                  <Button size="icon-sm" variant="ghost" aria-label={`${f.name} entfernen`} onClick={() => removeFriend(f.id)}><Trash2 /></Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Deinen Server teilen" description="Diese Adressen gibst du Freunden, wenn du hostest.">
          <div className="flex flex-col gap-2">
            {shares.map(([label, value]) => (
              <ShareLine key={value} icon={label === "Nur dieser PC" ? Signal : Wifi} label={label} value={value} />
            ))}
          </div>
        </Panel>
      </div>

      <AddFriendDialog open={addFriendOpen} onOpenChange={setAddFriendOpen} />
    </PageShell>
  );
}

function ShareLine({ icon: Icon, label, value }: { icon: typeof Wifi; label: string; value: string }) {
  return (
    <Reveal className="flex items-center gap-3 rounded-lg bg-white/[0.02] px-4 py-3">
      <Icon className="size-4 text-muted-foreground" />
      <span className="w-28 text-sm">{label}</span>
      <span className="selectable flex-1 font-mono text-xs text-muted-foreground">{value}</span>
      <Button variant="ghost" size="icon-sm" aria-label={`${label}-Adresse kopieren`} onClick={async () => { try { await navigator.clipboard.writeText(value); toast.success("Kopiert", { description: value }); } catch { toast.error("Kopieren hat nicht geklappt"); } }}><Copy /></Button>
    </Reveal>
  );
}

function AddFriendDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [via, setVia] = useState("Tailscale");
  const addrOk = /^(\d{1,3}\.){3}\d{1,3}(:\d{1,5})?$/.test(address.trim());

  useEffect(() => {
    if (!open) { setName(""); setAddress(""); }
  }, [open]);

  const save = async () => {
    const friend: Friend = { id: `f-${Date.now()}`, name: name.trim(), address: address.trim(), via };
    const config = await api.addFriend(friend);
    useApp.getState().setConfig(config);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong sm:max-w-md">
        <DialogHeader><DialogTitle>Freund hinzufügen</DialogTitle></DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (name.trim() && addrOk) save(); }}>
          <div className="flex flex-col gap-2"><Label htmlFor="fr-name">Name</Label><Input id="fr-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="fr-addr">IP-Adresse</Label>
            <Input id="fr-addr" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="100.101.12.7" aria-invalid={address.length > 0 && !addrOk} className="font-mono text-xs" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="fr-via">Netzwerk</Label>
            <Select value={via} onValueChange={setVia}>
              <SelectTrigger id="fr-via"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="Tailscale">Tailscale</SelectItem><SelectItem value="Radmin VPN">Radmin VPN</SelectItem><SelectItem value="Netzwerk">Anderes</SelectItem></SelectContent>
            </Select>
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Abbrechen</Button>
            <Button type="submit" disabled={!name.trim() || !addrOk}>Hinzufügen</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
