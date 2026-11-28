export interface RedactionResult {
  readonly text: string;
  readonly redacted: boolean;
}

interface RedactionRule {
  readonly pattern: RegExp;
  readonly replace:
    string | ((substring: string, ...groups: string[]) => string);
}

const RULES: readonly RedactionRule[] = [
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: '[REDACTED_PRIVATE_KEY]',
  },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: '[REDACTED_AWS_KEY]' },
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}/g, replace: '[REDACTED_API_KEY]' },
  { pattern: /\bsk-[0-9A-Za-z_-]{16,}/g, replace: '[REDACTED_API_KEY]' },
  {
    pattern: /\bgh[pousr]_[0-9A-Za-z]{30,}/g,
    replace: '[REDACTED_GITHUB_TOKEN]',
  },
  { pattern: /\bxox[abeoprs]-[0-9A-Za-z-]{10,}/g, replace: '[REDACTED_TOKEN]' },
  {
    pattern: /\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}/g,
    replace: '[REDACTED_JWT]',
  },
  {
    pattern:
      /(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth(?:orization)?)\b["']?\s*[:=]\s*)(["'`])[^"'`\r\n]{4,}\2/gi,
    replace: (_match, prefix: string, quote: string) =>
      `${prefix}${quote}[REDACTED]${quote}`,
  },
];

/**
 * Best-effort removal of secret-like substrings before excerpts leave the
 * process. This is a defense-in-depth filter, not a guarantee: callers must
 * still treat remote providers as an explicit disclosure decision.
 */
export function redactSecrets(text: string): RedactionResult {
  let current = text;
  for (const rule of RULES) {
    current = current.replace(rule.pattern, rule.replace as string);
  }
  return { text: current, redacted: current !== text };
}
