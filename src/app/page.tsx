"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { HoloClock } from "@/components/HoloClock";
import { SpectrePlaque } from "@/components/SpectrePlaque";

// The blob is a heavy client-only WebGL scene — load it without SSR.
const BlobScene = dynamic(
  () => import("@/components/blob/BlobScene").then((m) => m.BlobScene),
  { ssr: false },
);

// Spectre's dry voice (matches the kiosk).
function greetingForHour(h: number): string {
  if (h >= 5 && h <= 11) return "Good morning, sir.";
  if (h >= 12 && h <= 17) return "A productive afternoon, sir.";
  if (h >= 18 && h <= 22) return "Evening's here.";
  if (h === 23 || h === 0 || h === 1) return "Up late, sir.";
  return "Burning the candle.";
}

export default function Home() {
  const [greeting, setGreeting] = useState("");
  useEffect(() => {
    const tick = () => setGreeting(greetingForHour(new Date().getHours()));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <main style={{ position: "fixed", inset: 0, overflow: "hidden" }}>
      <BlobScene />
      {/* Top-center: holographic clock → greeting. Never blocks slot clicks. */}
      <div className="home-stack" aria-hidden>
        <HoloClock />
        {greeting && <div className="holo-greet holo-scan">{greeting}</div>}
      </div>
      <SpectrePlaque />
    </main>
  );
}
