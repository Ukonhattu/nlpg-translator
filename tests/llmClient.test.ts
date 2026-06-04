import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

describe("callLlm via translateBlocks", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("posts Responses API shape to Azure", async () => {
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
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("aalto-openai-apigw");
    const headers = init.headers as Record<string, string>;
    expect(headers["Ocp-Apim-Subscription-Key"]).toBe("azure-key");
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.input).toBeDefined();
    expect(body.messages).toBeUndefined();
  });

  it("posts Responses API shape to gateway with Bearer auth", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "b = 2" }],
          },
        ],
      }),
    });

    const code = await translateBlocks(
      [{ id: "b1", text: "Let b be 2." }],
      { llmApi: "gateway", gatewayApiKey: "gw-key" }
    );

    expect(code.trim()).toBe("b = 2");
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/responses");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gw-key");
    const body = JSON.parse(init.body as string);
    expect(body.input).toBeDefined();
  });

  it("includes reasoning for responses API", async () => {
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
      { aaltoApiKey: "k", llmApi: "azure", reasoningEffort: "low" }
    );

    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  it("AST mode uses gateway responses with endpoint and model overrides", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text:
                  '{"statements":[{"kind":"assign","target":"a","value":{"kind":"num","value":1},"line":1}]}',
              },
            ],
          },
        ],
      }),
    });

    await translateBlocksViaAst(
      [{ id: "b1", text: "1: Let a be 1." }],
      {
        llmApi: "gateway",
        gatewayApiKey: "gw-key",
        model: "custom-model",
        endpoint: "https://gw.example/responses",
      }
    );

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gw.example/responses");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("custom-model");
    expect(body.input).toBeDefined();
  });
});
