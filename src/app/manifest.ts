import type { MetadataRoute } from "next";

/**
 * PWA manifest — makes the shell installable ("Add to Home Screen") as a
 * standalone, full-screen mobile webapp. It's the SAME shell as desktop, just
 * mobile-adjusted (responsive) and installable. Served at /manifest.webmanifest;
 * the auth gate (proxy.ts) lets it + the icons through pre-login so the install
 * prompt works before the PIN.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Spectre",
    short_name: "Spectre",
    description: "Your self-hosted AI assistant.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#050507",
    theme_color: "#050507",
    categories: ["productivity", "utilities"],
    icons: [
      { src: "/icons/192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
