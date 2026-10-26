import { useEffect, useState } from "react";
import { api, type BotsSupport } from "@/lib/api";
import { botsSupportFor } from "@/lib/bots";

const cache = new Map<string, BotsSupport>();

/**
 * Can AI bots be switched on for this build? `{ level, note }`, e.g. useBotsSupport("19.10", 18675304).
 * Answers at once with the local rule, then with Rust's answer (the source of truth).
 * Returns null without a version.
 */
export function useBotsSupport(version: string | null | undefined, cl: number | null | undefined): BotsSupport | null {
  const id = version ? `${version}|${cl ?? ""}` : "";
  const [info, setInfo] = useState<BotsSupport | null>(() => (version ? (cache.get(id) ?? botsSupportFor(version, cl)) : null));

  useEffect(() => {
    if (!version) {
      setInfo(null);
      return;
    }
    setInfo(cache.get(id) ?? botsSupportFor(version, cl));
    let alive = true;
    api
      .botsSupport(version, cl ?? null)
      .then((r) => {
        cache.set(id, r);
        if (alive) setInfo(r);
      })
      .catch(() => {
        /* keep the local answer */
      });
    return () => {
      alive = false;
    };
  }, [id, version, cl]);

  return info;
}
