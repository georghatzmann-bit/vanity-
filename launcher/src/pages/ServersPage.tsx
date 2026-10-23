import { useState } from "react";
import { motion } from "motion/react";
import { Copy, LogIn, Plus, RefreshCw, Signal, UserRound, Wifi } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, PageHeader, PageShell, Panel, Reveal } from "@/components/common";
import { demoFriends, demoServers, type ServerEntry } from "@/lib/demo-data";
import { previewToast } from "@/lib/preview";
import { cn } from "@/lib/utils";

/** Prüft grob, ob „IP“ oder „IP:Port“ eingegeben wurde. */
function isValidAddress(value: string): boolean {
  const m = value.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?$/);
  if (!m) return false;
  const octetsOk = m.slice(1, 5).every((o) => Number(o) <= 255);
  const portOk = m[5] === undefined || (Number(m[5]) > 0 && Number(m[5]) <= 65535);
  return octetsOk && portOk;
}

export function ServersPage() {
  const [address, setAddress] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const valid = isValidAddress(address);

  const join = (target: string) => previewToast(`Beitreten zu ${target}`, 4);

  return (
    <PageShell>
      <PageHeader
        title="Server & Freunde"
        description="Mit Freunden spielen: Ihr seid über Tailscale oder Radmin VPN wie in einem gemeinsamen Netzwerk. Der Host gibt seine VPN-IP weiter."
      />

      <Panel
        title="Per IP beitreten"
        description="Die IP bekommst du von deinem Freund. Ohne Port wird 7777 benutzt."
      >
        <form
          className="flex flex-wrap items-start gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) join(address.includes(":") ? address : `${address}:7777`);
          }}
        >
          <div className="min-w-64 flex-1">
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="z. B. 100.101.12.7:7777"
              aria-invalid={address.length > 0 && !valid}
              className="h-10 font-mono"
            />
            <p className={cn("mt-2 text-xs", address && !valid ? "text-destructive" : "text-muted-foreground")}>
              {address && !valid
                ? "Das sieht nicht wie eine IP aus. Beispiel: 100.101.12.7 oder 26.14.88.3:7777"
                : "Tailscale-IPs beginnen meist mit 100., Radmin-IPs mit 26."}
            </p>
          </div>
          <Button type="submit" disabled={!valid} className="h-10">
            <LogIn />
            Beitreten
          </Button>
        </form>
      </Panel>

      <Panel
        title="Server-Browser"
        description="Server deiner Freunde und im eigenen Netzwerk. Beispieldaten – echte Suche ab Phase 8."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setRefreshing(true);
              window.setTimeout(() => setRefreshing(false), 900);
            }}
          >
            <RefreshCw className={cn(refreshing && "animate-spin")} />
            Aktualisieren
          </Button>
        }
        bodyClassName="px-3"
      >
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_80px_96px_auto] items-center gap-x-4 px-3 pb-2 text-xs text-muted-foreground">
          <span>Server</span>
          <span>Modus</span>
          <span>Netzwerk</span>
          <span>Spieler</span>
          <span>Ping</span>
          <span className="w-28" />
        </div>
        <ul className="flex flex-col gap-1">
          {demoServers.map((server, i) => (
            <motion.li
              key={server.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 * i, duration: 0.18 }}
              className="grid grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_80px_96px_auto] items-center gap-x-4 rounded-lg px-3 py-3 transition-colors hover:bg-white/[0.04]"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{server.name}</p>
                <p className="selectable truncate font-mono text-xs text-muted-foreground">{server.address}</p>
              </div>
              <span className="truncate text-sm">{server.playlist}</span>
              <span className="truncate text-xs text-muted-foreground">{server.via}</span>
              <span className="text-sm tabular-nums">
                {server.players}/{server.maxPlayers}
              </span>
              <Ping server={server} />
              <Button
                variant={server.pingMs === null ? "ghost" : "secondary"}
                size="sm"
                className="w-28"
                disabled={server.pingMs === null}
                onClick={() => join(server.address)}
              >
                {server.pingMs === null ? "Offline" : "Beitreten"}
              </Button>
            </motion.li>
          ))}
        </ul>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Freunde"
          description="Gespeicherte Freunde mit ihrer VPN-IP."
          actions={
            <Button variant="secondary" size="sm" onClick={() => previewToast("Freund hinzufügen", 8)}>
              <Plus />
              Hinzufügen
            </Button>
          }
        >
          {demoFriends.length === 0 ? (
            <EmptyState
              icon={UserRound}
              title="Noch keine Freunde gespeichert"
              hint="Füge einen Freund mit seiner Tailscale- oder Radmin-IP hinzu."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {demoFriends.map((f) => (
                <li key={f.id} className="flex items-center gap-3 rounded-lg bg-white/[0.02] px-4 py-3">
                  <div className="flex size-9 items-center justify-center rounded-full bg-white/[0.06] text-sm font-semibold">
                    {f.name[0]}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{f.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {f.via} · <span className="font-mono">{f.address}</span>
                    </p>
                  </div>
                  <span className={cn("text-xs font-medium", f.online ? "text-success" : "text-muted-foreground")}>
                    {f.online ? "Online" : "Offline"}
                  </span>
                  <Button size="sm" variant="secondary" disabled={!f.online} onClick={() => join(`${f.address}:7777`)}>
                    Beitreten
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Deinen Server teilen"
          description="Diese Adressen gibst du Freunden, wenn du hostest. Beispielwerte."
        >
          <div className="flex flex-col gap-2">
            <ShareLine icon={Wifi} label="Tailscale" value="100.88.41.3:7777" />
            <ShareLine icon={Wifi} label="Radmin VPN" value="26.120.7.55:7777" />
            <ShareLine icon={Signal} label="Nur dieser PC" value="127.0.0.1:7777" />
          </div>
        </Panel>
      </div>
    </PageShell>
  );
}

function Ping({ server }: { server: ServerEntry }) {
  if (server.pingMs === null) return <span className="text-xs text-muted-foreground">–</span>;
  const quality = server.pingMs < 40 ? "gut" : server.pingMs < 90 ? "okay" : "hoch";
  return (
    <span
      className={cn(
        "text-xs font-medium tabular-nums",
        quality === "gut" && "text-success",
        quality === "okay" && "text-warning",
        quality === "hoch" && "text-destructive",
      )}
    >
      {server.pingMs} ms · {quality}
    </span>
  );
}

function ShareLine({ icon: Icon, label, value }: { icon: typeof Wifi; label: string; value: string }) {
  return (
    <Reveal className="flex items-center gap-3 rounded-lg bg-white/[0.02] px-4 py-3">
      <Icon className="size-4 text-muted-foreground" />
      <span className="w-28 text-sm">{label}</span>
      <span className="selectable flex-1 font-mono text-xs text-muted-foreground">{value}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`${label}-Adresse kopieren`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            toast.success("Kopiert", { description: value });
          } catch {
            toast.error("Kopieren hat nicht geklappt");
          }
        }}
      >
        <Copy />
      </Button>
    </Reveal>
  );
}
