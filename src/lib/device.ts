// Device class for the two-shell UI. Pure + dependency-free so it is safe to
// import from the edge proxy (middleware), server components, and the client.
//
// One app serves both shells; this decides which, purely from the User-Agent.
// Phones get the mobile shell; tablets and desktops get the desktop shell.

export type Device = "mobile" | "desktop";

/** Request header the proxy sets so server components know the device on first paint. */
export const DEVICE_HEADER = "x-spectre-device";

/** Classify a User-Agent string. Conservative: only true phones are "mobile". */
export function deviceFromUA(ua: string): Device {
  const s = ua || "";
  const phone =
    /iPhone|iPod|Windows Phone|BlackBerry|Mobi/i.test(s) ||
    (/Android/i.test(s) && /Mobile/i.test(s));
  return phone ? "mobile" : "desktop";
}

/** Narrow an arbitrary string (cookie value / header) to a Device, or null. */
export function asDevice(v: string | null | undefined): Device | null {
  return v === "mobile" || v === "desktop" ? v : null;
}
