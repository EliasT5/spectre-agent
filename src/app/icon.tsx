import { ImageResponse } from "next/og";
import { spectreMark } from "@/lib/pwa-mark";

// Favicon / browser-tab icon, generated from the shared Spectre mark.
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(spectreMark({ size: 64 }), { ...size });
}
