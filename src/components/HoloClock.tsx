"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

/**
 * The kiosk's holographic clock — big mono HH:MM, RGB-split cyan/violet glow,
 * scanline + flicker (via .holo-clock/.holo-scan in globals). Each digit is its
 * own AnimatePresence keyed on the character, so a minute tick fades-and-lifts
 * just the digits that changed. Lifted from Spectre's home so the shell's home
 * matches the real thing.
 */
function HoloDigit({ char }: { char: string }) {
  return (
    <span style={{ display: "inline-block", width: char === ":" ? "0.5ch" : "1ch", textAlign: "center" }}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={char}
          initial={{ opacity: 0, y: -12, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: 12, filter: "blur(6px)" }}
          transition={{ duration: 0.32, ease: [0.25, 0.1, 0.25, 1] }}
          style={{ display: "inline-block" }}
        >
          {char}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function HoloClock() {
  const [time, setTime] = useState("");
  useEffect(() => {
    const update = () => {
      const d = new Date();
      setTime(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!time) return null;
  return (
    <div className="holo-clock holo-scan">
      {time.split("").map((c, i) => (
        <HoloDigit key={i} char={c} />
      ))}
    </div>
  );
}
