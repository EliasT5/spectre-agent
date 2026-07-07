/**
 * The single source of truth for turning a ModelBackend into the body LiteLLM's
 * admin `POST /model/new` expects. Fills the endpoint-type → provider-prefix gap.
 *
 *  | endpointType       | litellm_params.model        | extra params                    |
 *  |--------------------|-----------------------------|---------------------------------|
 *  | openai             | openai/{m}                  | api_key                         |
 *  | anthropic          | anthropic/{m}               | api_key                         |
 *  | gemini             | gemini/{m}                  | api_key                         |
 *  | azure              | azure/{m} (deployment)      | api_key, api_base*, api_version |
 *  | openai-compatible  | openai/{m}                  | api_key, api_base*              |
 *  | (cli-server)       | openai/{servedModelName}    | api_base=…/v1, api_key=sk-local |
 *                                          (* = required)
 */
import type { EndpointType, ModelBackend } from "./schema";

const PREFIX: Record<EndpointType, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "gemini",
  azure: "azure",
  "openai-compatible": "openai",
};

export interface LiteLLMBody {
  model_name: string;
  litellm_params: Record<string, unknown>;
}

/** The friendly id Spectre requests for this backend on the gateway. */
export function backendModelName(spec: ModelBackend): string {
  return spec.modelName || spec.id;
}

/** Build the `/model/new` body for an `api` backend. */
export function buildApiLiteLLMBody(spec: ModelBackend, apiKey?: string): LiteLLMBody {
  const et = spec.endpointType as EndpointType;
  const params: Record<string, unknown> = {
    model: `${PREFIX[et]}/${spec.providerModel}`,
  };
  if (apiKey) params.api_key = apiKey;
  else if (et === "openai-compatible") params.api_key = "sk-local"; // many local servers ignore it
  if (spec.apiBase) params.api_base = spec.apiBase;
  if (et === "azure" && spec.apiVersion) params.api_version = spec.apiVersion;
  return { model_name: backendModelName(spec), litellm_params: params };
}

/** Build the `/model/new` body for a running cli-server (OpenAI-compatible). */
export function buildCliServerLiteLLMBody(spec: ModelBackend, apiBase: string): LiteLLMBody {
  return {
    model_name: backendModelName(spec),
    litellm_params: {
      model: `openai/${spec.servedModelName || backendModelName(spec)}`,
      api_base: apiBase,
      api_key: "sk-local",
    },
  };
}
