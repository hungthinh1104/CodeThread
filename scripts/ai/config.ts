import { AiError } from './errors.ts';

export const DEFAULT_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:11434/v1';
export const DEFAULT_OPENAI_COMPATIBLE_MODEL = 'qwen2.5-coder:7b';
export const DEFAULT_AI_TIMEOUT_MS = 15_000;
export const DEFAULT_AI_MAX_RESPONSE_BYTES = 131_072;

export type AiLocality = 'local' | 'remote';

export interface DisabledAiConfig {
  readonly enabled: false;
}

export interface EnabledGeminiConfig {
  readonly enabled: true;
  readonly provider: 'gemini';
  readonly locality: AiLocality;
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface EnabledOpenAiCompatibleConfig {
  readonly enabled: true;
  readonly provider: 'openai_compatible';
  readonly locality: AiLocality;
  readonly apiKey: string | null;
  readonly model: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export type AiConfig =
  DisabledAiConfig | EnabledGeminiConfig | EnabledOpenAiCompatibleConfig;

function readInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new AiError(
      'AI_INVALID_CONFIG',
      `${name} must be an integer between ${min} and ${max}`,
    );
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new AiError(
      'AI_INVALID_CONFIG',
      `${name} must be an integer between ${min} and ${max}`,
    );
  }
  return parsed;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  );
}

function validateBaseUrl(
  raw: string,
  label: string,
): { baseUrl: string; locality: AiLocality } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AiError('AI_INVALID_CONFIG', `${label} must be a valid URL`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new AiError(
      'AI_INVALID_CONFIG',
      `${label} must not embed credentials`,
    );
  }
  if (url.search !== '' || url.hash !== '') {
    throw new AiError(
      'AI_INVALID_CONFIG',
      `${label} must not include query or fragment components`,
    );
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new AiError(
      'AI_INVALID_CONFIG',
      `${label} must use https or loopback http`,
    );
  }
  return {
    baseUrl: url.toString().replace(/\/+$/, ''),
    locality: loopback ? 'local' : 'remote',
  };
}

function assertRemoteConsent(
  locality: AiLocality,
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (
    locality === 'remote' &&
    env['CODETHREAD_AI_ALLOW_REMOTE']?.trim() !== '1'
  ) {
    throw new AiError(
      'AI_INVALID_CONFIG',
      'CODETHREAD_AI_ALLOW_REMOTE=1 is required when using a non-loopback AI provider',
    );
  }
}

function readModel(raw: string | undefined, fallback: string): string {
  const model = (raw ?? fallback).trim();
  if (model.length === 0 || model.length > 128 || /[\s/?#]/.test(model)) {
    throw new AiError(
      'AI_INVALID_CONFIG',
      'CODETHREAD_AI_MODEL must be a non-empty identifier without whitespace',
    );
  }
  return model;
}

/**
 * Loads opt-in AI configuration from environment variables.
 * Disabled by default unless CODETHREAD_AI_ENABLED is explicitly set to "1".
 * Defaults to local Ollama (openai_compatible on loopback) when enabled so
 * source excerpts never leave the machine without CODETHREAD_AI_ALLOW_REMOTE=1.
 */
export function loadAiConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AiConfig {
  const enabledFlag = env['CODETHREAD_AI_ENABLED']?.trim();
  if (enabledFlag !== '1') return { enabled: false };

  const providerRaw = (env['CODETHREAD_AI_PROVIDER'] ?? 'openai_compatible')
    .trim()
    .toLowerCase();
  const timeoutMs = readInt(
    env['CODETHREAD_AI_TIMEOUT_MS'],
    DEFAULT_AI_TIMEOUT_MS,
    1_000,
    60_000,
    'CODETHREAD_AI_TIMEOUT_MS',
  );
  const maxResponseBytes = readInt(
    env['CODETHREAD_AI_MAX_RESPONSE_BYTES'],
    DEFAULT_AI_MAX_RESPONSE_BYTES,
    4_096,
    524_288,
    'CODETHREAD_AI_MAX_RESPONSE_BYTES',
  );

  if (providerRaw === 'gemini') {
    const apiKey = (
      env['GEMINI_API_KEY'] ??
      env['CODETHREAD_AI_API_KEY'] ??
      ''
    ).trim();
    if (apiKey.length === 0) {
      throw new AiError(
        'AI_INVALID_CONFIG',
        'GEMINI_API_KEY is required when CODETHREAD_AI_PROVIDER=gemini',
      );
    }
    const { baseUrl, locality } = validateBaseUrl(
      (env['CODETHREAD_AI_BASE_URL'] ?? DEFAULT_GEMINI_BASE_URL).trim(),
      'CODETHREAD_AI_BASE_URL',
    );
    assertRemoteConsent(locality, env);
    return {
      enabled: true,
      provider: 'gemini',
      locality,
      apiKey,
      model: readModel(env['CODETHREAD_AI_MODEL'], DEFAULT_GEMINI_MODEL),
      baseUrl,
      timeoutMs,
      maxResponseBytes,
    };
  }

  if (providerRaw === 'openai_compatible' || providerRaw === 'ollama') {
    const { baseUrl, locality } = validateBaseUrl(
      (
        env['CODETHREAD_AI_BASE_URL'] ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL
      ).trim(),
      'CODETHREAD_AI_BASE_URL',
    );
    assertRemoteConsent(locality, env);
    const apiKey = (env['CODETHREAD_AI_API_KEY'] ?? '').trim() || null;
    if (locality === 'remote' && apiKey === null) {
      throw new AiError(
        'AI_INVALID_CONFIG',
        'CODETHREAD_AI_API_KEY is required for non-loopback openai_compatible endpoints',
      );
    }
    return {
      enabled: true,
      provider: 'openai_compatible',
      locality,
      apiKey,
      model: readModel(
        env['CODETHREAD_AI_MODEL'],
        DEFAULT_OPENAI_COMPATIBLE_MODEL,
      ),
      baseUrl,
      timeoutMs,
      maxResponseBytes,
    };
  }

  throw new AiError(
    'AI_INVALID_CONFIG',
    'CODETHREAD_AI_PROVIDER must be gemini or openai_compatible',
  );
}
