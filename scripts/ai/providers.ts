import type { AiProviderKind } from '@codethread/contracts';
import type {
  AiConfig,
  EnabledGeminiConfig,
  EnabledOpenAiCompatibleConfig,
} from './config.ts';
import { AiError } from './errors.ts';

export interface AiProviderInput {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly signal?: AbortSignal;
}

export interface AiProvider {
  readonly kind: AiProviderKind;
  readonly model: string;
  generateJson(input: AiProviderInput): Promise<unknown>;
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

function buildRequestSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal
    ? AbortSignal.any([timeoutSignal, externalSignal])
    : timeoutSignal;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^[0-9]+$/.test(declared.trim())) {
    if (Number.parseInt(declared.trim(), 10) > maxBytes) {
      throw new AiError(
        'AI_RESPONSE_TOO_LARGE',
        `Provider response exceeds ${maxBytes} byte limit`,
      );
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new AiError(
        'AI_RESPONSE_TOO_LARGE',
        `Provider response exceeds ${maxBytes} byte limit`,
      );
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AiError(
          'AI_RESPONSE_TOO_LARGE',
          `Provider response exceeds ${maxBytes} byte limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } catch {
    throw new AiError(
      'AI_INVALID_MODEL_OUTPUT',
      'Provider returned invalid UTF-8 response',
    );
  }
}

export function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new AiError(
      'AI_INVALID_MODEL_OUTPUT',
      'Provider returned non-JSON model output',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AiError(
      'AI_INVALID_MODEL_OUTPUT',
      'Provider model output must be a JSON object',
    );
  }
  return parsed;
}

function classifyFetchError(error: unknown, providerLabel: string): AiError {
  if (error instanceof AiError) return error;
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return new AiError(
      'AI_PROVIDER_TIMEOUT',
      `${providerLabel} request timed out or was cancelled`,
    );
  }
  return new AiError(
    'AI_PROVIDER_ERROR',
    `${providerLabel} request failed: ${error instanceof Error ? error.message : 'network error'}`,
  );
}

function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) return true;
  const media = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    media === '' || media === 'application/json' || media.endsWith('+json')
  );
}

/**
 * Shared hardened HTTP POST transport for every AI provider adapter.
 * Enforces `redirect: 'manual'` and rejects all 3xx/opaqueredirect responses
 * so prompt bodies, source excerpts, and API credentials can never be forwarded
 * to an unapproved redirect target.
 */
async function postProviderJson(options: {
  readonly fetchImpl: FetchLike;
  readonly endpoint: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly providerLabel: string;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await options.fetchImpl(options.endpoint, {
      method: 'POST',
      headers: options.headers,
      body: JSON.stringify(options.body),
      redirect: 'manual',
      signal: buildRequestSignal(options.timeoutMs, options.signal),
    });
  } catch (error) {
    throw classifyFetchError(error, options.providerLabel);
  }

  if (
    response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400)
  ) {
    await response.body?.cancel().catch(() => {});
    throw new AiError(
      'AI_PROVIDER_ERROR',
      `${options.providerLabel} returned redirect HTTP ${response.status}; redirects are forbidden`,
    );
  }

  const rawBody = await readBoundedText(response, options.maxResponseBytes);
  if (!response.ok) {
    throw new AiError(
      'AI_PROVIDER_ERROR',
      `${options.providerLabel} API returned HTTP ${response.status}`,
    );
  }

  if (!isJsonContentType(response.headers.get('content-type'))) {
    throw new AiError(
      'AI_INVALID_MODEL_OUTPUT',
      `${options.providerLabel} API returned unexpected content type`,
    );
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new AiError(
      'AI_INVALID_MODEL_OUTPUT',
      `${options.providerLabel} API returned malformed JSON envelope`,
    );
  }
}

/**
 * Flat OpenAPI-3 subset schema passed to Gemini's controlled JSON decoder
 * (`generationConfig.responseSchema`) so token generation conforms to
 * `aiModelRawOutputSchema` before deterministic post-verification runs.
 */
const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  required: ['summary', 'claims', 'nextSteps', 'uncertainties'],
  properties: {
    summary: { type: 'STRING' },
    claims: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: [
          'text',
          'claimType',
          'evidenceIds',
          'symbolIds',
          'relationIds',
          'diagnosticIds',
        ],
        properties: {
          text: { type: 'STRING' },
          claimType: {
            type: 'STRING',
            enum: ['observed_fact', 'static_inference', 'uncertainty_note'],
          },
          assertedRelation: {
            type: 'STRING',
            enum: [
              'exact_call',
              'exact_reference',
              'exact_construct',
              'non_exact',
            ],
          },
          evidenceIds: { type: 'ARRAY', items: { type: 'STRING' } },
          symbolIds: { type: 'ARRAY', items: { type: 'STRING' } },
          relationIds: { type: 'ARRAY', items: { type: 'STRING' } },
          diagnosticIds: { type: 'ARRAY', items: { type: 'STRING' } },
        },
      },
    },
    nextSteps: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['symbolId', 'reason', 'supportingEvidenceIds'],
        properties: {
          symbolId: { type: 'STRING' },
          reason: { type: 'STRING' },
          supportingEvidenceIds: { type: 'ARRAY', items: { type: 'STRING' } },
        },
      },
    },
    uncertainties: { type: 'ARRAY', items: { type: 'STRING' } },
  },
} as const;

export function createGeminiProvider(
  config: EnabledGeminiConfig,
  fetchImpl: FetchLike = fetch,
): AiProvider {
  const endpoint = `${config.baseUrl}/models/${encodeURIComponent(config.model)}:generateContent`;
  return {
    kind: 'gemini',
    model: config.model,
    async generateJson(input: AiProviderInput): Promise<unknown> {
      const envelope = await postProviderJson({
        fetchImpl,
        endpoint,
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': config.apiKey,
        },
        body: {
          systemInstruction: { parts: [{ text: input.systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: input.userPrompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: GEMINI_RESPONSE_SCHEMA,
          },
        },
        timeoutMs: config.timeoutMs,
        maxResponseBytes: config.maxResponseBytes,
        providerLabel: 'Gemini',
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const candidates =
        envelope !== null &&
        typeof envelope === 'object' &&
        'candidates' in envelope &&
        Array.isArray((envelope as { candidates?: unknown }).candidates)
          ? (envelope as { candidates: unknown[] }).candidates
          : null;
      const first = candidates?.[0] as
        { content?: { parts?: { text?: unknown }[] } } | undefined;
      const parts = first?.content?.parts;
      if (!Array.isArray(parts) || parts.length === 0) {
        throw new AiError(
          'AI_INVALID_MODEL_OUTPUT',
          'Gemini API response contained no text candidate',
        );
      }
      const combinedText = parts
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('');
      return extractJsonObject(combinedText);
    },
  };
}

export function createOpenAiCompatibleProvider(
  config: EnabledOpenAiCompatibleConfig,
  fetchImpl: FetchLike = fetch,
): AiProvider {
  const endpoint = `${config.baseUrl}/chat/completions`;
  return {
    kind: 'openai_compatible',
    model: config.model,
    async generateJson(input: AiProviderInput): Promise<unknown> {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (config.apiKey !== null) {
        headers['authorization'] = `Bearer ${config.apiKey}`;
      }
      const envelope = await postProviderJson({
        fetchImpl,
        endpoint,
        headers,
        body: {
          model: config.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: input.systemPrompt },
            { role: 'user', content: input.userPrompt },
          ],
        },
        timeoutMs: config.timeoutMs,
        maxResponseBytes: config.maxResponseBytes,
        providerLabel: 'OpenAI-compatible',
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const choices =
        envelope !== null &&
        typeof envelope === 'object' &&
        'choices' in envelope &&
        Array.isArray((envelope as { choices?: unknown }).choices)
          ? (envelope as { choices: unknown[] }).choices
          : null;
      const first = choices?.[0] as
        { message?: { content?: unknown } } | undefined;
      const content = first?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new AiError(
          'AI_INVALID_MODEL_OUTPUT',
          'OpenAI-compatible API response contained no message content',
        );
      }
      return extractJsonObject(content);
    },
  };
}

export function createMockProvider(
  handler: (input: AiProviderInput) => Promise<unknown> | unknown,
  model = 'mock-replay-v1',
): AiProvider {
  return {
    kind: 'mock',
    model,
    async generateJson(input: AiProviderInput): Promise<unknown> {
      return await handler(input);
    },
  };
}

export function createAiProviderFromConfig(
  config: AiConfig,
  fetchImpl: FetchLike = fetch,
): AiProvider {
  if (!config.enabled) {
    throw new AiError(
      'AI_DISABLED',
      'Optional AI synthesis is disabled (set CODETHREAD_AI_ENABLED=1 to opt in)',
    );
  }
  return config.provider === 'gemini'
    ? createGeminiProvider(config, fetchImpl)
    : createOpenAiCompatibleProvider(config, fetchImpl);
}
