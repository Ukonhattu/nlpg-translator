#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { translateProgram, type Block } from "./index.js";

function usage() {
  console.error(
    "Usage: nlp2py <file> [--endpoint <url>] [--lint] [--separate-blocks] [--ast] [--unsupported <comment|fallback>] [--reasoning <minimal|low|medium|high>]"
  );
}

async function main() {
  const args = process.argv.slice(2);
  let filePath: string | undefined;
  let endpoint = process.env.AALTO_ENDPOINT;
  let enableLint = false;
  let separateBlocks = false;
  let astMode = false;
  let unsupportedBehavior: "comment" | "fallback" = "comment";
  let reasoningEffort: "minimal" | "low" | "medium" | "high" | undefined;
  let endpointFlagProvided = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

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

  const apiKey = process.env.AALTO_API_KEY;
  if (!apiKey) {
    console.error("Error: AALTO_API_KEY environment variable is not set.");
    process.exit(1);
  }

  const result = await translateProgram(blocks, {
    aaltoApiKey: apiKey,
    aaltoEndpoint: endpoint,
    enableLint,
    separateBlocks,
    astMode,
    unsupportedBehavior,
    reasoningEffort,
  });

  if (result.errors.length > 0) {
    for (const e of result.errors) {
      const loc = e.location ? `:${e.location.line}` : "";
      console.error(`[${e.blockId}${loc}] ${e.code}: ${e.message}`);
    }
    process.exit(1);
  }

  if (result.warnings && result.warnings.length > 0) {
    for (const w of result.warnings) {
      console.error(`warning: ${w}`);
    }
  }

  process.stdout.write(result.pythonCode + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
