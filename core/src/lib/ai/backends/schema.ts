/**
 * ModelBackend — the manifest contract for a user-taught, modular model backend.
 *
 * A backend has one KIND (how Spectre talks to it) and one or more ROLES (how you
 * use it):
 *   - kind "api"          → a provider registered on the LiteLLM gateway (endpoint
 *                           type + key + endpoint). Full agentic brain.
 *   - kind "cli-server"   → a command that launches an OpenAI-compatible server;
 *                           Spectre supervises it and points LiteLLM at it. Full
 *                           agentic brain.
 *   - kind "cli-command"  → a raw command + flags. Roles: `brain` (chat-only, via
 *                           the cli-text streamer) and/or `dispatch` (a tool the
 *                           mcp-broker exposes so an agentic brain can dispatch to
 *                           it mid-turn).
 *
 * This file owns the canonical `ModelBackend` type AND the zod validator, mirroring
 * `core/src/lib/modules/manifest.ts`. Secrets (api keys) are NEVER stored here —
 * they go to LiteLLM's own encrypted store; see registry.ts / providers.ts.
 */
import { z } from "zod";

/** Which LiteLLM provider-prefix an api backend routes through. */
export const ENDPOINT_TYPES = [
  "openai",
  "anthropic",
  "gemini",
  "azure",
  "openai-compatible",
] as const;
export type EndpointType = (typeof ENDPOINT_TYPES)[number];

export const BACKEND_KINDS = ["api", "cli-server", "cli-command"] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

const rolesSchema = z
  .object({
    /** Appears in the model dropdown; you chat with it directly. */
    brain: z.boolean().default(true),
    /** Registered as an mcp-broker tool an agentic brain can dispatch to. */
    dispatch: z.boolean().default(true),
  })
  .passthrough();

export const ModelBackendSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** stable slug, unique across backends */
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
    kind: z.enum(BACKEND_KINDS),
    label: z.string().min(1),
    enabled: z.boolean().default(true),
    /** roles apply to cli-command; api/cli-server are always brains. */
    roles: rolesSchema.default({ brain: true, dispatch: true }),
    createdAt: z.string().optional(),

    // ── kind "api" ──────────────────────────────────────────────
    endpointType: z.enum(ENDPOINT_TYPES).optional(),
    /** the friendly id Spectre requests == LiteLLM model_name == route() hint */
    modelName: z.string().optional(),
    /** bare provider model, e.g. "claude-sonnet-4-6" / an azure deployment name */
    providerModel: z.string().optional(),
    apiBase: z.string().optional(),
    apiVersion: z.string().optional(), // azure only
    /** id returned by LiteLLM /model/new, needed for /model/delete */
    litellmModelId: z.string().optional(),

    // ── kind "cli-server" ───────────────────────────────────────
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    port: z.number().int().optional(),
    servedModelName: z.string().optional(),
    healthPath: z.string().default("/v1/models"),
    restartPolicy: z.enum(["always", "on-failure", "never"]).default("on-failure"),
    /** false = register-only against host.docker.internal (Docker default). */
    managed: z.boolean().default(false),

    // ── kind "cli-command" ──────────────────────────────────────
    /** value interpolated for the CLI's `--model`-style flag ({model} in args). */
    model: z.string().optional(),
    promptMode: z.enum(["stdin", "arg", "positional"]).default("stdin"),
    promptFlag: z.string().optional(), // when promptMode="arg"
    outputMode: z.enum(["stdout", "json"]).default("stdout"),
    outputJsonPath: z.string().optional(), // dot-path when outputMode="json"
    timeoutMs: z.number().int().positive().default(300_000),
    contextWindow: z.number().int().positive().optional(),
  })
  .passthrough()
  .superRefine((b, ctx) => {
    if (b.kind === "api") {
      if (!b.endpointType) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "api backend requires endpointType", path: ["endpointType"] });
      if (!b.providerModel) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "api backend requires providerModel", path: ["providerModel"] });
      if ((b.endpointType === "azure" || b.endpointType === "openai-compatible") && !b.apiBase)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${b.endpointType} requires apiBase`, path: ["apiBase"] });
    }
    if (b.kind === "cli-server" || b.kind === "cli-command") {
      if (!b.command) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${b.kind} requires command`, path: ["command"] });
    }
    if (b.kind === "cli-command" && !b.roles.brain && !b.roles.dispatch) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cli-command requires at least one role (brain and/or dispatch)", path: ["roles"] });
    }
  });

/** The canonical backend type — inferred so type & validator cannot drift. */
export type ModelBackend = z.infer<typeof ModelBackendSchema>;

/** Validate a raw backend object (install-time gate). */
export function validateBackend(
  raw: unknown,
): { ok: true; backend: ModelBackend } | { ok: false; errors: string[] } {
  const parsed = ModelBackendSchema.safeParse(raw);
  if (parsed.success) return { ok: true, backend: parsed.data };
  const errors = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return { ok: false, errors };
}
