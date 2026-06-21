/**
 * Cheap, dependency-free token estimation for context budgeting.
 *
 * ~4 characters per token is a solid conservative heuristic for English/code
 * without pulling in a tokenizer dependency. It only needs to be good enough to
 * keep us comfortably UNDER a model's context window (we add a margin), not exact.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
