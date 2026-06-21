/**
 * Heartbeat — periodic autonomous task runner.
 *
 * Reads HEARTBEAT.md for schedule config, then runs agent turns
 * at the configured interval. Each beat is an isolated context
 * that can check health, consolidate memory, or surface alerts.
 */

import { quickComplete, detectProviders, getAvailableProviders } from "./providers";
import { readFileSync } from "fs";
import { join } from "path";

export interface HeartbeatResult {
  status: "ok" | "alert";
  message: string;
  timestamp: string;
}

/**
 * Run a single heartbeat cycle.
 * Returns HEARTBEAT_OK or an alert message.
 */
export async function runHeartbeat(): Promise<HeartbeatResult> {
  const timestamp = new Date().toISOString();

  try {
    // Refresh provider detection
    await detectProviders();
    const providers = getAvailableProviders();

    if (providers.length === 0) {
      return {
        status: "alert",
        message: "No AI providers available. Check API keys.",
        timestamp,
      };
    }

    // Read heartbeat config for context
    const root = process.env.SPECTRE_REPO_PATH || process.cwd();
    let heartbeatConfig = "";
    try {
      heartbeatConfig = readFileSync(join(root, "soul", "HEARTBEAT.md"), "utf-8");
    } catch {
      // No heartbeat config, that's fine
    }

    const healthPrompt = `You are Jerome's heartbeat system. Run a quick status check.

Available providers: ${providers.join(", ")}
Current time: ${timestamp}

${heartbeatConfig ? `Heartbeat config:\n${heartbeatConfig}` : ""}

Respond with either:
- "HEARTBEAT_OK" if everything looks fine
- A brief alert message if something needs attention

Keep response under 100 words.`;

    const response = await quickComplete(healthPrompt);

    if (response.includes("HEARTBEAT_OK")) {
      return { status: "ok", message: "HEARTBEAT_OK", timestamp };
    }

    return { status: "alert", message: response, timestamp };
  } catch (err) {
    return {
      status: "alert",
      message: `Heartbeat error: ${err instanceof Error ? err.message : "Unknown"}`,
      timestamp,
    };
  }
}
