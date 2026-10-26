import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { bubbleInfoFor, type BubbleBuildsInfo } from "@/lib/bubble";

const cache = new Map<string, BubbleBuildsInfo>();

/**
 * Bubble Builds level + English note for a Fortnite version, e.g. useBubbleSupport("15.40").
 * Answers at once with the local rules, then with Rust's answer (the source of truth).
 * Returns null without a version.
 */
export function useBubbleSupport(version: string | null | undefined): BubbleBuildsInfo | null {
  const [info, setInfo] = useState<BubbleBuildsInfo | null>(() =>
    version ? (cache.get(version) ?? bubbleInfoFor(version)) : null,
  );

  useEffect(() => {
    if (!version) {
      setInfo(null);
      return;
    }
    setInfo(cache.get(version) ?? bubbleInfoFor(version));
    let alive = true;
    api
      .bubbleBuildsSupport(version)
      .then((r) => {
        cache.set(version, r);
        if (alive) setInfo(r);
      })
      .catch(() => {
        /* keep the local answer */
      });
    return () => {
      alive = false;
    };
  }, [version]);

  return info;
}
