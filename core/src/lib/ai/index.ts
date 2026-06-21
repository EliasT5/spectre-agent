/**
 * Jerome AI — public API
 *
 * Usage:
 *   import { route, streamChat, quickComplete, detectProviders } from "@/lib/ai";
 */

export { MODEL_CATALOG, getModel, type ModelDef, type Provider, type Capability } from "./models";
export { detectProviders, getAvailableProviders, isProviderAvailable, streamChat, quickComplete, type ChatMessage, type StreamChunk, type StreamOptions } from "./providers";
export { route, classifyIntent, type Intent, type RouteResult } from "./router";
export { buildSystemPrompt, loadSoul, type SoulContext } from "./soul";
export { runHeartbeat, type HeartbeatResult } from "./heartbeat";
