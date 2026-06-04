import { describe, expect, it } from "vitest";
import { buildAuthHeaders, resolveLlmConfig } from "../src/llmConfig.js";

describe("buildAuthHeaders", () => {
  it("uses Bearer Authorization for gateway", () => {
    expect(buildAuthHeaders("gateway", "my-key")).toEqual({
      Authorization: "Bearer my-key",
    });
  });

  it("uses Ocp-Apim-Subscription-Key for azure", () => {
    expect(buildAuthHeaders("azure", "azure-key")).toEqual({
      "Ocp-Apim-Subscription-Key": "azure-key",
    });
  });
});

describe("resolveLlmConfig", () => {
  it("defaults to Azure responses API", () => {
    const config = resolveLlmConfig({ aaltoApiKey: "azure-key" }, {});
    expect(config).toEqual({
      llmApi: "azure",
      endpoint:
        "https://aalto-openai-apigw.azure-api.net/v1/openai/responses",
      apiKey: "azure-key",
      model: "gpt-5-2025-08-07",
      authHeaders: { "Ocp-Apim-Subscription-Key": "azure-key" },
    });
  });

  it("defaults gateway to Responses API", () => {
    const config = resolveLlmConfig(
      { llmApi: "gateway", gatewayApiKey: "gw-key" },
      {}
    );
    expect(config).toEqual({
      llmApi: "gateway",
      endpoint: "https://llm-gateway.k8s.aalto.fi/api/v1/responses",
      apiKey: "gw-key",
      model: "Qwen/Qwen3-30B-A3B-Instruct-2507-FP8",
      authHeaders: { Authorization: "Bearer gw-key" },
    });
  });

  it("uses env for gateway responses endpoint and model", () => {
    const config = resolveLlmConfig(
      { llmApi: "gateway" },
      {
        LLM_GATEWAY_API_KEY: "gw-env",
        LLM_GATEWAY_RESPONSES_ENDPOINT: "https://gw/responses",
        LLM_GATEWAY_MODEL: "my-model",
      }
    );
    expect(config.endpoint).toBe("https://gw/responses");
    expect(config.model).toBe("my-model");
    expect(config.authHeaders).toEqual({ Authorization: "Bearer gw-env" });
  });
});
