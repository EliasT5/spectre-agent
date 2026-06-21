"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { CSSProperties } from "react";

/**
 * Sub-navigation for the full ("kiosk") Tempus suite. Mirrors the monolith's
 * four-view IA — Dashboard / Projects / Entries / Routines — in the shell's
 * glass-HUD language (mono pills over the indigo void). Active state is derived
 * from the pathname so it survives client navigation between the sub-routes.
 */

const TABS = [
  { href: "/kiosk/tempus", label: "Dashboard" },
  { href: "/kiosk/tempus/projects", label: "Projects" },
  { href: "/kiosk/tempus/entries", label: "Entries" },
  { href: "/kiosk/tempus/routines", label: "Routines" },
] as const;

export function TempusNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Tempus" style={navStyle}>
      {TABS.map((tab) => {
        const active =
          pathname === tab.href ||
          (tab.href !== "/kiosk/tempus" && pathname.startsWith(`${tab.href}/`));
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className="tap-press"
            style={{ ...tabStyle, ...(active ? activeStyle : {}) }}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

const navStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  padding: 5,
  borderRadius: "var(--pill, 999px)",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
};

const tabStyle: CSSProperties = {
  flex: 1,
  textAlign: "center",
  padding: "8px 12px",
  borderRadius: "var(--pill, 999px)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  textDecoration: "none",
  color: "var(--color-text-muted)",
  transition: "color 0.18s var(--ease), background 0.18s var(--ease)",
};

const activeStyle: CSSProperties = {
  color: "var(--color-text)",
  background: "rgba(99,102,241,0.18)",
  boxShadow: "var(--glow-sm)",
};
