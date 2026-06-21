/**
 * Thread-scoped abort registry — provider-agnostic cancellation.
 *
 * The durable-turn runner (src/app/api/threads/[threadId]/run/route.ts) polls the
 * message row for status='cancelled' and, on Stop, must kill whatever is running
 * the brain. The claude-code provider has its own process registry
 * (abortClaudeForThread), but the provider-agnostic LiteLLM loop has no
 * subprocess to SIGKILL — it holds an AbortController + an MCP client. This
 * registry lets ANY provider register a teardown fn keyed by threadId so the run
 * route can fire one call (abortThread) and stop them all, without the route
 * needing to know which provider ran.
 *
 * Multiple teardowns can register for one thread (e.g. a stream controller +
 * the broker client close); abortThread runs all of them. Each register()
 * returns an unregister fn the provider MUST call in its finally block so a
 * completed turn doesn't leave a stale teardown that a later Stop would fire.
 */

const registry = new Map<string, Set<() => void>>();

/**
 * Register a teardown for a thread. Returns an unregister fn — call it when the
 * turn finishes (finally block) so the entry doesn't leak.
 */
export function registerAbort(threadId: string, teardown: () => void): () => void {
  let set = registry.get(threadId);
  if (!set) {
    set = new Set();
    registry.set(threadId, set);
  }
  set.add(teardown);
  return () => {
    const s = registry.get(threadId);
    if (!s) return;
    s.delete(teardown);
    if (s.size === 0) registry.delete(threadId);
  };
}

/**
 * Abort every registered teardown for a thread. Returns true if anything was
 * registered. Safe to call alongside abortClaudeForThread — they cover
 * different providers and both are no-ops when their provider isn't running.
 */
export function abortThread(threadId: string): boolean {
  const set = registry.get(threadId);
  if (!set || set.size === 0) return false;
  for (const teardown of set) {
    try {
      teardown();
    } catch {
      /* a failing teardown must not block the others */
    }
  }
  registry.delete(threadId);
  return true;
}
