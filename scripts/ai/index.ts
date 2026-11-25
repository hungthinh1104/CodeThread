export { AiError, sanitizeAiMessage } from './errors.ts';
export {
  DEFAULT_AI_MAX_RESPONSE_BYTES,
  DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_MODEL,
  loadAiConfig,
} from './config.ts';
export type {
  AiConfig,
  AiLocality,
  DisabledAiConfig,
  EnabledGeminiConfig,
  EnabledOpenAiCompatibleConfig,
} from './config.ts';
export {
  AI_PROMPT_VERSION,
  buildAiContextPacketFromProjection,
  buildAiPrompt,
  hashAiContextPacket,
} from './packet.ts';
export type { BuiltAiPrompt } from './packet.ts';
export { redactSecrets } from './redact.ts';
export type { RedactionResult } from './redact.ts';
export {
  STATIC_AI_DISCLAIMER,
  hasRuntimeExecutionOverclaim,
  verifyAiModelOutput,
} from './verifier.ts';
export type { VerificationProvenance } from './verifier.ts';
export {
  createAiProviderFromConfig,
  createGeminiProvider,
  createMockProvider,
  createOpenAiCompatibleProvider,
  extractJsonObject,
} from './providers.ts';
export type { AiProvider, AiProviderInput, FetchLike } from './providers.ts';
export { createAiSynthesizer } from './synthesizer.ts';
export type {
  AiSynthesizer,
  CreateAiSynthesizerOptions,
} from './synthesizer.ts';
