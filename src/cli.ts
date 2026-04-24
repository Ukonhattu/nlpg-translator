#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { translateProgram, type Block } from "./index.js";

function usage() {
  console.error("Usage: nlp2py <file>");
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    usage();
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
  });

  if (result.errors.length > 0) {
    for (const e of result.errors) {
      const loc = e.location ? `:${e.location.line}` : "";
      console.error(`[${e.blockId}${loc}] ${e.code}: ${e.message}`);
    }
    process.exit(1);
  }

  process.stdout.write(result.pythonCode + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
