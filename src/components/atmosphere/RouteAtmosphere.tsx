"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";

/**
 * Mounts the living tab atmosphere on every route EXCEPT home (where the blob
 * owns the canvas). Rendered once at the root so it persists across tab→tab
 * navigation — a single WebGL context for the whole tab session, not a remount
 * per page. Client-only (the Canvas can't SSR), behind all content, click-through.
 */

const TabAtmosphere = dynamic(
  () => import("./TabAtmosphere").then((m) => m.TabAtmosphere),
  { ssr: false },
);

export function RouteAtmosphere() {
  const pathname = usePathname();
  // Home owns the canvas (the blob); the PIN gate stays bare (no pre-auth WebGL).
  if (pathname === "/" || pathname === "/pin") return null;
  return (
    <div className="route-atmo" aria-hidden>
      <TabAtmosphere />
    </div>
  );
}
