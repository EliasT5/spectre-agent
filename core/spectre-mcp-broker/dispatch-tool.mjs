import { z } from "zod";

/**
 * Register Jerome Mode's model dispatch tool on any MCP server.
 *
 * Keeping this separate lets the regular `jerome` broker expose all normal
 * tools plus dispatch_to_model in Jerome Mode. That avoids Claude Code's
 * deferred ToolSearch only surfacing the smaller spectre_mode server.
 */
export function registerDispatchToModel(server) {
  const APP_URL = process.env.SPECTRE_APP_URL || "http://127.0.0.1:3000";
  const TOKEN = process.env.SPECTRE_SERVICE_TOKEN || "";
  const CORE_TOKEN = process.env.CORE_TOKEN || "";
  const THREAD_ID = process.env.SPECTRE_THREAD_ID || "";

  server.registerTool(
    "dispatch_to_model",
    {
      description:
        "Dispatch a self-contained sub-task to a specialist AI model and return its response. Use this when a different model fits a sub-task better; do not use it for direct MCP capabilities such as image generation.",
      inputSchema: {
        model: z
          .string()
          .describe(
            "Specialist model id. Valid: claude-code-haiku, claude-code-sonnet, claude-code-opus, gemini-cli-flash, gemini-cli-pro, gemini-cli-auto, codex-cli-mini, codex-cli-gpt55, codex-cli-codex."
          ),
        prompt: z
          .string()
          .describe(
            "The full sub-prompt for the specialist. MUST be self-contained; embed every piece of context the specialist needs."
          ),
        role: z
          .string()
          .optional()
          .describe(
            "Short role label, e.g. research, verify, code, summary. Surfaces in the tool chip in the chat UI."
          ),
        reason: z
          .string()
          .optional()
          .describe("One-line reason for choosing this specific model."),
      },
    },
    async ({ model, prompt, role, reason }) => {
      try {
        const res = await fetch(`${APP_URL}/api/spectre-mode/dispatch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(TOKEN ? { "X-Spectre-Service-Token": TOKEN } : {}),
            ...(CORE_TOKEN ? { "x-spectre-core-token": CORE_TOKEN } : {}),
            "x-thread-id": THREAD_ID,
          },
          body: JSON.stringify({ model, prompt, role, reason }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `dispatch_to_model failed: ${res.status} ${data.error ?? ""}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                typeof data.text === "string" && data.text.length > 0
                  ? data.text
                  : "(specialist returned empty output)",
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            { type: "text", text: `dispatch_to_model error: ${err.message}` },
          ],
        };
      }
    }
  );
}
