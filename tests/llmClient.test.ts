import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractChatCompletionText,
  extractResponseText,
  translateBlocks,
  translateBlocksViaAst,
} from "../src/translator.js";

const mockFetch = vi.fn();

vi.mock("node-fetch", () => ({
  default: (...args: unknown[]) => mockFetch(...args),
}));

describe("extractResponseText", () => {
  it("reads output_text from a Responses API message", () => {
    const text = extractResponseText({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "print(1)" }],
        },
      ],
    });
    expect(text).toBe("print(1)");
  });
});

describe("extractChatCompletionText", () => {
  it("reads choices[0].message.content", () => {
    const text = extractChatCompletionText({
      choices: [{ message: { content: "x = 1" } }],
    });
    expect(text).toBe("x = 1");
  });
});

describe("callLlm via translateBlocks", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("posts Responses API shape to Azure with Ocp-Apim-Subscription-Key", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "a = 1" }],
          },
        ],
      }),
    });

    const code = await translateBlocks(
      [{ id: "b1", text: "Let a be 1." }],
      { aaltoApiKey: "azure-key", llmApi: "azure" }
    );

    expect(code.trim()).toBe("a = 1");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("aalto-openai-apigw");
    const headers = init.headers as Record<string, string>;
    expect(headers["Ocp-Apim-Subscription-Key"]).toBe("azure-key");
    expect(headers.AdminKey).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.input).toBeDefined();
    expect(body.messages).toBeUndefined();
  });

  it("posts Chat Completions shape to gateway with AdminKey", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "b = 2" } }],
      }),
    });

    const code = await translateBlocks(
      [{ id: "b1", text: "Let b be 2." }],
      { llmApi: "gateway", gatewayApiKey: "gw-key" }
    );

    expect(code.trim()).toBe("b = 2");
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("llm-gateway.k8s.aalto.fi");
    const headers = init.headers as Record<string, string>;
    expect(headers.AdminKey).toBe("gw-key");
    expect(headers["Ocp-Apim-Subscription-Key"]).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.messages).toHaveLength(2);
    expect(body.input).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });

  it("includes reasoning only for responses API", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "" }],
          },
        ],
      }),
    });

    await translateBlocks(
      [{ id: "b1", text: "Let a be 1." }],
      {
        aaltoApiKey: "k",
        llmApi: "azure",
        reasoningEffort: "low",
      }
    );

    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  it("AST mode uses chat completions with the same endpoint and model fields", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"statements":[{"kind":"assign","target":"a","value":{"kind":"num","value":1},"line":1}]}',
            },
          },
        ],
      }),
    });

    await translateBlocksViaAst(
      [{ id: "b1", text: "1: Let a be 1." }],
      {
        llmApi: "gateway",
        gatewayApiKey: "gw-key",
        model: "custom-qwen",
        endpoint: "https://gw.example/chat",
      }
    );

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gw.example/chat");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("custom-qwen");
    expect(body.messages).toBeDefined();
  });

  it("direct mode uses responses API with per-request model", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "a = 1" }],
          },
        ],
      }),
    });

    await translateBlocks(
      [{ id: "b1", text: "Let a be 1." }],
      {
        aaltoApiKey: "azure-key",
        model: "gpt-custom",
      }
    );

    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.model).toBe("gpt-custom");
  });
});
