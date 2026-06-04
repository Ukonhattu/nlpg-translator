#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { translateProgram, type Block, type LlmApi, type LlmProtocol } from "./index.js";
import { resolveLlmConfig } from "./llmConfig.js";

function usage() {
  console.error(
    "Usage: nlp2py <file> [--api azure|gateway] [--protocol responses|chat] [--endpoint <url>] [--model <name>] [--lint] [--separate-blocks] [--ast] [--unsupported <comment|fallback>] [--reasoning <minimal|low|medium|high>] [--verbose] [--strict-output-fidelity]"
  );
}

async function main() {
  const args = process.argv.slice(2);
  let filePath: string | undefined;
  let llmApi: LlmApi | undefined;
  let llmProtocol: LlmProtocol | undefined;
  let endpoint: string | undefined;
  let model: string | undefined;
  let enableLint = false;
  let separateBlocks = false;
  let astMode = false;
  let unsupportedBehavior: "comment" | "fallback" = "comment";
  let reasoningEffort: "minimal" | "low" | "medium" | "high" | undefined;
  let includeDiagnostics = false;
  let strictOutputFidelity = false;
  let endpointFlagProvided = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--api") {
      const value = args[i + 1];
      if (value !== "azure" && value !== "gateway") {
        console.error("Error: --api requires 'azure' or 'gateway'.");
        process.exit(1);
      }
      llmApi = value;
      i++;
      continue;
    }

    if (arg === "--protocol") {
      const value = args[i + 1];
      if (value !== "responses" && value !== "chat") {
        console.error("Error: --protocol requires 'responses' or 'chat'.");
        process.exit(1);
      }
      llmProtocol = value;
      i++;
      continue;
    }

    if (arg === "--endpoint") {
      endpointFlagProvided = true;
      if (!args[i + 1] || args[i + 1].startsWith("--")) {
        console.error("Error: --endpoint requires a URL.");
        process.exit(1);
      }
      endpoint = args[i + 1];
      i++;
      continue;
    }

    if (arg === "--model") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) {
        console.error("Error: --model requires a model name.");
        process.exit(1);
      }
      model = args[i + 1];
      i++;
      continue;
    }

    if (arg === "--lint") {
      enableLint = true;
      continue;
    }

    if (arg === "--separate-blocks") {
      separateBlocks = true;
      continue;
    }

    if (arg === "--ast") {
      astMode = true;
      continue;
    }

    if (arg === "--unsupported") {
      const value = args[i + 1];
      if (value !== "comment" && value !== "fallback") {
        console.error(
          "Error: --unsupported requires a value of 'comment' or 'fallback'."
        );
        process.exit(1);
      }
      unsupportedBehavior = value;
      i++;
      continue;
    }

    if (arg === "--verbose") {
      includeDiagnostics = true;
      continue;
    }

    if (arg === "--strict-output-fidelity") {
      strictOutputFidelity = true;
      continue;
    }

    if (arg === "--reasoning") {
      const value = args[i + 1];
      if (
        value !== "minimal" &&
        value !== "low" &&
        value !== "medium" &&
        value !== "high"
      ) {
        console.error(
          "Error: --reasoning requires one of 'minimal', 'low', 'medium', 'high'."
        );
        process.exit(1);
      }
      reasoningEffort = value;
      i++;
      continue;
    }

    if (arg.startsWith("--")) {
      console.error(`Error: unknown option ${arg}`);
      usage();
      process.exit(1);
    }

    if (!filePath) {
      filePath = arg;
    }
  }
  if (!filePath) {
    usage();
    process.exit(1);
  }

  if (endpointFlagProvided && !endpoint) {
    console.error("Error: --endpoint requires a URL.");
    process.exit(1);
  }

  const absPath = path.resolve(process.cwd(), filePath);
  const text = fs.readFileSync(absPath, "utf8");

  // v0: single block = whole file
  const blocks: Block[] = [
    {
      id: "block-1",
      text,
    },
  ];

  let resolved;
  try {
    resolved = resolveLlmConfig({
      llmApi,
      llmProtocol,
      aaltoApiKey: process.env.AALTO_API_KEY,
      gatewayApiKey: process.env.LLM_GATEWAY_API_KEY,
      endpoint,
      model,
    });
  } catch (err: any) {
    console.error(`Error: ${err.message ?? String(err)}`);
    process.exit(1);
  }

  const result = await translateProgram(blocks, {
    llmApi: resolved.llmApi,
    llmProtocol: resolved.llmProtocol,
    aaltoApiKey: process.env.AALTO_API_KEY,
    gatewayApiKey: process.env.LLM_GATEWAY_API_KEY,
    endpoint: resolved.endpoint,
    model: resolved.model,
    enableLint,
    separateBlocks,
    astMode,
    unsupportedBehavior,
    reasoningEffort,
    includeDiagnostics,
    strictOutputFidelity,
  });

  if (result.errors.length > 0) {
    for (const e of result.errors) {
      const loc = e.location ? `:${e.location.line}` : "";
      console.error(`[${e.blockId}${loc}] ${e.code}: ${e.message}`);
    }
    process.exit(1);
  }

  if (result.diagnostics && result.diagnostics.length > 0) {
    for (const d of result.diagnostics) {
      console.error(`diagnostic: ${d}`);
    }
  }

  process.stdout.write(result.pythonCode + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
