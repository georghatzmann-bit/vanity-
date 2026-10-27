// Is a port free? And if the matchmaker port isn't, which one to use instead.
// The game learns the matchmaker/XMPP port only from the backend's own answers (the matchmaking
// ticket's serviceUrl and the XMPP ServerPort in the DefaultEngine.ini hotfix, both read from
// niobium.settings.matchmakerPort on every request), so a different port is safe.
import net from "node:net";

/** Tries to listen on host:port once. null = free, otherwise the error code (e.g. "EADDRINUSE"). */
export function portProblem(port: number, host: string): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(null)));
  });
}

/** A port the system says is free on host. */
export function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen({ port: 0, host, exclusive: true }, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/** "is already in use" / "is blocked (EACCES)" */
export function describeProblem(code: string): string {
  if (code === "EADDRINUSE") return "is already in use";
  if (code === "EACCES") return "is blocked (no permission)";
  return `doesn't work (${code})`;
}

export interface MatchmakerPort {
  /** the port to listen on */
  port: number;
  /** why the wanted port wasn't used (null = it is used) */
  problem: string | null;
}

/** The wanted port if it is free, otherwise a free one the system picks. */
export async function chooseMatchmakerPort(wanted: number, host: string): Promise<MatchmakerPort> {
  const problem = await portProblem(wanted, host);
  if (problem === null) return { port: wanted, problem: null };
  return { port: await freePort(host), problem };
}
