import { Hono } from "hono";
import { runProactiveBoundedRun } from "@/lib/ai/proactive";

export const proactive = new Hono();

proactive.post("/bounded-run", async (c) => {
  const result = await runProactiveBoundedRun();
  return c.json(result);
});
