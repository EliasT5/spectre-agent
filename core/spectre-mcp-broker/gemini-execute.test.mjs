/**
 * Smoke test for gemini.execute pure helpers.
 *
 * Run: node gemini-execute.test.mjs
 *
 * No spawn; we only verify the validation heuristic, the arg builder,
 * and the stream-json line parser. The runner itself is reviewed by
 * code; full e2e is `gemini --version &&` then a real
 * `gemini -o stream-json -p "..."` on the Mini-PC.
 */

import assert from "node:assert/strict";
// FILES_ROOT now defaults to process.cwd(); these fixtures assert against
// /srv/repo paths, so pin it via env BEFORE the module loads (dynamic import).
process.env.SPECTRE_FILES_ROOT = process.env.SPECTRE_FILES_ROOT || "/srv/repo";
const {
  validateImperative,
  validateFiles,
  buildGeminiArgs,
  applyStreamLine,
} = await import("./gemini-execute.mjs");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log("validateImperative:");
t("accepts a clean imperative", () => {
  assert.equal(validateImperative("Translate this paragraph to German.").ok, true);
});
t("accepts 'write' as first verb", () => {
  assert.equal(validateImperative("write me a short summary").ok, true);
});
t("accepts capitalized verb", () => {
  assert.equal(validateImperative("Refactor the parser to use streams").ok, true);
});
t("rejects trailing question mark", () => {
  const r = validateImperative("Write me a summary?");
  assert.equal(r.ok, false);
  assert.match(r.reason, /question/);
});
t("rejects empty", () => {
  assert.equal(validateImperative("").ok, false);
  assert.equal(validateImperative("   ").ok, false);
});
t("rejects open-ended question", () => {
  const r = validateImperative("what do you think about this code");
  assert.equal(r.ok, false);
});
t("accepts long sentence with action token in the middle", () => {
  assert.equal(
    validateImperative("Please carefully translate the following German paragraph into English").ok,
    true
  );
});
t("rejects too-short action mention", () => {
  // "translate it" — has action token but only 2 words, no first-token verb
  // Actually 'translate' IS a VERB_LIKE_FIRST entry, so this should pass.
  // Use something where the action token is later and length is short.
  const r = validateImperative("idea: translate it");
  // 3 words, contains 'translate' but doesn't start with a verb-like token
  assert.equal(r.ok, false);
});

console.log("\nvalidateFiles:");
t("accepts path under /srv/repo", () => {
  const r = validateFiles(["/srv/repo/src/lib/foo.ts"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.abs, ["/srv/repo/src/lib/foo.ts"]);
});
t("rejects path traversal", () => {
  assert.equal(validateFiles(["/srv/repo/../etc/shadow"]).ok, false);
});
t("rejects non-absolute", () => {
  assert.equal(validateFiles(["src/lib/foo.ts"]).ok, false);
});
t("rejects path outside /srv/repo", () => {
  assert.equal(validateFiles(["/etc/shadow"]).ok, false);
});
t("rejects sneaky prefix /srv/repo-evil", () => {
  assert.equal(validateFiles(["/srv/repo-evil/x"]).ok, false);
});

console.log("\nbuildGeminiArgs:");
t("base args without model or files", () => {
  const args = buildGeminiArgs({
    prompt: "do the thing",
    approvalMode: "auto_edit",
    cliModel: null,
    includeDirs: [],
  });
  assert.deepEqual(args, [
    "--skip-trust",
    "-o",
    "stream-json",
    "--approval-mode",
    "auto_edit",
    "-p",
    "do the thing",
  ]);
});
t("includes -m when cliModel set", () => {
  const args = buildGeminiArgs({
    prompt: "x",
    approvalMode: "yolo",
    cliModel: "gemini-2.5-pro",
    includeDirs: [],
  });
  assert.ok(args.includes("-m"));
  assert.ok(args.includes("gemini-2.5-pro"));
});
t("includes --include-directories with comma-list", () => {
  const args = buildGeminiArgs({
    prompt: "x",
    approvalMode: "auto_edit",
    cliModel: null,
    includeDirs: ["/srv/repo/src", "/srv/repo/worker"],
  });
  const idx = args.indexOf("--include-directories");
  assert.ok(idx >= 0);
  assert.equal(args[idx + 1], "/srv/repo/src,/srv/repo/worker");
});

console.log("\napplyStreamLine:");
t("init event is ignored", () => {
  const s = { assistant: "", inputTokens: 0, outputTokens: 0 };
  const next = applyStreamLine(
    `{"type":"init","timestamp":"t","session_id":"s","model":"auto-gemini-3"}`,
    s
  );
  assert.deepEqual(next, s);
});
t("user-echo message is ignored", () => {
  const s = { assistant: "", inputTokens: 0, outputTokens: 0 };
  const next = applyStreamLine(
    `{"type":"message","timestamp":"t","role":"user","content":"hello"}`,
    s
  );
  assert.equal(next.assistant, "");
});
t("assistant message accumulates", () => {
  let s = { assistant: "", inputTokens: 0, outputTokens: 0 };
  s = applyStreamLine(
    `{"type":"message","role":"assistant","content":"Hello "}`,
    s
  );
  s = applyStreamLine(
    `{"type":"message","role":"assistant","content":"world","delta":true}`,
    s
  );
  assert.equal(s.assistant, "Hello world");
});
t("result event captures stats", () => {
  let s = { assistant: "x", inputTokens: 0, outputTokens: 0 };
  s = applyStreamLine(
    `{"type":"result","status":"success","stats":{"input_tokens":42,"output_tokens":7}}`,
    s
  );
  assert.equal(s.inputTokens, 42);
  assert.equal(s.outputTokens, 7);
  assert.equal(s.assistant, "x");
});
t("garbage line is ignored", () => {
  const s = { assistant: "x", inputTokens: 0, outputTokens: 0 };
  assert.deepEqual(applyStreamLine("not json", s), s);
  assert.deepEqual(applyStreamLine("", s), s);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
