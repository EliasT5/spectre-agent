import { ImageResponse } from "next/og";
import { spectreMark } from "@/lib/pwa-mark";

/**
 * PWA manifest icons, generated from the shared mark (no image deps). Pre-rendered
 * at build for the three names the manifest references; anything else 404s.
 *   /icons/192.png  /icons/512.png  /icons/maskable.png
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ icon: "192.png" }, { icon: "512.png" }, { icon: "maskable.png" }];
}

export async function GET(_req: Request, { params }: { params: Promise<{ icon: string }> }) {
  const { icon } = await params;
  const maskable = icon.startsWith("maskable");
  const size = maskable ? 512 : parseInt(icon, 10) || 512;
  return new ImageResponse(spectreMark({ size, safe: maskable }), {
    width: size,
    height: size,
    headers: { "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
