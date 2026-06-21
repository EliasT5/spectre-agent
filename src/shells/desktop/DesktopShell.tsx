"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  Home,
  MessageSquare,
  Brain,
  Settings,
  Activity,
  Timer,
  FolderGit2,
  Image as ImageIcon,
  Box,
  Radio,
  type LucideIcon,
} from "lucide-react";
import { useModules } from "@/lib/module-registry";
import "./desktop-shell.css";

// Resolve a module's lucide icon NAME the same way the blob slots do (Nodes.tsx).
const ICONS: Record<string, LucideIcon> = {
  Home,
  MessageSquare,
  Brain,
  Settings,
  Activity,
  Timer,
  FolderGit2,
  Image: ImageIcon,
  Box,
};

// Sub-labels for built-in modules that ship without a `hint`, so every nav row
// reads as two lines like Jerome's kiosk rail.
const SUBS: Record<string, string> = {
  chat: "Conversations",
  memory: "Long-term recall",
  settings: "Configuration",
};

function SidebarClock() {
  // null until mounted so SSR + first client render match (no hydration drift).
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const hh = now ? String(now.getHours()).padStart(2, "0") : "··";
  const mm = now ? String(now.getMinutes()).padStart(2, "0") : "··";
  const ss = now ? String(now.getSeconds()).padStart(2, "0") : "··";
  const date = now ? now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) : "";
  return (
    <div className="dshell-clock">
      <div className="dshell-clock-time">
        {hh}:{mm}
        <span className="dshell-clock-sec">:{ss}</span>
      </div>
      <div className="dshell-clock-date">{date}</div>
    </div>
  );
}

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}

export function DesktopShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // Nav comes from the live module registry, so installed/workshop modules
  // appear automatically (same source the blob slots use).
  const modules = useModules();

  // Chrome-free routes: the blob home (immersive) and the pre-auth PIN page.
  if (pathname === "/" || pathname === "/pin" || pathname.startsWith("/pin/")) {
    return <>{children}</>;
  }

  const items = [
    { href: "/", label: "Home", sub: "Blob & overview", Icon: Home },
    ...modules.map((m) => ({
      href: m.route,
      label: m.label,
      sub: m.hint ?? SUBS[m.id] ?? "",
      Icon: ICONS[m.icon] ?? Box,
    })),
  ];

  return (
    <div className="dshell">
      <aside className="dshell-side">
        <div className="dshell-side-scroll">
          <Link href="/" className="dshell-brand" aria-label="Spectre home">
            <span className="dshell-eyebrow">SELF-HOSTED &middot; ASSISTANT</span>
            <span className="dshell-logo-word gradient-text">Spectre</span>
            <span className="dshell-tagline">haunt your own machine</span>
          </Link>

          <div className="dshell-section">
            <span className="dshell-eyebrow">LOCAL TIME</span>
            <SidebarClock />
          </div>

          <div className="dshell-section">
            <span className="dshell-eyebrow">NAVIGATE</span>
            <nav className="dshell-nav">
              {items.map((it) => {
                const active = isActive(pathname, it.href);
                return (
                  <Link
                    key={it.href}
                    href={it.href}
                    aria-current={active ? "page" : undefined}
                    className={`dshell-link${active ? " is-active" : ""}`}
                  >
                    <span className="dshell-link-icon">
                      <it.Icon size={18} strokeWidth={1.8} aria-hidden />
                    </span>
                    <span className="dshell-link-text">
                      <span className="dshell-link-label">{it.label}</span>
                      {it.sub ? <span className="dshell-link-sub">{it.sub}</span> : null}
                    </span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>

        <div className="dshell-foot">
          <Radio size={13} className="dshell-foot-dot" aria-hidden />
          <span className="dshell-foot-label">ONLINE</span>
        </div>
      </aside>

      <main className="dshell-main">{children}</main>
    </div>
  );
}
