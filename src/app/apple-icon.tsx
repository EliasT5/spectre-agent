import { ImageResponse } from "next/og";
import { spectreMark } from "@/lib/pwa-mark";

// Apple touch icon (home-screen on iOS). Opaque background — iOS masks the
// corners itself, so the icon must not be transparent.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(spectreMark({ size: 180 }), { ...size });
}
