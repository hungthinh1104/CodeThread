import { aiSynthesizeRequestSchema } from '@codethread/contracts';
import type {
  AiSynthesisResponse,
  AiSynthesizeRequest,
} from '@codethread/contracts';
import type { AiConfig } from './config.js';
import { AiError } from './errors.js';
import { buildAiPrompt, hashAiContextPacket } from './packet.js';
import { createAiProviderFromConfig } from './providers.js';
import type { AiProvider, FetchLike } from './providers.js';
import { verifyAiModelOutput } from './verifier.js';

export interface AiSynthesizer {
  readonly enabled: boolean;
  synthesize(request: AiSynthesizeRequest): Promise<AiSynthesisResponse>;
}

export interface CreateAiSynthesizerOptions {
  readonly fetchImpl?: FetchLike;
  /** Optional provider override for deterministic offline testing when enabled. */
  readonly provider?: AiProvider;
}

/**
 * Creates a fail-closed, evidence-bound AI synthesizer.
 * When config.enabled is false, synthesize() always fails closed with
 * AI_DISABLED without performing provider or network I/O.
 */
export function createAiSynthesizer(
  config: AiConfig,
  options: CreateAiSynthesizerOptions = {},
): AiSynthesizer {
  const provider = config.enabled
    ? (options.provider ??
      createAiProviderFromConfig(config, options.fetchImpl))
    : null;

  return {
    enabled: config.enabled,
    async synthesize(
      requestInput: AiSynthesizeRequest,
    ): Promise<AiSynthesisResponse> {
      if (!config.enabled || provider === null) {
        throw new AiError(
          'AI_DISABLED',
          'Optional AI synthesis is disabled (set CODETHREAD_AI_ENABLED=1 to opt in)',
        );
      }
      const parsedRequest = aiSynthesizeRequestSchema.safeParse(requestInput);
      if (!parsedRequest.success) {
        throw new AiError(
          'AI_INVALID_REQUEST',
          'AI synthesis request failed packet contract validation',
        );
      }
      const request = parsedRequest.data;
      const packetHash = hashAiContextPacket(request.packet);
      const prompt = buildAiPrompt(request);
      const rawOutput = await provider.generateJson({
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
      });
      return verifyAiModelOutput(request, rawOutput, {
        provider: provider.kind,
        model: provider.model,
        packetHash,
        promptVersion: prompt.promptVersion,
      });
    },
  };
}
