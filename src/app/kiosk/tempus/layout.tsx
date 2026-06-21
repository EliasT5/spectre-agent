import { TabShell } from "@/components/ui";
import { TempusNav } from "@/components/tempus/TempusNav";

/**
 * The full ("kiosk") Tempus suite — Dashboard / Projects / Entries / Routines.
 * Reached from the Tempus tab's "Open full Tempus" action. The shared TabShell
 * chrome + sub-nav persists across the four sub-routes; each page swaps in its
 * own client view.
 */
export default function KioskTempusLayout({ children }: { children: React.ReactNode }) {
  return (
    <TabShell title="Tempus" eyebrow="TIME TRACKING" status="full view">
      <TempusNav />
      {children}
    </TabShell>
  );
}
