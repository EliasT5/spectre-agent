// Per-routine persistent state list, mediated by the scheduler.
//
// A scheduled "Routine" can carry a small list across its one-shot runs
// (blacklist, whitelist, notes, reminders, todos, ...). The scheduler:
//   1. injects the current list + an instruction block into the run prompt
//      (buildListBlock), and
//   2. after the run, parses a trailing ```routine-ops``` JSON block from the
//      assistant output (parseRoutineOps) and folds it into the stored list
//      (applyOps).
//
// Plain ESM so worker/scheduler.mjs (run directly by node) can import it.

// Hard cap so the injected list can never blow up the prompt. Oldest items
// fall off first.
export const LIST_CAP = 500;

const KIND_FRAMING = {
  blacklist:
    "Items you have ALREADY used/reported. Do NOT repeat any of them. Add the new items you used this run.",
  whitelist:
    "The approved set to focus on. Prefer these; add genuinely new approved items.",
  notes: "Notes you have kept across runs. Update them as things change.",
  reminders: "Standing reminders to keep in mind. Add/remove as needed.",
  todos:
    "Open to-dos carried across runs. Remove an item when it is done; add newly discovered ones.",
};

function framingFor(kind) {
  return KIND_FRAMING[kind] || "Your saved list, carried across runs.";
}

/**
 * Build the prompt block injected before each run. Returns "" when there is
 * no list for this routine.
 * @param {string|null|undefined} kind
 * @param {string[]|null|undefined} items
 */
export function buildListBlock(kind, items) {
  if (!kind) return "";
  const list = Array.isArray(items) ? items : [];
  const rendered = list.length
    ? list.map((i) => `- ${i}`).join("\n")
    : "(empty so far)";
  const label = kind.toUpperCase();
  return [
    `## Your persistent ${label} (carried across runs)`,
    framingFor(kind),
    "",
    rendered,
    "",
    "When you finish, emit a fenced code block tagged `routine-ops` containing",
    "JSON of the changes to this list — nothing else inside it:",
    "```routine-ops",
    '{"add": ["new item 1", "new item 2"], "remove": ["item to drop"]}',
    "```",
    "Use the exact item text when removing. Omit the block (or use empty",
    "arrays) if nothing changed.",
  ].join("\n");
}

/**
 * Parse the LAST ```routine-ops``` block from assistant output.
 * Returns { add: string[], remove: string[] } or null if absent/unparseable.
 * @param {string} output
 */
export function parseRoutineOps(output) {
  if (!output || typeof output !== "string") return null;
  const re = /```routine-ops\s*([\s\S]*?)```/gi;
  let match;
  let last = null;
  while ((match = re.exec(output)) !== null) last = match[1];
  if (last == null) return null;
  try {
    const parsed = JSON.parse(last.trim());
    const norm = (v) =>
      Array.isArray(v)
        ? v.map((x) => String(x).trim()).filter((x) => x.length > 0)
        : [];
    return { add: norm(parsed.add), remove: norm(parsed.remove) };
  } catch {
    return null;
  }
}

/**
 * Apply add/remove ops to the current list. Dedupes (case-insensitive),
 * removes by exact (trimmed, case-insensitive) match, and caps to LIST_CAP
 * keeping the most recent items.
 * @param {string[]|null|undefined} current
 * @param {{add: string[], remove: string[]}|null} ops
 */
export function applyOps(current, ops) {
  let items = Array.isArray(current) ? current.slice() : [];
  if (!ops) return items;

  if (ops.remove?.length) {
    const drop = new Set(ops.remove.map((x) => x.trim().toLowerCase()));
    items = items.filter((i) => !drop.has(String(i).trim().toLowerCase()));
  }
  if (ops.add?.length) {
    const have = new Set(items.map((i) => String(i).trim().toLowerCase()));
    for (const a of ops.add) {
      const key = a.trim().toLowerCase();
      if (!have.has(key)) {
        items.push(a);
        have.add(key);
      }
    }
  }
  if (items.length > LIST_CAP) items = items.slice(items.length - LIST_CAP);
  return items;
}
