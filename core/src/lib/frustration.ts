/**
 * Client-side frustration detector.
 *
 * Inspired by the leaked Claude Code `userPromptKeywords.ts` — detect via
 * regex, not via a model inference call (free, instant). When the user
 * sounds annoyed, we quietly demote the turn to Haiku: it's faster and
 * terser, which tends to de-escalate. We do NOT rewrite the user's
 * message — that erodes trust. Only the model choice changes.
 */

const FRUSTRATION_PATTERNS: RegExp[] = [
  /\b(wtf|fml|ffs|stfu)\b/i,
  /\b(fuck|fucking|shit|shitty|bullshit|damn|damnit|goddamn)\b/i,
  /\b(fucking broken|this is broken|why doesn'?t this work|why isn'?t (this|it) working)\b/i,
  /\b(so frustrating|annoying|ridiculous|useless)\b/i,
  /\b(stop|just stop|no no no|nope nope)\b/i,
  /\b(scheisse|schei[ßs]e|verdammt|blöd|ätzend|nervig|das geht nicht)\b/i,
  /\b(kacke|mist|mistig|kaputt|nicht geht|geht nicht|funktioniert nicht)\b/i,
  /[?!]{3,}/,
];

export function detectsFrustration(text: string): boolean {
  if (!text) return false;
  for (const re of FRUSTRATION_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}
