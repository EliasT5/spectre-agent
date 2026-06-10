"use client";

import { useEffect, useState } from "react";
import { TabShell } from "@/components/ui";
import { Segmented } from "@/components/tempus/controls";
import { TimePanel } from "@/components/tempus/TimePanel";
import { SchedulesPanel } from "@/components/tempus/SchedulesPanel";
import { ActivityPanel } from "@/components/tempus/ActivityPanel";
import { tempusApi, formatDuration, elapsedMs, type TempusTimer } from "@/lib/tempus";

type Section = "time" | "schedules" | "activity";

export default function TempusTab() {
  const [section, setSection] = useState<Section>("time");
  const [timer, setTimer] = useState<TempusTimer>({ active: false });
  const [, tick] = useState(0);

  // Light timer poll so a running session shows in the header on any section.
  useEffect(() => {
    let alive = true;
    const load = () =>
      tempusApi
        .getTimer()
        .then((t) => {
          if (alive) setTimer(t);
        })
        .catch(() => {});
    load();
    const poll = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    if (!timer.active) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [timer.active]);

  const status = timer.active ? `${timer.project.name} · ${formatDuration(elapsedMs(timer))}` : "idle";

  return (
    <TabShell eyebrow="MODULE · TEMPUS" title="Tempus" status={status} tone={timer.active ? "ok" : undefined}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
        <Segmented<Section>
          value={section}
          options={[
            { value: "time", label: "Time" },
            { value: "schedules", label: "Schedules" },
            { value: "activity", label: "Activity" },
          ]}
          onChange={setSection}
        />
      </div>
      {section === "time" && <TimePanel onTimer={setTimer} />}
      {section === "schedules" && <SchedulesPanel />}
      {section === "activity" && <ActivityPanel />}
    </TabShell>
  );
}
