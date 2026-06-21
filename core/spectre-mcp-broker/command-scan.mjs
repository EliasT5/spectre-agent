/**
 * Pre-execution scanner for the bash tool — a lightweight Tirith-style gate.
 * Defense-in-depth ABOVE the human approval gate, not a sandbox substitute:
 * bash is Turing-complete, so a determined injection can dodge regexes. The
 * point is to stop the catastrophic-but-common shapes cold and to force a
 * human look at the suspicious ones, even when a mode would auto-approve.
 *
 * Verdicts:
 *   block — catastrophic/irreversible; never run, not even with approval
 *           (the human is one fatigued click away from a wiped disk).
 *   flag  — suspicious; ALWAYS require interactive human approval, even in
 *           workshop auto-approve mode, with the matched reason shown.
 *   ok    — normal approval flow.
 */

/** Collapse whitespace so spacing tricks ("rm   -rf") don't dodge the regexes. */
export function normalize(command) {
  return command.replace(/\s+/g, " ").trim();
}

const BLOCK = [
  [/\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/(\s|$)|\/\*|\$home\b|~\/?(\s|$)|\/etc\b|\/usr\b|\/var\b|\/boot\b|c:\\)/i, "recursive delete of a system root"],
  [/\bmkfs(\.|\s)/i, "filesystem format"],
  [/\bdd\s+[^|;&]*\bof=\/dev\//i, "raw write to a block device"],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, "fork bomb"],
  [/\b(shutdown|reboot|halt|poweroff)\b/i, "host power control"],
  [/>\s*\/dev\/sd[a-z]/i, "redirect onto a block device"],
  [/\bchmod\s+(-[a-z]+\s+)*777\s+\/(\s|$)/i, "chmod 777 on /"],
];

const FLAG = [
  [/\b(curl|wget)\b[^|;&]*\|\s*(ba|z|da)?sh\b/i, "pipes a remote script into a shell"],
  [/\bbase64\b[^|;&]*\|\s*(ba|z|da)?sh\b/i, "decodes base64 into a shell"],
  [/\beval\s+["'`$]/i, "eval of dynamic content"],
  [/\bnc\b[^|;&]*\s-e\s/i, "netcat with -e (reverse-shell shape)"],
  [/(^|[\s/])\.ssh\b|\.aws\/credentials|\/etc\/(passwd|shadow)\b|\.env(\.|\b)/i, "touches credential/secret paths"],
  [/\bgit\s+push\s+[^|;&]*(--force\b|-f\b)/i, "force push"],
  [/\brm\s+-[a-z]*r/i, "recursive delete"],
  [/\b(crontab|systemctl|launchctl)\b/i, "modifies system services/schedules"],
  [/\bcurl\b[^|;&]*\s(-d|--data\S*|--upload-file|-T|-F)\s/i, "uploads data to a remote host"],
];

/** @returns {{ verdict: "block" | "flag" | "ok", reason?: string }} */
export function scanCommand(command) {
  const norm = normalize(command);
  for (const [re, why] of BLOCK) {
    if (re.test(norm)) return { verdict: "block", reason: why };
  }
  for (const [re, why] of FLAG) {
    if (re.test(norm)) return { verdict: "flag", reason: why };
  }
  return { verdict: "ok" };
}
