/**
 * Design-token bridge for the Code-mode sandbox.
 *
 * A Code-mode module runs inside an OPAQUE-origin sandboxed iframe (its own
 * document, no access to the shell's stylesheet). To make it read as the same
 * product, the parent reads the live computed value of every `:root` custom
 * property here and posts the snapshot into the frame, which writes them onto its
 * OWN `:root`. SPECTRE_TOKENS is the exact list of properties declared in
 * globals.css `:root` — keep the two in lockstep.
 *
 * This is the ONLY thing that crosses from shell theme → frame: plain strings
 * (resolved CSS values), never code, never the stylesheet itself.
 */

export const SPECTRE_TOKENS: string[] = [
  // Base surfaces
  "--color-bg",
  "--color-bg-alt",
  "--color-surface",
  "--color-surface-hover",
  "--color-surface-elevated",
  // Text
  "--color-text",
  "--color-text-secondary",
  "--color-text-muted",
  // Accent
  "--color-accent",
  "--color-accent-hover",
  "--color-accent-deep",
  // Hairlines
  "--color-border",
  "--color-border-hover",
  // Gradient stops
  "--grad-start",
  "--grad-mid",
  "--grad-end",
  "--grad-accent",
  // Glows
  "--glow-primary",
  "--glow-secondary",
  "--glow-pink",
  // Semantic
  "--color-error",
  "--color-success",
  "--color-warn",
  // Aliases used across the shell's component CSS
  "--void",
  "--abyss",
  "--glass",
  "--glass-2",
  "--hairline",
  "--hairline-2",
  "--edge-hi",
  "--ink",
  "--ink-2",
  "--ink-3",
  "--ink-faint",
  "--accent",
  "--accent-bright",
  "--accent-deep",
  "--magenta",
  "--danger",
  // Composite shadows / rings
  "--glow",
  "--glow-sm",
  "--glow-soft",
  "--inset-hi",
  "--ring-hi",
  // Radii + motion
  "--r-sm",
  "--r",
  "--r-lg",
  "--pill",
  "--ease",
  "--ease-out",
  // Type
  "--font-display",
  "--font-body",
  "--font-mono",
];

/**
 * Read the live computed value of every SPECTRE token off the document root.
 * SSR/no-DOM safe (returns {} when there's no window). Empty values are skipped
 * so the frame falls back to its own defaults for anything unset.
 */
export function readTokens(): Record<string, string> {
  if (typeof window === "undefined" || typeof document === "undefined") return {};
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const name of SPECTRE_TOKENS) {
    const v = cs.getPropertyValue(name).trim();
    if (v) out[name] = v;
  }
  return out;
}
