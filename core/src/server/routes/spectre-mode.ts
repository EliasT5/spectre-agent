import { Hono } from "hono";
import { getModel, streamChat } from "@/lib/ai";
import { verifyBrokerToken } from "@/lib/permission/broker";
import { createServiceSupabase } from "@/lib/supabase/server";

export const spectreMode = new Hono();

spectreMode.post("/dispatch", async (c) => {
  if (!verifyBrokerToken(c.req.header("x-spectre-service-token") ?? null)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: {
    model?: unknown;
    prompt?: unknown;
    role?: unknown;
    reason?: unknown;
  } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  const modelId = typeof body.model === "string" ? body.model : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!modelId || !prompt) {
    return c.json({ error: "model and prompt are required strings" }, 400);
  }

  const model = getModel(modelId);
  if (!model) {
    return c.json({ error: `unknown model: ${modelId}` }, 404);
  }
  if (model.provider === "spectre-mode") {
    return c.json({ error: "cannot dispatch to spectre-mode (would recurse)" }, 400);
  }

  // If orchestration_targets is configured, only allow listed model IDs.
  try {
    const supabase = createServiceSupabase();
    const { data: tgtCfg } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "orchestration_targets")
      .maybeSingle();
    if (tgtCfg?.value && typeof tgtCfg.value === "string" && tgtCfg.value.trim() !== "") {
      const allowed = new Set(
        tgtCfg.value.split(",").map((s) => s.trim()).filter(Boolean)
      );
      if (!allowed.has(modelId)) {
        return c.json(
          { error: `dispatch target "${modelId}" is not in orchestration_targets allowlist` },
          403,
        );
      }
    }
  } catch {
    /* config unreadable — proceed without filtering (fail open for availability) */
  }

  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    for await (const chunk of streamChat({
      model,
      // Specialist runs without Jerome's soul - keeps the sub-task focused
      // on what the brain asked for and avoids style bleed across models.
      system: "",
      messages: [{ role: "user", content: prompt }],
      threadId: undefined,
      planMode: false,
    })) {
      if (chunk.type === "token" && chunk.text) text += chunk.text;
      else if (chunk.type === "done") {
        inputTokens = chunk.inputTokens ?? 0;
        outputTokens = chunk.outputTokens ?? 0;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        text: `[dispatch error] ${msg}`,
        model: modelId,
        inputTokens: 0,
        outputTokens: 0,
        error: msg,
      },
      200,
    );
  }

  return c.json({
    text,
    model: modelId,
    role: typeof body.role === "string" ? body.role : null,
    reason: typeof body.reason === "string" ? body.reason : null,
    inputTokens,
    outputTokens,
  });
});
