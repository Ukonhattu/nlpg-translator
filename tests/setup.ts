/**
 * Makes unit tests hermetic: the developer's shell often has real API keys,
 * endpoints and server settings exported, and tests that rely on defaults must
 * not pick them up. (Integration tests use their own config and need the keys.)
 */
const ENV_KEYS = [
  "AALTO_API_KEY",
  "AALTO_ENDPOINT",
  "AALTO_MODEL",
  "LLM_GATEWAY_API_KEY",
  "LLM_GATEWAY_RESPONSES_ENDPOINT",
  "LLM_GATEWAY_ENDPOINT",
  "LLM_GATEWAY_MODEL",
  "HOST",
  "PORT",
  "SERVER_AUTH_TOKEN",
  "SERVER_MODEL_PROFILES",
  "MAX_BLOCKS",
  "MAX_TEXT_CHARS",
  "LLM_TIMEOUT_MS",
];

for (const key of ENV_KEYS) delete process.env[key];
