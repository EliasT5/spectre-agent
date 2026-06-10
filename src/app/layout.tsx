import type { Metadata, Viewport } from "next";
import { Inter, Outfit, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { RouteAtmosphere } from "@/components/atmosphere/RouteAtmosphere";
import { ModuleOpenPrompt } from "@/components/ModuleOpenPrompt";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";

// Spectre's exact type system: Outfit (display/headings), Inter (body),
// JetBrains Mono (data). Self-hosted via next/font, exposed under the same
// CSS variable names the monolith uses so the shell reads as the same product.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit", display: "swap" });
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Spectre",
  description: "Spectre — your self-hosted AI assistant",
  applicationName: "Spectre",
  // manifest.ts is auto-linked by Next; named here too for older crawlers.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Spectre",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Let the app paint under the notch / home indicator; globals.css uses the
  // safe-area insets so nothing important hides behind them.
  viewportFit: "cover",
  themeColor: "#050507",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${outfit.variable} ${jetbrains.variable}`}>
      <body>
        <div className="noise-layer" aria-hidden />
        <RouteAtmosphere />
        {children}
        <ModuleOpenPrompt />
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
