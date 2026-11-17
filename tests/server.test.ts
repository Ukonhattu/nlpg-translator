import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server.js";

const mockFetch = vi.fn();

const okResponse = (text: string) => ({
  ok: true,
  json: async () => ({
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  }),
});

const baseEnv = {
  AALTO_API_KEY: "az-key",
  AALTO_ENDPOINT: "https://azure.internal/responses",
  AALTO_MODEL: "env-model",
  LLM_GATEWAY_API_KEY: "gw-key",
  LLM_GATEWAY_RESPONSES_ENDPOINT: "https://gw.internal/responses",
} as NodeJS.ProcessEnv;

const body = { blocks: [{ id: "b1", text: "Let a be 1." }] };

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(okResponse("a = 1"));
  vi.stubGlobal("fetch", (...args: unknown[]) => mockFetch(...args));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("server: endpoint/model/llmApi from the client are ignored", () => {
  it("uses the env endpoint and model", async () => {
    const app = createApp(baseEnv);
    const res = await request(app)
      .post("/translate")
      .send({
        ...body,
        endpoint: "https://evil.example/steal",
        model: "evil-model",
        llmApi: "gateway",
      });
    expect(res.status).toBe(200);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://azure.internal/responses");
    expect(JSON.parse(init.body as string).model).toBe("env-model");
  });
});

describe("server: model profiles", () => {
  const env = {
    ...baseEnv,
    SERVER_MODEL_PROFILES: JSON.stringify({
      gpt5: { llmApi: "azure", model: "gpt-5-x" },
      qwen: { llmApi: "gateway", model: "qwen-x" },
    }),
  } as NodeJS.ProcessEnv;

  it("defaults to the first profile", async () => {
    await request(createApp(env)).post("/translate").send(body).expect(200);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://azure.internal/responses");
    expect(JSON.parse(init.body as string).model).toBe("gpt-5-x");
  });

  it("selects a named profile", async () => {
    await request(createApp(env))
      .post("/translate")
      .send({ ...body, modelProfile: "qwen" })
      .expect(200);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gw.internal/responses");
    expect(JSON.parse(init.body as string).model).toBe("qwen-x");
  });

  it("rejects an unknown profile with 400", async () => {
    for (const modelProfile of ["nope", "__proto__", "constructor"]) {
      const res = await request(createApp(env))
        .post("/translate")
        .send({ ...body, modelProfile });
      expect(res.status).toBe(400);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a profile when none are configured", async () => {
    await request(createApp(baseEnv))
      .post("/translate")
      .send({ ...body, modelProfile: "gpt5" })
      .expect(400);
  });

  it("fails fast on invalid SERVER_MODEL_PROFILES", () => {
    expect(() => createApp({ ...baseEnv, SERVER_MODEL_PROFILES: "{oops" })).toThrow();
  });
});

describe("server: auth and bind address", () => {
  it("refuses to start on a non-loopback HOST without a token", () => {
    expect(() => createApp({ ...baseEnv, HOST: "0.0.0.0" })).toThrow(/SERVER_AUTH_TOKEN/);
  });

  it("allows loopback HOST without a token", () => {
    expect(() => createApp({ ...baseEnv, HOST: "127.0.0.1" })).not.toThrow();
  });

  const env = { ...baseEnv, HOST: "0.0.0.0", SERVER_AUTH_TOKEN: "s3cret" } as NodeJS.ProcessEnv;

  it("returns 401 for missing or wrong token", async () => {
    const app = createApp(env);
    await request(app).post("/translate").send(body).expect(401);
    await request(app)
      .post("/translate")
      .set("Authorization", "Bearer wrong")
      .send(body)
      .expect(401);
    await request(app)
      .post("/translate")
      .set("Authorization", "s3cret")
      .send(body)
      .expect(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("accepts the correct token", async () => {
    await request(createApp(env))
      .post("/translate")
      .set("Authorization", "Bearer s3cret")
      .send(body)
      .expect(200);
  });
});

describe("server: input limits", () => {
  it("rejects a body over 64kb with 413", async () => {
    const big = { blocks: [{ id: "b", text: "x".repeat(70_000) }] };
    const res = await request(createApp(baseEnv)).post("/translate").send(big);
    expect(res.status).toBe(413);
  });

  it("rejects too many blocks", async () => {
    const app = createApp({ ...baseEnv, MAX_BLOCKS: "2" });
    const blocks = [1, 2, 3].map((i) => ({ id: `b${i}`, text: "t" }));
    await request(app).post("/translate").send({ blocks }).expect(400);
  });

  it("rejects too much total text", async () => {
    const app = createApp({ ...baseEnv, MAX_TEXT_CHARS: "10" });
    await request(app)
      .post("/translate")
      .send({ blocks: [{ id: "b", text: "x".repeat(11) }] })
      .expect(400);
  });

  it("validates block fields with a field-level message", async () => {
    const app = createApp(baseEnv);
    const r1 = await request(app).post("/translate").send({ blocks: [{ id: 1, text: "t" }] });
    expect(r1.status).toBe(400);
    expect(r1.body.error).toContain("blocks[0].id");
    const r2 = await request(app).post("/translate").send({ blocks: [{ id: "a", text: null }] });
    expect(r2.status).toBe(400);
    expect(r2.body.error).toContain("blocks[0].text");
    await request(app).post("/translate").send({ blocks: [null] }).expect(400);
  });

  it("returns 400 for malformed JSON", async () => {
    await request(createApp(baseEnv))
      .post("/translate")
      .set("Content-Type", "application/json")
      .send("{not json")
      .expect(400);
  });
});

describe("server: upstream errors", () => {
  it("does not echo the upstream error body", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "secret-upstream-detail sub-key=abc123",
    });
    const res = await request(createApp(baseEnv)).post("/translate").send(body);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("secret-upstream-detail");
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it("returns 504 on timeout and passes an abort signal", async () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    mockFetch.mockRejectedValue(err);
    const res = await request(createApp({ ...baseEnv, LLM_TIMEOUT_MS: "1234" }))
      .post("/translate")
      .send(body);
    expect(res.status).toBe(504);
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not leak internal error messages", async () => {
    mockFetch.mockRejectedValue(new Error("db password is hunter2"));
    const res = await request(createApp(baseEnv)).post("/translate").send(body);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
  });
});

describe("server: lintMode", () => {
  it("rejects an invalid lintMode and passes a valid one", async () => {
    const app = createApp(baseEnv);
    await request(app).post("/translate").send({ ...body, lintMode: "strict" }).expect(400);
    const r = await request(app)
      .post("/translate")
      .send({ blocks: [{ id: "b", text: "Print the score." }], lintMode: "block" });
    expect(r.status).toBe(200);
    expect(r.body.errors[0].code).toBe("UNDEFINED_VARIABLE");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("server: /healthz", () => {
  it("returns {ok:true} without auth and without calling the LLM", async () => {
    const app = createApp({ ...baseEnv, HOST: "0.0.0.0", SERVER_AUTH_TOKEN: "s3cret" } as NodeJS.ProcessEnv);
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
