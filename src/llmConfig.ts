export type LlmApi = "azure" | "gateway";

export type ResolvedLlmConfig = {
  llmApi: LlmApi;
  endpoint: string;
  apiKey: string;
  model: string;
  authHeaders: Record<string, string>;
};

export type LlmResolveInput = {
  llmApi?: LlmApi;
  aaltoApiKey?: string;
  gatewayApiKey?: string;
  endpoint?: string;
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
const DEFAULT_AZURE_MODEL = "gpt-5-2025-08-07";
const DEFAULT_GATEWAY_MODEL = "Qwen/Qwen3-30B-A3B-Instruct-2507-FP8";

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

function defaultEndpoint(llmApi: LlmApi, env: NodeJS.ProcessEnv): string {
  if (llmApi === "gateway") {
    return env.LLM_GATEWAY_RESPONSES_ENDPOINT ??
      env.LLM_GATEWAY_ENDPOINT ??
      DEFAULT_GATEWAY_RESPONSES_ENDPOINT;
  }
  return env.AALTO_ENDPOINT ?? DEFAULT_AZURE_RESPONSES_ENDPOINT;
}

function defaultModel(llmApi: LlmApi, env: NodeJS.ProcessEnv): string {
  if (llmApi === "gateway") {
    return env.LLM_GATEWAY_MODEL ?? DEFAULT_GATEWAY_MODEL;
  }
  return env.AALTO_MODEL ?? DEFAULT_AZURE_MODEL;
}

export function resolveLlmConfig(
  options: LlmResolveInput,
  env: NodeJS.ProcessEnv = process.env
): ResolvedLlmConfig {
  const llmApi = options.llmApi ?? "azure";
  const endpoint = pickEndpoint(options) ?? defaultEndpoint(llmApi, env);
  const model = pickModel(options) ?? defaultModel(llmApi, env);

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
    authHeaders: buildAuthHeaders(llmApi, apiKey),
  };
}
