import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  translateProgram,
  type Block,
  type LlmApi,
  type TranslateOptions,
} from "./index.js";
import { resolveLlmConfig } from "./llmConfig.js";
import { LlmHttpError, LlmResponseError } from "./translator.js";

/**
 * HTTP wrapper around the translator. Intended for internal deployment behind
 * authentication: endpoints, models and API keys come ONLY from server-side
 * configuration, never from the request body.
 */

type ModelProfile = { llmApi?: LlmApi; model?: string };

type ServerConfig = {
  env: NodeJS.ProcessEnv;
  profiles: Record<string, ModelProfile> | undefined;
  defaultProfile: string | undefined;
  authToken: string | undefined;
  maxBlocks: number;
  maxTextChars: number;
  timeoutMs: number;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function parseProfiles(
  raw: string | undefined
): Record<string, ModelProfile> | undefined {
  if (!raw?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SERVER_MODEL_PROFILES is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SERVER_MODEL_PROFILES must be a JSON object");
  }
  const profiles: Record<string, ModelProfile> = {};
  for (const [name, value] of Object.entries(parsed)) {
    const p = value as ModelProfile;
    if (!p || typeof p !== "object") {
      throw new Error(`SERVER_MODEL_PROFILES.${name} must be an object`);
    }
    if (p.llmApi !== undefined && p.llmApi !== "azure" && p.llmApi !== "gateway") {
      throw new Error(`SERVER_MODEL_PROFILES.${name}.llmApi must be "azure" or "gateway"`);
    }
    if (p.model !== undefined && typeof p.model !== "string") {
      throw new Error(`SERVER_MODEL_PROFILES.${name}.model must be a string`);
    }
    profiles[name] = { llmApi: p.llmApi, model: p.model };
  }
  if (Object.keys(profiles).length === 0) return undefined;
  return profiles;
}

function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const profiles = parseProfiles(env.SERVER_MODEL_PROFILES);
  const host = env.HOST?.trim() || "127.0.0.1";
  const authToken = env.SERVER_AUTH_TOKEN?.trim() || undefined;
  if (!isLoopbackHost(host) && !authToken) {
    throw new Error(
      `SERVER_AUTH_TOKEN is required when HOST (${host}) is not a loopback address`
    );
  }
  return {
    env,
    profiles,
    defaultProfile: profiles ? Object.keys(profiles)[0] : undefined,
    authToken,
    maxBlocks: positiveInt(env.MAX_BLOCKS, 50),
    maxTextChars: positiveInt(env.MAX_TEXT_CHARS, 20_000),
    timeoutMs: positiveInt(env.LLM_TIMEOUT_MS, 60_000),
  };
}

function tokensEqual(a: string, b: string): boolean {
  // Hash first so lengths match and timingSafeEqual cannot throw.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const REASONING = new Set(["minimal", "low", "medium", "high"]);
const UNSUPPORTED = new Set(["comment", "fallback"]);
const BOOLEAN_FIELDS = [
  "enableLint",
  "separateBlocks",
  "astMode",
  "includeDiagnostics",
  "strictOutputFidelity",
] as const;

class BadRequest extends Error {}

function validateBody(body: any, cfg: ServerConfig): { blocks: Block[] } {
  if (!body || typeof body !== "object") {
    throw new BadRequest("request body must be a JSON object");
  }
  const { blocks } = body;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new BadRequest("blocks must be a non-empty array");
  }
  if (blocks.length > cfg.maxBlocks) {
    throw new BadRequest(`blocks must contain at most ${cfg.maxBlocks} items`);
  }
  let total = 0;
  blocks.forEach((b: any, i: number) => {
    if (!b || typeof b !== "object") {
      throw new BadRequest(`blocks[${i}] must be an object`);
    }
    if (typeof b.id !== "string") {
      throw new BadRequest(`blocks[${i}].id must be a string`);
    }
    if (typeof b.text !== "string") {
      throw new BadRequest(`blocks[${i}].text must be a string`);
    }
    total += b.text.length;
  });
  if (total > cfg.maxTextChars) {
    throw new BadRequest(`total block text must be at most ${cfg.maxTextChars} characters`);
  }
  for (const f of BOOLEAN_FIELDS) {
    if (body[f] !== undefined && typeof body[f] !== "boolean") {
      throw new BadRequest(`${f} must be a boolean`);
    }
  }
  if (body.reasoningEffort !== undefined && !REASONING.has(body.reasoningEffort)) {
    throw new BadRequest("reasoningEffort must be one of minimal, low, medium, high");
  }
  if (body.unsupportedBehavior !== undefined && !UNSUPPORTED.has(body.unsupportedBehavior)) {
    throw new BadRequest('unsupportedBehavior must be "comment" or "fallback"');
  }
  if (body.modelProfile !== undefined && typeof body.modelProfile !== "string") {
    throw new BadRequest("modelProfile must be a string");
  }
  return { blocks };
}

export function createApp(env: NodeJS.ProcessEnv = process.env) {
  const cfg = readConfig(env);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!cfg.authToken) return next();
    const header = req.get("authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match || !tokensEqual(match[1], cfg.authToken)) {
      res.set("WWW-Authenticate", "Bearer");
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  };

  app.post("/translate", requireAuth, async (req: Request, res: Response) => {
    const requestId = randomUUID();
    try {
      const { blocks } = validateBody(req.body, cfg);
      // llmApi, model and endpoint in the body are deliberately ignored.
      const body = req.body;

      let profile: ModelProfile = {};
      if (body.modelProfile !== undefined) {
        const chosen = cfg.profiles?.[body.modelProfile];
        if (
          !cfg.profiles ||
          !Object.prototype.hasOwnProperty.call(cfg.profiles, body.modelProfile) ||
          !chosen
        ) {
          return res.status(400).json({ error: "unknown modelProfile" });
        }
        profile = chosen;
      } else if (cfg.defaultProfile) {
        profile = cfg.profiles![cfg.defaultProfile];
      }

      let resolved;
      try {
        resolved = resolveLlmConfig(
          {
            llmApi: profile.llmApi,
            model: profile.model,
            aaltoApiKey: env.AALTO_API_KEY,
            gatewayApiKey: env.LLM_GATEWAY_API_KEY,
          },
          env
        );
      } catch (err) {
        console.error(`[${requestId}] LLM configuration error`, err);
        return res
          .status(500)
          .json({ error: "server LLM configuration error", requestId });
      }

      const options: TranslateOptions = {
        llmApi: resolved.llmApi,
        aaltoApiKey: env.AALTO_API_KEY,
        gatewayApiKey: env.LLM_GATEWAY_API_KEY,
        endpoint: resolved.endpoint,
        model: resolved.model,
        timeoutMs: cfg.timeoutMs,
        throwOnFailure: true,
        enableLint: body.enableLint,
        separateBlocks: body.separateBlocks,
        astMode: body.astMode,
        unsupportedBehavior: body.unsupportedBehavior,
        reasoningEffort: body.reasoningEffort,
        includeDiagnostics: body.includeDiagnostics,
        strictOutputFidelity: body.strictOutputFidelity,
      };

      const result = await translateProgram(blocks, options);
      res.json(result);
    } catch (err: any) {
      if (err instanceof BadRequest) {
        return res.status(400).json({ error: err.message });
      }
      // Never forward upstream error bodies; log them here instead.
      console.error(`[${requestId}] Translation error`, err);
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        return res.status(504).json({ error: "upstream LLM timed out", requestId });
      }
      if (err instanceof LlmHttpError || err instanceof LlmResponseError) {
        return res.status(502).json({ error: "upstream LLM request failed", requestId });
      }
      res.status(500).json({ error: "internal error", requestId });
    }
  });

  // Body-parser errors (oversized -> 413, malformed JSON -> 400).
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err && typeof err.status === "number" && err.status >= 400 && err.status < 500) {
      return res
        .status(err.status)
        .json({ error: err.status === 413 ? "request body too large" : "invalid request body" });
    }
    next(err);
  });

  return app;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    const host = process.env.HOST?.trim() || "127.0.0.1";
    const port = process.env.PORT || 4000;
    const app = createApp(process.env);
    app.listen(Number(port), host, () => {
      console.log(`nlpg-translator service listening on ${host}:${port}`);
    });
  } catch (err: any) {
    console.error(`Failed to start: ${err.message ?? err}`);
    process.exit(1);
  }
}
