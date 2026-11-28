import { aiSynthesizeRequestSchema } from '@codethread/contracts';
import type {
  AiSynthesisResponse,
  AiSynthesizeRequest,
} from '@codethread/contracts';
import type { AiConfig } from './config.ts';
import { AiError } from './errors.ts';
import { buildAiPrompt, hashAiContextPacket } from './packet.ts';
import { createAiProviderFromConfig } from './providers.ts';
import type { AiProvider, FetchLike } from './providers.ts';
import { verifyAiModelOutput } from './verifier.ts';

export interface AiSynthesizeCallOptions {
  readonly signal?: AbortSignal;
}

export interface AiSynthesizer {
  readonly enabled: boolean;
  synthesize(
    request: AiSynthesizeRequest,
    options?: AiSynthesizeCallOptions,
  ): Promise<AiSynthesisResponse>;
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
      callOptions?: AiSynthesizeCallOptions,
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
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
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
