import express, { type Request, type Response } from "express";
import { translateProgram, type Block, type LlmApi, type LlmProtocol } from "./index.js";
import { resolveLlmConfig } from "./llmConfig.js";

const app = express();
app.use(express.json());

app.post("/translate", async (req: Request, res: Response) => {
  try {
    const {
      blocks,
      llmApi,
      llmProtocol,
      endpoint,
      model,
      enableLint,
      separateBlocks,
      astMode,
      unsupportedBehavior,
      reasoningEffort,
      includeDiagnostics,
      strictOutputFidelity,
    } = req.body as {
      blocks: Block[];
      llmApi?: LlmApi;
      llmProtocol?: LlmProtocol;
      endpoint?: string;
      model?: string;
      enableLint?: boolean;
      separateBlocks?: boolean;
      astMode?: boolean;
      unsupportedBehavior?: "comment" | "fallback";
      reasoningEffort?: "minimal" | "low" | "medium" | "high";
      includeDiagnostics?: boolean;
      strictOutputFidelity?: boolean;
    };

    if (!Array.isArray(blocks) || blocks.length === 0) {
      return res.status(400).json({ error: "blocks must be a non-empty array" });
    }

    let translateOptions;
    try {
      resolveLlmConfig({
        llmApi,
        llmProtocol,
        endpoint,
        model,
        aaltoApiKey: process.env.AALTO_API_KEY,
        gatewayApiKey: process.env.LLM_GATEWAY_API_KEY,
      });
      translateOptions = {
        llmApi,
        llmProtocol,
        aaltoApiKey: process.env.AALTO_API_KEY,
        gatewayApiKey: process.env.LLM_GATEWAY_API_KEY,
        endpoint,
        model,
        enableLint,
        separateBlocks,
        astMode,
        unsupportedBehavior,
        reasoningEffort,
        includeDiagnostics,
        strictOutputFidelity,
      };
    } catch (err: any) {
      return res.status(400).json({ error: err.message ?? "Invalid LLM configuration" });
    }

    const result = await translateProgram(blocks, translateOptions);

    res.json(result);
  } catch (err: any) {
    console.error("Translation error", err);
    res.status(500).json({ error: err.message ?? "Internal error" });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`nlpg-translator service listening on port ${port}`);
});
