/* Shared chat-tab types (kept out of page.tsx so the sheet components can import
   them without reaching into the page module). */

export type ThreadMeta = { pdf_ids?: string[]; kind?: string };

export type Thread = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  archived?: boolean;
  project_id?: string | null;
  metadata?: ThreadMeta;
  model_hint?: string | null;
  reasoning_effort?: string | null;
};

/** A "category" is a row in the `projects` table. `description` is the user's
    "what belongs here" text — stored for a future auto-classifier. */
export type Category = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  active?: boolean;
  created_at?: string;
};

/** The 6 category swatches — derived from the accent/gradient family so dots
    stay legible on the near-black void (DESIGN.md). */
export const CAT_SWATCHES = ["#6366f1", "#a855f7", "#ec4899", "#f59e0b", "#10b981", "#38bdf8"];
export const CAT_DEFAULT_COLOR = CAT_SWATCHES[0];
