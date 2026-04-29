import fetch from "node-fetch";
import type { Block, TranslateOptions } from "./index.js";

export async function translateBlocks(
  blocks: Block[],
  options: TranslateOptions
): Promise<string> {
  const snippets: string[] = [];
  for (const block of blocks) {
    const code = await translateSingleBlock(block, options);
    snippets.push(code.trim());
  }
  return snippets.filter(Boolean).join("\n\n");
}

async function translateSingleBlock(
  block: Block,
  options: TranslateOptions
): Promise<string> {
  const { aaltoApiKey, aaltoModel = "gpt-5-2025-08-07" } = options;

  const systemPrompt =
    "You translate beginner-friendly natural language programming instructions into Python. " +
    "Each input is a single block, translated independently. " +
    "Use only basic Python (variables, arithmetic, if/else, for/while, print). " +
    "Use global variables rather than defining functions. " +
    "Do not invent missing logic; follow the instructions strictly. " +
    "Never add comments or explanations; output only Python code.";

  const userContent =
    "Translate the following block into Python. " +
    "Preserve the logical structure and order of steps, using simple code suitable for beginners.\n\n" +
    block.text;

  const body = {
    model: aaltoModel,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  };

  const res = await fetch(
    "https://aalto-openai-apigw.azure-api.net/v1/openai/responses",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": aaltoApiKey,
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Aalto AI request failed (${res.status}): ${text}`);
  }

  const data: any = await res.json();
  // Aalto uses OpenAI Responses API format. We want the assistant's text only.
  // Example: data.output is an array; we find the message with type "message",
  // then its content item with type "output_text" and read .text.
  if (Array.isArray(data.output)) {
    const msg = data.output.find((item: any) => item.type === "message");
    if (msg && Array.isArray(msg.content)) {
      const textItem = msg.content.find(
        (c: any) => c.type === "output_text" && typeof c.text === "string"
      );
      if (textItem) {
        return textItem.text as string;
      }
    }
  }

  // Fallback: try a few generic locations, otherwise dump JSON as string.
  const fallback =
    data.output?.[0]?.content?.[0]?.text ||
    data.output?.[0]?.content ||
    data.text ||
    JSON.stringify(data);

  return typeof fallback === "string" ? fallback : String(fallback ?? "");
}

