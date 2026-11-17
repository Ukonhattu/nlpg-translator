/**
 * Tracing for reproducibility: a callback receives one record per LLM call and
 * one per final block result. Records never contain API keys or full endpoint
 * URLs (only the host). Student text is personal data (FIX_PLAN D8), so by
 * default records carry only hashes: `inputText`, `rawOutputText`, `finalCode`
 * and diagnostic messages (which quote source lines) require
 * `traceIncludeInput: true`.
 */

import type { Diagnostic } from "./index.js";
import { PACKAGE_VERSION } from "./version.js";

export type TraceRecord = {
  /** "llm_call": one model request; "block_result": the final result of a block. */
  event: "llm_call" | "block_result";
  ts: string;
  packageVersion: string;
  /** Shared by all records of one translateProgram call (pass `requestId` to correlate with your logs). */
  requestId: string;
  blockId: string;
  mode: "direct" | "ast";
  sampleIndex?: number;
  promptId: string;
  promptSha256: string;
  astSchemaVersion?: number;
  llmApi?: string;
  /** Host only, e.g. "llm-gateway.k8s.aalto.fi"; never a full URL. */
  endpointHost?: string;
  model?: string;
  reasoningEffort?: string;
  temperature?: number;
  structuredOutput?: "on" | "off";
  /** True when "auto" structured output was rejected and retried without a schema. */
  structuredOutputFellBack?: boolean;
  /** SHA-256 of the block text (the student input). */
  inputSha256: string;
  /** Only with `traceIncludeInput`. */
  inputText?: string;
  /** Provider response status ("completed", "incomplete", ...). */
  responseStatus?: string;
  usage?: unknown;
  /** Failure reason code when the call or block failed (never an upstream body). */
  error?: string;
  /** Only with `traceIncludeInput`. */
  rawOutputText?: string;
  /** Diagnostic messages are omitted unless `traceIncludeInput`. */
  diagnostics?: Array<Omit<Diagnostic, "message"> & { message?: string }>;
  /** Only with `traceIncludeInput`. */
  finalCode?: string;
  status?: string;
  durationMs: number;
};

export type TraceOptions = {
  trace?: (record: TraceRecord) => void;
  traceIncludeInput?: boolean;
};

export function endpointHost(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

export function redactDiagnostics(
  diagnostics: Diagnostic[],
  includeInput: boolean
): TraceRecord["diagnostics"] {
  return diagnostics.map((d) => {
    if (includeInput) return d;
    const { message: _message, ...rest } = d;
    void _message;
    return rest;
  });
}

/** Delivers a record; an exception in the callback never breaks translation. */
export function emitTrace(
  options: TraceOptions,
  record: Omit<TraceRecord, "ts" | "packageVersion">
): void {
  if (!options.trace) return;
  try {
    options.trace({
      ts: new Date().toISOString(),
      packageVersion: PACKAGE_VERSION,
      ...record,
    });
  } catch {
    /* tracing must not affect results */
  }
}
