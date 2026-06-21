import { Hono } from "hono";
import { listPending } from "@/lib/permission/broker";

// Port of src/app/api/permission/pending/route.ts — in-flight permission requests
// across all threads (the kiosk diagnostic rail reads this).
export const permission = new Hono();

permission.get("/pending", (c) => c.json({ items: listPending() }));
