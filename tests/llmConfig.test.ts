import { describe, expect, it } from "vitest";
import {
  buildAuthHeaders,
  inferProtocolFromEndpoint,
  resolveLlmConfig,
} from "../src/llmConfig.js";

describe("buildAuthHeaders", () => {
  it("uses Bearer Authorization for gateway", () => {
    expect(buildAuthHeaders("gateway", "my-key")).toEqual({
      Authorization: "Bearer my-key",
    });
  });

  it("does not double-prefix Bearer", () => {
    expect(buildAuthHeaders("gateway", "Bearer already")).toEqual({
      Authorization: "Bearer already",
    });
  });

  it("uses Ocp-Apim-Subscription-Key for azure", () => {
    expect(buildAuthHeaders("azure", "azure-key")).toEqual({
      "Ocp-Apim-Subscription-Key": "azure-key",
    });
  });
});

describe("inferProtocolFromEndpoint", () => {
  it("detects chat from URL path", () => {
    expect(
      inferProtocolFromEndpoint(
        "https://llm-gateway.k8s.aalto.fi/api/v1/chat/completions"
      )
    ).toBe("chat");
  });

  it("detects responses from URL path", () => {
    expect(
      inferProtocolFromEndpoint("https://llm-gateway.k8s.aalto.fi/api/v1/responses")
    ).toBe("responses");
  });
});

describe("resolveLlmConfig", () => {
  it("defaults to Azure responses API", () => {
    const config = resolveLlmConfig({ aaltoApiKey: "azure-key" }, {});
    expect(config).toEqual({
      llmApi: "azure",
      llmProtocol: "responses",
      endpoint:
        "https://aalto-openai-apigw.azure-api.net/v1/openai/responses",
      apiKey: "azure-key",
      model: "gpt-5-2025-08-07",
      authHeaders: { "Ocp-Apim-Subscription-Key": "azure-key" },
    });
  });

  it("uses env for Azure responses when options omit key and endpoint", () => {
    const config = resolveLlmConfig(
      {},
      {
        AALTO_API_KEY: "from-env",
        AALTO_ENDPOINT: "https://custom/responses",
        AALTO_MODEL: "custom-model",
      }
    );
    expect(config.llmApi).toBe("azure");
    expect(config.llmProtocol).toBe("responses");
    expect(config.apiKey).toBe("from-env");
    expect(config.endpoint).toBe("https://custom/responses");
    expect(config.model).toBe("custom-model");
  });

  it("defaults gateway to Responses API on the k8s gateway", () => {
    const config = resolveLlmConfig(
      { llmApi: "gateway", gatewayApiKey: "gw-key" },
      {}
    );
    expect(config).toEqual({
      llmApi: "gateway",
      llmProtocol: "responses",
      endpoint: "https://llm-gateway.k8s.aalto.fi/api/v1/responses",
      apiKey: "gw-key",
      model: "Qwen/Qwen3-30B-A3B-Instruct-2507-FP8",
      authHeaders: { Authorization: "Bearer gw-key" },
    });
  });

  it("resolves gateway chat completions when llmProtocol is chat", () => {
    const config = resolveLlmConfig(
      { llmApi: "gateway", llmProtocol: "chat", gatewayApiKey: "gw-key" },
      {}
    );
    expect(config.llmProtocol).toBe("chat");
    expect(config.endpoint).toBe(
      "https://llm-gateway.k8s.aalto.fi/api/v1/chat/completions"
    );
  });

  it("uses env for gateway chat when options omit key", () => {
    const config = resolveLlmConfig(
      { llmApi: "gateway", llmProtocol: "chat" },
      {
        LLM_GATEWAY_API_KEY: "gw-env",
        LLM_GATEWAY_CHAT_ENDPOINT: "https://gw/chat",
        LLM_GATEWAY_MODEL: "my-qwen",
      }
    );
    expect(config.apiKey).toBe("gw-env");
    expect(config.endpoint).toBe("https://gw/chat");
    expect(config.model).toBe("my-qwen");
    expect(config.authHeaders).toEqual({ Authorization: "Bearer gw-env" });
  });

  it("uses env for gateway responses endpoint", () => {
    const config = resolveLlmConfig(
      { llmApi: "gateway" },
      {
        LLM_GATEWAY_API_KEY: "gw-env",
        LLM_GATEWAY_RESPONSES_ENDPOINT: "https://gw/responses",
      }
    );
    expect(config.llmProtocol).toBe("responses");
    expect(config.endpoint).toBe("https://gw/responses");
  });

  it("throws when Azure key is missing", () => {
    expect(() => resolveLlmConfig({ llmApi: "azure" }, {})).toThrow(
      /AALTO_API_KEY/
    );
  });

  it("throws when gateway key is missing", () => {
    expect(() => resolveLlmConfig({ llmApi: "gateway" }, {})).toThrow(
      /LLM_GATEWAY_API_KEY/
    );
  });

  it("infers protocol from endpoint override when llmProtocol omitted", () => {
    const config = resolveLlmConfig(
      {
        llmApi: "gateway",
        gatewayApiKey: "k",
        endpoint: "https://gw.example/api/v1/chat/completions",
      },
      {}
    );
    expect(config.llmProtocol).toBe("chat");
  });
});
