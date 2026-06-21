"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Device } from "./device";

// The device is resolved once on the server (proxy → request header → root
// layout) and handed to the client through this context, so client components
// pick mobile/desktop variants without re-sniffing or causing hydration drift.

const DeviceContext = createContext<Device>("mobile");

export function DeviceProvider({ value, children }: { value: Device; children: ReactNode }) {
  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>;
}

/** The current shell class (mobile | desktop), resolved from the User-Agent. */
export function useDevice(): Device {
  return useContext(DeviceContext);
}
