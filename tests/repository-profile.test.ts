import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  analysisResourceLimits,
  withinAnalysisCollectionLimits,
} from '@codethread/code-model';
import {
  analyzeManifest,
  COMPILER_PROFILE,
  PROJECT_LIMITS,
} from '@codethread/symbol-indexer';
import { createInvestigation } from '@codethread/trace-engine';

const repositoryId = '00000000-0000-4000-8000-000000000071';
const files = Array.from({ length: 21 }, (_, index) => {
  const bytes = new TextEncoder().encode(
    `export function source${index}() { return ${index}; }`,
  );
  return {
    path: `source${index}.ts`,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
});

describe('repository resource profile through the semantic pipeline', () => {
  it('keeps repository resource limits within the declared safety bounds', () => {
    const limits = analysisResourceLimits('repository');
    const facts = {
      files: [],
      symbols: [],
      relations: [],
      evidenceRefs: [],
      diagnostics: [],
      observations: new Array(50_000),
    };

    expect(analysisResourceLimits('selected').maxCallSites).toBe(5000);
    expect(
      analysisResourceLimits('selected').maxFullSemanticDiagnosticFiles,
    ).toBe(20);
    expect(limits.maxCallSites).toBe(50_000);
    expect(limits.maxFullSemanticDiagnosticFiles).toBe(64);
    expect(PROJECT_LIMITS.maxSessionResultBytes).toBe(128 * 1024 * 1024);
    expect(withinAnalysisCollectionLimits(facts, limits)).toBe(true);
    expect(
      withinAnalysisCollectionLimits(
        { ...facts, observations: new Array(50_001) },
        limits,
      ),
    ).toBe(false);
  });

  it('rejects call occurrences above the repository limit', async () => {
    const callCount = 50_001;
    const source = `function target() {}\nexport function caller() {\n${'  target();\n'.repeat(callCount)}}\n`;
    const bytes = new TextEncoder().encode(source);
    await expect(
      analyzeManifest({
        repositoryId,
        compilerOptions: COMPILER_PROFILE,
        files: [
          {
            path: 'many-calls.ts',
            bytes,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
        resourceProfile: 'repository',
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  }, 60000);

  it('admits more than twenty files consistently through verified graph queries', async () => {
    const snapshot = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files,
      resourceProfile: 'repository',
    });
    expect(snapshot.execution).toMatchObject({
      compilerMs: expect.any(Number),
      extractionMs: expect.any(Number),
      factValidationMs: expect.any(Number),
      inputPreparationMs: expect.any(Number),
      workerElapsedMs: expect.any(Number),
    });
    expect(snapshot.execution?.compilerMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.execution?.extractionMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.execution?.factValidationMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.facts.files).toHaveLength(21);
    expect(snapshot.facts.symbols.map((symbol) => symbol.name).sort()).toEqual(
      Array.from({ length: 21 }, (_, index) => `source${index}`).sort(),
    );
    const investigation = createInvestigation(snapshot.facts, snapshot.source, {
      resourceProfile: 'repository',
    });
    const root = snapshot.facts.symbols.find(
      (symbol) => symbol.name === 'source20',
    )!;
    const result = investigation.neighbors({
      snapshotId: snapshot.facts.snapshotId,
      symbolId: root.id,
    });
    expect(result.symbols.map((symbol) => symbol.id)).toContain(root.id);
    expect(result.relations).toHaveLength(0);
  }, 30000);

  it('preserves the selected-file default and rejects an unknown profile', async () => {
    await expect(
      analyzeManifest({
        repositoryId,
        compilerOptions: COMPILER_PROFILE,
        files,
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    await expect(
      analyzeManifest({
        repositoryId,
        compilerOptions: COMPILER_PROFILE,
        files: files.slice(0, 1),
        resourceProfile: 'unbounded' as 'repository',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  it('cancels before spawning a compiler without publishing a snapshot', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      analyzeManifest({
        repositoryId,
        compilerOptions: COMPILER_PROFILE,
        files: files.slice(0, 1),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
