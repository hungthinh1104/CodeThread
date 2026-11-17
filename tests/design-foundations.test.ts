import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  new URL('../scripts/viewer.css', import.meta.url),
  'utf8',
);
const design = readFileSync(
  new URL('../docs/design/DESIGN.md', import.meta.url),
  'utf8',
);
const components = readFileSync(
  new URL('../docs/design/components.md', import.meta.url),
  'utf8',
);
const required = [
  'canvas',
  'surface',
  'raised',
  'ink',
  'muted',
  'border',
  'accent',
  'focus',
  'calls',
  'references',
  'error',
];

function colorTokens(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/--ct-([a-z-]+):\s*(#[0-9a-f]{6});/gi)].map((item) => [
      item[1]!,
      item[2]!.toLowerCase(),
    ]),
  );
}

function luminosity(hex: string): number {
  const parts = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return parts[0]! * 0.2126 + parts[1]! * 0.7152 + parts[2]! * 0.0722;
}

function contrast(first: string, second: string): number {
  const values = [luminosity(first), luminosity(second)].sort(
    (a, b) => a - b,
  );
  return (values[1]! + 0.05) / (values[0]! + 0.05);
}

describe('CT-WORKSPACE-001A visual foundation', () => {
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
  const cssBody = css.indexOf('\n* {', darkStart);
  const light = colorTokens(css.slice(0, darkStart));
  const dark = new Map([
    ...light,
    ...colorTokens(css.slice(darkStart, cssBody)),
  ]);

  it('has complete light/dark roles and readable primary surface text', () => {
    expect(darkStart).toBeGreaterThan(0);
    expect(cssBody).toBeGreaterThan(darkStart);
    for (const [name, theme] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      for (const key of required)
        expect(theme.get(key), `${name}:${key}`).toMatch(/^#[0-9a-f]{6}$/);
      for (const key of [
        'ink',
        'muted',
        'accent',
        'focus',
        'calls',
        'references',
        'error',
      ]) {
        expect(
          contrast(theme.get(key)!, theme.get('surface')!),
          `${name}:${key}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('wires tokens into the existing viewer without external assets', () => {
    expect(css).toContain('background: var(--ct-canvas)');
    expect(css).toContain('color: var(--ct-ink)');
    expect(css).toContain('font-family: var(--ct-code-font)');
    expect(css).not.toMatch(/@import\s|url\(['"]?https?:/i);
    expect(design).toContain('not an approved general product UI');
  });

  it('keeps component layers, semantic statuses and stale-response rules separate', () => {
    expect(components).toContain(
      'Screen → Feature → Domain → Primitive → Tokens',
    );
    for (const item of [
      'ScanStatus',
      'ResolutionStatus',
      'CoverageSummary',
      'TruncationNotice',
      'stale',
      'snapshot',
      'No fabricated nodes',
    ]) {
      expect(components).toContain(item);
    }
  });
});
