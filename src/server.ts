import express, { type Request, type Response } from "express";
import { translateProgram, type Block } from "./index.js";

const app = express();
app.use(express.json());

app.post("/translate", async (req: Request, res: Response) => {
  try {
    const {
      blocks,
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

    const apiKey = process.env.AALTO_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "AALTO_API_KEY not configured" });
    }

    const result = await translateProgram(blocks, {
      aaltoApiKey: apiKey,
      aaltoEndpoint: endpoint || process.env.AALTO_ENDPOINT,
      aaltoModel: model,
      enableLint,
      separateBlocks,
      astMode,
      unsupportedBehavior,
      reasoningEffort,
      includeDiagnostics,
      strictOutputFidelity,
    });

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
