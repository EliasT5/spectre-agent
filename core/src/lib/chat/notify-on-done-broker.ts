/**
 * In-process flag keyed by threadId — set by POST /api/threads/{id}/notify-on-done,
 * consumed by the messages route on the `done` event so the server can fire a
 * Web Push notification only for streams the user explicitly armed.
 *
 * Process-local (Map) — fine because Jerome runs as a single Next.js node
 * process. Multi-instance deploys would need to move this into the DB or
 * Redis; we don't have either constraint yet.
 */
const armed = new Set<string>();

export function armNotifyOnDone(threadId: string): void {
  armed.add(threadId);
}

export function isNotifyOnDoneArmed(threadId: string): boolean {
  return armed.has(threadId);
}

/** True if the flag was set; clears the flag as part of the read so a
 *  subsequent stream on the same thread doesn't reuse it. */
export function consumeNotifyOnDone(threadId: string): boolean {
  return armed.delete(threadId);
}

export function disarmNotifyOnDone(threadId: string): void {
  armed.delete(threadId);
}
