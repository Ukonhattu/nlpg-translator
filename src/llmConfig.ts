export type LlmApi = "azure" | "gateway";

export type LlmProtocol = "responses" | "chat";

export type ResolvedLlmConfig = {
  llmApi: LlmApi;
  llmProtocol: LlmProtocol;
  endpoint: string;
  apiKey: string;
  model: string;
  authHeaders: Record<string, string>;
};

export type LlmResolveInput = {
  llmApi?: LlmApi;
  /** OpenAI API shape: Responses (default) or Chat Completions. */
  llmProtocol?: LlmProtocol;
  aaltoApiKey?: string;
  gatewayApiKey?: string;
  /** Per-request API URL (same field for Azure and gateway). */
  endpoint?: string;
  /** Per-request model name (same field for Azure and gateway). */
  model?: string;
  /** @deprecated Use `endpoint`. */
  aaltoEndpoint?: string;
  /** @deprecated Use `model`. */
  aaltoModel?: string;
};

function pickEndpoint(options: LlmResolveInput): string | undefined {
  return options.endpoint ?? options.aaltoEndpoint;
}

function pickModel(options: LlmResolveInput): string | undefined {
  return options.model ?? options.aaltoModel;
}

const DEFAULT_AZURE_RESPONSES_ENDPOINT =
  "https://aalto-openai-apigw.azure-api.net/v1/openai/responses";
const DEFAULT_GATEWAY_RESPONSES_ENDPOINT =
  "https://llm-gateway.k8s.aalto.fi/api/v1/responses";
const DEFAULT_GATEWAY_CHAT_ENDPOINT =
  "https://llm-gateway.k8s.aalto.fi/api/v1/chat/completions";
const DEFAULT_RESPONSES_MODEL = "gpt-5-2025-08-07";
const DEFAULT_GATEWAY_CHAT_MODEL = "Qwen/Qwen3-30B-A3B-Instruct-2507-FP8";

export function buildAuthHeaders(
  llmApi: LlmApi,
  apiKey: string
): Record<string, string> {
  if (llmApi === "gateway") {
    const token = apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
    return { Authorization: token };
  }
  return { "Ocp-Apim-Subscription-Key": apiKey };
}

export function inferProtocolFromEndpoint(
  endpoint: string
): LlmProtocol | undefined {
  if (endpoint.includes("/chat/completions")) return "chat";
  if (endpoint.includes("/responses")) return "responses";
  return undefined;
}

function defaultEndpoint(
  llmApi: LlmApi,
  llmProtocol: LlmProtocol,
  env: NodeJS.ProcessEnv
): string {
  if (llmApi === "gateway") {
    if (llmProtocol === "chat") {
      return env.LLM_GATEWAY_CHAT_ENDPOINT ?? DEFAULT_GATEWAY_CHAT_ENDPOINT;
    }
    return env.LLM_GATEWAY_RESPONSES_ENDPOINT ??
      env.LLM_GATEWAY_CHAT_ENDPOINT?.replace(/\/chat\/completions\/?$/, "/responses") ??
      DEFAULT_GATEWAY_RESPONSES_ENDPOINT;
  }
  return env.AALTO_ENDPOINT ?? DEFAULT_AZURE_RESPONSES_ENDPOINT;
}

function defaultModel(
  llmApi: LlmApi,
  llmProtocol: LlmProtocol,
  env: NodeJS.ProcessEnv
): string {
  if (llmProtocol === "chat") {
    return env.LLM_GATEWAY_CHAT_MODEL ??
      env.LLM_GATEWAY_MODEL ??
      DEFAULT_GATEWAY_CHAT_MODEL;
  }
  if (llmApi === "gateway") {
    return env.LLM_GATEWAY_MODEL ?? DEFAULT_GATEWAY_CHAT_MODEL;
  }
  return env.AALTO_MODEL ?? DEFAULT_RESPONSES_MODEL;
}

export function resolveLlmConfig(
  options: LlmResolveInput,
  env: NodeJS.ProcessEnv = process.env
): ResolvedLlmConfig {
  const llmApi = options.llmApi ?? "azure";
  const endpointOverride = pickEndpoint(options);
  const llmProtocol =
    options.llmProtocol ??
    (endpointOverride ? inferProtocolFromEndpoint(endpointOverride) : undefined) ??
    "responses";

  const endpoint = endpointOverride ?? defaultEndpoint(llmApi, llmProtocol, env);

  const model = pickModel(options) ?? defaultModel(llmApi, llmProtocol, env);

  const apiKey =
    llmApi === "gateway"
      ? (options.gatewayApiKey ?? env.LLM_GATEWAY_API_KEY)?.trim()
      : (options.aaltoApiKey ?? env.AALTO_API_KEY)?.trim();

  if (!apiKey) {
    throw new Error(
      llmApi === "gateway"
        ? "LLM_GATEWAY_API_KEY is not configured (required for llmApi=gateway)"
        : "AALTO_API_KEY is not configured (required for llmApi=azure)"
    );
  }

  return {
    llmApi,
    llmProtocol,
    endpoint,
    apiKey,
    model,
    authHeaders: buildAuthHeaders(llmApi, apiKey),
  };
}
