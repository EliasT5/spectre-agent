import type { ReactNode } from "react";
import type { Device } from "@/lib/device";
import { DesktopShell } from "./desktop/DesktopShell";

/**
 * Picks the shell chrome by device. Mobile is a passthrough -- the pages are
 * already their own full-screen, touch-first views, so the mobile experience is
 * unchanged. Desktop wraps them in a sidebar + content chrome (DesktopShell).
 */
export function Shell({ device, children }: { device: Device; children: ReactNode }) {
  if (device === "desktop") return <DesktopShell>{children}</DesktopShell>;
  return <>{children}</>;
}
