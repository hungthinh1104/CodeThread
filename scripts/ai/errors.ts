import type { AiErrorCode } from '@codethread/contracts';

export class AiError extends Error {
  readonly code: AiErrorCode;

  constructor(code: AiErrorCode, message: string) {
    super(sanitizeAiMessage(message));
    this.name = 'AiError';
    this.code = code;
  }
}

export function sanitizeAiMessage(message: string): string {
  const compact = message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(?:api[_-]?key|x-goog-api-key|authorization)\s*[:=]\s*[^\s,;]+/gi,
      '[REDACTED]',
    )
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[0-9A-Za-z]{30,}/g, '[REDACTED]')
    .replace(/\bxox[abeoprs]-[0-9A-Za-z-]{10,}/g, '[REDACTED]')
    .replace(
      /\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}/g,
      '[REDACTED]',
    )
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
    .replace(/sk-[0-9A-Za-z_-]{16,}/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length === 0) return 'AI synthesis failed';
  return compact.length <= 512 ? compact : `${compact.slice(0, 509)}...`;
}
