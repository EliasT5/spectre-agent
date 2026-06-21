"use client";

import { TabShell } from "@/components/ui";
import { SchedulesPanel } from "@/components/tempus/SchedulesPanel";

/**
 * Tempus → Routines. Recurring AI tasks, built on Spectre's durable scheduler.
 * Reached from the Tempus tab's "Routines" action; renders the shared
 * SchedulesPanel (describe-a-schedule chat + the live schedule list).
 */
export default function TempusRoutinesPage() {
  return (
    <TabShell title="Routines" eyebrow="TEMPUS" status="recurring AI tasks">
      <SchedulesPanel />
    </TabShell>
  );
}
