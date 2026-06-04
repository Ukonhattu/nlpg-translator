export type LlmApi = "azure" | "gateway";

export type ResolvedLlmConfig = {
  llmApi: LlmApi;
  endpoint: string;
  apiKey: string;
  model: string;
  authHeaderName: string;
};

export type LlmResolveInput = {
  llmApi?: LlmApi;
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

const DEFAULT_RESPONSES_ENDPOINT =
  "https://aalto-openai-apigw.azure-api.net/v1/openai/responses";
const DEFAULT_CHAT_ENDPOINT =
  "https://llm-gateway.k8s.aalto.fi/api/v1/chat/completions";
const DEFAULT_RESPONSES_MODEL = "gpt-5-2025-08-07";
const DEFAULT_CHAT_MODEL = "Qwen/Qwen3-30B-A3B-Instruct-2507-FP8";

const AUTH_HEADERS: Record<LlmApi, string> = {
  azure: "Ocp-Apim-Subscription-Key",
  gateway: "AdminKey",
};

export function resolveLlmConfig(
  options: LlmResolveInput,
  env: NodeJS.ProcessEnv = process.env
): ResolvedLlmConfig {
  const llmApi = options.llmApi ?? "azure";

  const endpointOverride = pickEndpoint(options);
  const endpoint =
    endpointOverride ??
    (llmApi === "gateway"
      ? env.LLM_GATEWAY_CHAT_ENDPOINT ?? DEFAULT_CHAT_ENDPOINT
      : env.AALTO_ENDPOINT ?? DEFAULT_RESPONSES_ENDPOINT);

  const modelOverride = pickModel(options);
  const model =
    modelOverride ??
    (llmApi === "gateway"
      ? env.LLM_GATEWAY_MODEL ?? DEFAULT_CHAT_MODEL
      : env.AALTO_MODEL ?? DEFAULT_RESPONSES_MODEL);

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
    endpoint,
    apiKey,
    model,
    authHeaderName: AUTH_HEADERS[llmApi],
  };
}
