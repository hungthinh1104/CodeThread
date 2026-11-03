import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  loadRegistry,
  parseRegistry,
  RegistryError,
  requirementContext,
  runRequirements,
} from '../scripts/requirements.ts';
import type { Requirement } from '../scripts/requirements.ts';

const requirement = (
  id = 'CT-CORE-001',
  depends_on: string[] = [],
): Requirement => ({
  id,
  title: 'Observable behavior',
  module: 'foundation',
  statement: 'The system shall preserve an observable invariant.',
  lifecycle: 'accepted',
  priority: 'must',
  acceptance: [
    {
      id: 'AC-01',
      given: 'A supported input',
      then: 'The invariant is preserved.',
    },
  ],
  depends_on,
  verification: { method: 'automated' },
});
const files = (...records: unknown[]) =>
  records.map((record, index) => ({
    path: `${index}.yaml`,
    content: JSON.stringify(record),
  }));

describe('CT-CORE-002 registry validation', () => {
  it('validates the real registry and returns sorted stable identities', async () => {
    const registry = await loadRegistry();
    expect(registry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'CT-CORE-005',
          lifecycle: 'accepted',
          module: 'code-model',
        }),
        expect.objectContaining({
          id: 'CT-INDEX-001',
          lifecycle: 'accepted',
          module: 'symbol-indexer',
        }),
        expect.objectContaining({
          id: 'CT-SOURCE-001',
          lifecycle: 'accepted',
          module: 'application',
        }),
        expect.objectContaining({
          id: 'CT-VIEW-001',
          lifecycle: 'accepted',
          module: 'application',
        }),
      ]),
    );
    expect(registry.map((entry) => entry.id)).toEqual(
      registry.map((entry) => entry.id).sort(),
    );
    expect(await runRequirements(['show', 'CT-DB-014'])).toMatchObject({
      id: 'CT-DB-014',
      lifecycle: 'accepted',
    });
  });
  it('rejects duplicate IDs and acceptance IDs', async () => {
    await expect(
      parseRegistry(files(requirement(), requirement())),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ID' });
    const record = requirement();
    record.acceptance.push(record.acceptance[0]!);
    await expect(parseRegistry(files(record))).rejects.toMatchObject({
      code: 'DUPLICATE_ACCEPTANCE',
    });
  });
  it.each([
    'id: CT-CORE-001\nid: CT-CORE-002\n',
    'id: [unterminated',
    'id: !custom value',
    'id: &id CT-CORE-001\ntitle: *id',
  ])(
    'rejects malformed, duplicate-key or noncanonical YAML',
    async (content) => {
      await expect(
        parseRegistry([{ path: 'bad.yaml', content }]),
      ).rejects.toBeInstanceOf(RegistryError);
    },
  );
  it('rejects unknown references, self-cycles and multi-requirement cycles', async () => {
    await expect(
      parseRegistry(files(requirement('CT-CORE-001', ['CT-CORE-999']))),
    ).rejects.toMatchObject({ code: 'UNKNOWN_DEPENDENCY' });
    await expect(
      parseRegistry(files(requirement('CT-CORE-001', ['CT-CORE-001']))),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
    await expect(
      parseRegistry(
        files(
          requirement('CT-CORE-001', ['CT-CORE-002']),
          requirement('CT-CORE-002', ['CT-CORE-001']),
        ),
      ),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
  });
  it.each([
    { acceptance: [] },
    { lifecycle: 'done' },
    { acceptance: [{ id: 'AC-01', given: 'input', then: ' ' }] },
    { issue_status: 'In Progress' },
    { depends_on: ['CT-CORE-002', 'CT-CORE-002'] },
    { priority: undefined },
  ])(
    'rejects schema violations and implementation status in requirements',
    async (override) => {
      await expect(
        parseRegistry(files({ ...requirement(), ...override })),
      ).rejects.toMatchObject({ code: 'INVALID_REQUIREMENT' });
    },
  );
  it('returns deterministic output regardless of file ordering', async () => {
    const input = files(
      requirement('CT-CORE-002', ['CT-CORE-001']),
      requirement(),
    );
    expect(await parseRegistry(input)).toEqual(
      await parseRegistry([...input].reverse()),
    );
  });
});

describe('Bounded agent context and CLI', () => {
  it('bounds dependency count and reports omitted records', () => {
    const dependencies = Array.from({ length: 25 }, (_, index) =>
      requirement(`CT-CORE-${String(index + 2).padStart(3, '0')}`),
    );
    const root = requirement(
      'CT-CORE-001',
      dependencies.map((entry) => entry.id),
    );
    const output = requirementContext([root, ...dependencies], root.id);
    expect(output).toMatchObject({
      truncated: true,
      omittedCount: 5,
      truncationReasons: ['dependency_limit'],
    });
    expect((output as { dependencies: unknown[] }).dependencies).toHaveLength(
      20,
    );
    expect(
      Buffer.byteLength(JSON.stringify(output) + '\n'),
    ).toBeLessThanOrEqual(65536);
  });
  it('bounds depth and UTF-8 byte size without corrupting JSON', async () => {
    const root = requirement('CT-CORE-001', ['CT-CORE-002']);
    const child = requirement('CT-CORE-002', ['CT-CORE-003']);
    const grandchild = requirement('CT-CORE-003', ['CT-CORE-004']);
    const leaf = requirement('CT-CORE-004');
    expect(
      requirementContext([root, child, grandchild, leaf], root.id),
    ).toMatchObject({
      truncated: true,
      omittedCount: 1,
      truncationReasons: ['depth_limit'],
    });
    const big = requirement('CT-CORE-002');
    big.acceptance = Array.from({ length: 6 }, (_, index) => ({
      id: `AC-${String(index + 1).padStart(2, '0')}`,
      given: '😀'.repeat(4000),
      then: '😀'.repeat(4000),
    }));
    await expect(parseRegistry(files(big))).resolves.toHaveLength(1);
    const output = requirementContext([root, big], root.id);
    expect(output).toMatchObject({
      truncated: true,
      truncationReasons: ['byte_limit'],
      omittedCount: 1,
    });
    expect(JSON.parse(JSON.stringify(output))).toEqual(output);
    expect(
      Buffer.byteLength(JSON.stringify(output) + '\n'),
    ).toBeLessThanOrEqual(65536);
    expect(() => requirementContext([big], big.id)).toThrow(RegistryError);
  });
  it('does not silently accept unknown IDs or extra command arguments', async () => {
    await expect(
      runRequirements(['show', 'CT-CORE-999']),
    ).rejects.toMatchObject({ code: 'UNKNOWN_ID' });
    await expect(runRequirements(['list', 'extra'])).rejects.toMatchObject({
      code: 'USAGE',
    });
    await expect(runRequirements(['unknown'])).rejects.toMatchObject({
      code: 'USAGE',
    });
  });
  it('runs with native Node TypeScript and emits machine-readable JSON and failure codes', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/requirements.ts', 'context', 'CT-DB-014'],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(output)).toMatchObject({
      requirement: { id: 'CT-DB-014' },
    });
    const failure = spawnSync(
      process.execPath,
      ['scripts/requirements.ts', 'show', 'CT-CORE-999'],
      { encoding: 'utf8' },
    );
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe('');
    expect(JSON.parse(failure.stderr)).toMatchObject({
      error: { code: 'UNKNOWN_ID' },
    });
  });
});
