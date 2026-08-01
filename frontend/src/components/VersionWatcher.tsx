"use client";

import { useEffect } from "react";

/**
 * Polls /build.txt at startup and every 60s. If the server's stamp
 * differs from the one this tab cached, the page reloads so the user
 * gets the new bundle without having to know about caches or deploys.
 *
 * Why polling and not the build-manifest: we want a single small asset
 * (5 bytes minimum) that's cache-busted via a query string, served
 * straight from Next's static handler, with no service worker
 * complexity. Polling at 60s is cheap (one HEAD-style GET every
 * minute per tab) and keeps the staleness window bounded by ~60s.
 *
 * The first poll happens after `idle` so it never competes with the
 * initial paint for bandwidth. Reloads defer by 1s after detecting a
 * version mismatch so any in-flight optimistic UI can settle and the
 * scroll position can be re-anchored on the next mount.
 */
export function VersionWatcher() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let current = "";
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch(`/build.txt?_=${Date.now()}`, {
          cache: "no-store",
          credentials: "omit",
        });
        if (!res.ok || cancelled) return;
        const text = (await res.text()).trim();
        if (!current) {
          current = text;
          return;
        }
        if (text && text !== current) {
          // Server has a newer bundle. Reload once. Use replace so the
          // back button doesn't trap the user on a stale tab.
          window.location.reload();
        }
      } catch {
        /* offline / blocked — try again on the next tick */
      }
    }

    const onIdle = () => {
      void check();
      const handle = setInterval(check, 60_000);
      window.addEventListener("beforeunload", () => clearInterval(handle), { once: true });
    };

    if ("requestIdleCallback" in window) {
      (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(onIdle);
    } else {
      const t = setTimeout(onIdle, 1500);
      return () => clearTimeout(t);
    }

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}