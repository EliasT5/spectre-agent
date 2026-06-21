#!/usr/bin/env node
/**
 * spectre-mode-broker
 *
 * MCP server (stdio) that exposes a single tool: dispatch_to_model.
 * Spawned by claude-code when running under Jerome Mode. The brain is
 * disallowed all other built-in tools (Bash/Edit/Write/etc), so this is
 * its only capability — route work to specialist models.
 *
 * The tool POSTs to Jerome\'s own HTTP endpoint, which runs the
 * specialist via streamChat and returns the concatenated text response.
 * Auth is via the shared SPECTRE_SERVICE_TOKEN.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerOpenAITools } from "./openai-tools.mjs";

const APP_URL = process.env.SPECTRE_APP_URL || "http://127.0.0.1:3000";
const TOKEN = process.env.SPECTRE_SERVICE_TOKEN || "";
const THREAD_ID = process.env.SPECTRE_THREAD_ID || "";

const server = new McpServer(
  { name: "spectre_mode", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.registerTool(
  "tools.list",
  {
    description:
      "List tools available to the Spectre Mode brain. Use before saying a capability is unavailable.",
    inputSchema: {
      category: z
        .string()
        .optional()
        .describe("Optional category filter, e.g. orchestration or generation"),
    },
  },
  async ({ category } = {}) => {
    const tools = [
      {
        category: "orchestration",
        name: "dispatch_to_model",
        visible: "mcp__spectre_mode__dispatch_to_model",
        description: "Dispatch a self-contained text/reasoning sub-task to a specialist model.",
      },
      {
        category: "generation",
        name: "openai.image",
        visible: "mcp__spectre_mode__openai_image",
        description: "Generate an image and return a /generated URL.",
      },
      {
        category: "generation",
        name: "openai.chat",
        visible: "mcp__spectre_mode__openai_chat",
        description: "Run a GPT text sub-task through Codex CLI.",
      },
    ].filter((tool) => !category || tool.category === category);
    const text = tools
      .map((tool) => `- ${tool.name} (${tool.visible}): ${tool.description}`)
      .join("\n");
    return { content: [{ type: "text", text: text || "(no matching tools)" }] };
  }
);

server.registerTool(
  "dispatch_to_model",
  {
    description:
      "Dispatch a self-contained sub-task to a specialist AI model and return its response. Use this when a different model fits a sub-task better — e.g. Gemini 3 Pro for long-context research, Codex for heavy coding, Sonnet for verification, Haiku for short summaries.",
    inputSchema: {
      model: z
        .string()
        .describe(
          "Specialist model id. Valid: claude-code-haiku, claude-code-sonnet, claude-code-opus, gemini-cli-flash, gemini-cli-pro, gemini-cli-auto, codex-cli-mini, codex-cli-gpt55, codex-cli-codex."
        ),
      prompt: z
        .string()
        .describe(
          "The full sub-prompt for the specialist. MUST be self-contained — embed every piece of context the specialist needs (the user's message, prior tool outputs, file contents). The specialist sees nothing else."
        ),
      role: z
        .string()
        .optional()
        .describe(
          "Short role label, e.g. \"research\", \"verify\", \"code\", \"summary\". Surfaces in the tool chip in the chat UI."
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
          // Same auth header the regular spectre-mcp-broker uses, so the
          // dispatch endpoint can reuse verifyBrokerToken().
          ...(TOKEN ? { "X-Spectre-Service-Token": TOKEN } : {}),
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

// Expose image generation directly inside Jerome Mode. Claude Code's
// deferred ToolSearch may only surface tools from the spectre_mode server while
// the brain is orchestrating, so image generation must not depend on the
// separate regular `jerome` broker being visible.
registerOpenAITools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
