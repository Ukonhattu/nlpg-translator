import { describe, expect, it } from "vitest";
import { resolveLlmConfig } from "../src/llmConfig.js";

describe("resolveLlmConfig", () => {
  it("defaults to Azure responses API", () => {
    const config = resolveLlmConfig(
      { aaltoApiKey: "azure-key" },
      {}
    );
    expect(config).toEqual({
      llmApi: "azure",
      endpoint:
        "https://aalto-openai-apigw.azure-api.net/v1/openai/responses",
      apiKey: "azure-key",
      model: "gpt-5-2025-08-07",
      authHeaderName: "Ocp-Apim-Subscription-Key",
    });
  });

  it("uses env for responses when options omit key and endpoint", () => {
    const config = resolveLlmConfig(
      {},
      {
        AALTO_API_KEY: "from-env",
        AALTO_ENDPOINT: "https://custom/responses",
        AALTO_MODEL: "custom-model",
      }
    );
    expect(config.llmApi).toBe("azure");
    expect(config.apiKey).toBe("from-env");
    expect(config.endpoint).toBe("https://custom/responses");
    expect(config.model).toBe("custom-model");
  });

  it("resolves chat gateway defaults", () => {
    const config = resolveLlmConfig(
      { llmApi: "gateway", gatewayApiKey: "gw-key" },
      {}
    );
    expect(config).toEqual({
      llmApi: "gateway",
      endpoint: "https://llm-gateway.k8s.aalto.fi/api/v1/chat/completions",
      apiKey: "gw-key",
      model: "Qwen/Qwen3-30B-A3B-Instruct-2507-FP8",
      authHeaderName: "AdminKey",
    });
  });

  it("uses env for chat when options omit key", () => {
    const config = resolveLlmConfig(
      { llmApi: "gateway" },
      {
        LLM_GATEWAY_API_KEY: "gw-env",
        LLM_GATEWAY_CHAT_ENDPOINT: "https://gw/chat",
        LLM_GATEWAY_MODEL: "my-qwen",
      }
    );
    expect(config.apiKey).toBe("gw-env");
    expect(config.endpoint).toBe("https://gw/chat");
    expect(config.model).toBe("my-qwen");
    expect(config.authHeaderName).toBe("AdminKey");
  });

  it("throws when responses key is missing", () => {
    expect(() => resolveLlmConfig({ llmApi: "azure" }, {})).toThrow(
      /AALTO_API_KEY/
    );
  });

  it("throws when chat key is missing", () => {
    expect(() => resolveLlmConfig({ llmApi: "gateway" }, {})).toThrow(
      /LLM_GATEWAY_API_KEY/
    );
  });

  it("honors per-request endpoint and model overrides", () => {
    const config = resolveLlmConfig(
      {
        llmApi: "gateway",
        gatewayApiKey: "k",
        endpoint: "https://override/endpoint",
        model: "override-model",
      },
      {}
    );
    expect(config.endpoint).toBe("https://override/endpoint");
    expect(config.model).toBe("override-model");
  });

  it("accepts deprecated aaltoEndpoint and aaltoModel aliases", () => {
    const config = resolveLlmConfig(
      {
        aaltoApiKey: "k",
        aaltoEndpoint: "https://legacy/endpoint",
        aaltoModel: "legacy-model",
      },
      {}
    );
    expect(config.endpoint).toBe("https://legacy/endpoint");
    expect(config.model).toBe("legacy-model");
  });

  it("prefers endpoint and model over deprecated aliases", () => {
    const config = resolveLlmConfig(
      {
        aaltoApiKey: "k",
        endpoint: "https://new/endpoint",
        model: "new-model",
        aaltoEndpoint: "https://legacy/endpoint",
        aaltoModel: "legacy-model",
      },
      {}
    );
    expect(config.endpoint).toBe("https://new/endpoint");
    expect(config.model).toBe("new-model");
  });
});
