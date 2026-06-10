import type { ReactNode } from "react";

/**
 * Per-navigation entrance. App Router re-mounts template.tsx on every route
 * change, so this wrapper's CSS opacity fade (.route-fade) replays each time —
 * a soft, continuous hand-off between routes that pairs with the persistent
 * atmosphere behind it. Opacity-only by design: a transform/filter here would
 * turn the fixed-positioned blob, marks and overlays into absolutely-positioned
 * elements mid-fade. Server component — it's just a styled wrapper.
 */
export default function Template({ children }: { children: ReactNode }) {
  return <div className="route-fade">{children}</div>;
}
