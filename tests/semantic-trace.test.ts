import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import { createInvestigation } from '@codethread/trace-engine';
import { loadSemanticCorpus } from '../scripts/semantic-corpus.ts';

let snapshot: AnalysisSnapshot;
beforeAll(async () => {
  const corpus = await loadSemanticCorpus();
  snapshot = await analyzeManifest({
    repositoryId: '00000000-0000-4000-8000-000000000001',
    compilerOptions: COMPILER_PROFILE,
    files: corpus.files.filter((file) =>
      ['a.ts', 'b.ts', 'c.ts'].includes(file.path),
    ),
  });
}, 15000);

describe('CT-INDEX-001A in-memory code investigation', () => {
  it('retains unresolved sites and diagnostics without creating target symbols', async () => {
    const corpus = await loadSemanticCorpus();
    const all = await analyzeManifest({
      repositoryId: '00000000-0000-4000-8000-000000000001',
      compilerOptions: COMPILER_PROFILE,
      files: corpus.files,
    });
    const caller = all.facts.symbols.find(
      (item) => item.filePath === 'negative.ts' && item.name === 'caller',
    )!;
    const graph = createInvestigation(all.facts, all.source).neighbors({
      snapshotId: all.facts.snapshotId,
      symbolId: caller.id,
    });
    expect(graph.symbols).toHaveLength(1);
    expect(graph.relations.length).toBeGreaterThan(0);
    expect(
      graph.relations.every(
        (relation) =>
          relation.resolution.status !== 'exact' &&
          relation.resolution.targetId === null,
      ),
    ).toBe(true);
    expect(graph.diagnostics.map((item) => item.code)).toContain(
      'TARGET_UNRESOLVED',
    );
    expect(graph.meta.coverage).toBe('partial');
  }, 15000);
  it('handles recursion and bidirectional cycles within the requested depth', () => {
    const investigation = createInvestigation(snapshot.facts, snapshot.source);
    const end = snapshot.facts.symbols.find(
      (item) => item.filePath === 'c.ts' && item.name === 'end',
    )!;
    const graph = investigation.neighbors({
      snapshotId: snapshot.facts.snapshotId,
      symbolId: end.id,
      direction: 'both',
      depth: 1,
    });
    expect(
      graph.relations.some(
        (relation) =>
          relation.sourceSymbolId === end.id &&
          relation.resolution.status === 'exact' &&
          relation.resolution.targetId === end.id,
      ),
    ).toBe(true);
    const self = investigation.paths({
      snapshotId: snapshot.facts.snapshotId,
      fromSymbolId: end.id,
      toSymbolId: end.id,
    });
    expect(self.paths).toEqual([{ symbolIds: [end.id], relationIds: [] }]);
  });
  it('rejects duplicate canonical keys and corrupted retained bytes', () => {
    const duplicate = structuredClone(snapshot.facts);
    duplicate.symbols[1]!.key = duplicate.symbols[0]!.key;
    expect(() => createInvestigation(duplicate, snapshot.source)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FACTS' }),
    );
    const broken = {
      ...snapshot.source,
      readFile(id: string) {
        const bytes = snapshot.source.readFile(id);
        if (bytes?.length) bytes[0] = bytes[0]! ^ 1;
        return bytes;
      },
    };
    expect(() => createInvestigation(snapshot.facts, broken)).toThrowError(
      expect.objectContaining({ code: 'HASH_MISMATCH' }),
    );
  });
  it('never exposes a mutable view of retained source bytes', () => {
    const relation = snapshot.facts.relations.find(
      (item) =>
        item.sourceSymbolId ===
        snapshot.facts.symbols.find((symbol) => symbol.name === 'start')!.id,
    )!;
    const evidence = snapshot.facts.evidenceRefs.find(
      (item) => item.id === relation.siteEvidenceId,
    )!;
    const copy = snapshot.source.readFile(evidence.fileId)!;
    copy.fill(0);
    expect(snapshot.source.readEvidence(evidence.id)).toMatchObject({
      status: 'available',
      text: 'alias()',
    });
  });
  it('rejects a relation that omits its source or target declaration evidence', () => {
    const changed = structuredClone(snapshot.facts);
    const relation = changed.relations.find(
      (item) => item.resolution.status === 'exact',
    )!;
    relation.resolution.evidenceIds = [relation.siteEvidenceId];
    expect(() => createInvestigation(changed, snapshot.source)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FACTS' }),
    );
  });
  it('rejects valid coordinates attached to the wrong declaration range', () => {
    const changed = structuredClone(snapshot.facts);
    const start = changed.symbols.find(
      (item) => item.filePath === 'a.ts' && item.name === 'start',
    )!;
    const local = changed.symbols.find(
      (item) => item.filePath === 'a.ts' && item.name === 'local',
    )!;
    changed.evidenceRefs.find(
      (item) => item.id === start.declarationEvidenceId,
    )!.range = local.range;
    expect(() => createInvestigation(changed, snapshot.source)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FACTS' }),
    );
  });
  it('rejects a wrong excerpt even when it has the correct length', () => {
    const wrong = {
      ...snapshot.source,
      readEvidence(id: string) {
        const item = snapshot.source.readEvidence(id);
        return item.status === 'available'
          ? { ...item, text: 'x'.repeat(item.text.length) }
          : item;
      },
    };
    const investigation = createInvestigation(snapshot.facts, wrong);
    const relation = snapshot.facts.relations[0]!;
    expect(
      investigation.sourceEvidence({
        snapshotId: snapshot.facts.snapshotId,
        evidenceIds: [relation.siteEvidenceId],
      }).items[0],
    ).toMatchObject({ status: 'unavailable', code: 'SOURCE_UNAVAILABLE' });
  });
  it('honors direction, node and path limits without dangling or disconnected results', () => {
    const investigation = createInvestigation(snapshot.facts, snapshot.source);
    const start = snapshot.facts.symbols.find(
      (item) => item.filePath === 'a.ts' && item.name === 'start',
    )!;
    const middle = snapshot.facts.symbols.find(
      (item) => item.filePath === 'b.ts' && item.name === 'middle',
    )!;
    const end = snapshot.facts.symbols.find(
      (item) => item.filePath === 'c.ts' && item.name === 'end',
    )!;
    const incoming = investigation.neighbors({
      snapshotId: snapshot.facts.snapshotId,
      symbolId: middle.id,
      direction: 'incoming',
      depth: 1,
    });
    expect(incoming.symbols.map((item) => item.id)).toContain(start.id);
    expect(incoming.symbols.map((item) => item.id)).not.toContain(end.id);
    const limited = investigation.neighbors({
      snapshotId: snapshot.facts.snapshotId,
      symbolId: start.id,
      nodeLimit: 1,
    });
    expect(limited.symbols).toHaveLength(1);
    expect(limited.relations).toHaveLength(0);
    expect(limited.meta.truncationReasons).toContain('result_limit');
    const one = investigation.paths({
      snapshotId: snapshot.facts.snapshotId,
      fromSymbolId: start.id,
      toSymbolId: end.id,
      pathLimit: 1,
    });
    expect(one.paths).toHaveLength(1);
    expect(one.meta.truncationReasons).toContain('result_limit');
    const shallow = investigation.paths({
      snapshotId: snapshot.facts.snapshotId,
      fromSymbolId: start.id,
      toSymbolId: end.id,
      depth: 1,
    });
    expect(shallow.paths).toHaveLength(0);
    expect(shallow.meta.truncationReasons).toContain('depth_limit');
    expect(() =>
      investigation.paths({
        snapshotId: snapshot.facts.snapshotId,
        fromSymbolId: start.id,
        toSymbolId: end.id,
        nodeLimit: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
  });
  it('follows a three-file chain with distinct calls and verified source excerpts', async () => {
    const investigation = createInvestigation(snapshot.facts, snapshot.source);
    const start = snapshot.facts.symbols.find(
      (symbol) => symbol.filePath === 'a.ts' && symbol.name === 'start',
    )!;
    const end = snapshot.facts.symbols.find(
      (symbol) => symbol.filePath === 'c.ts' && symbol.name === 'end',
    )!;
    const neighbors = investigation.neighbors({
      snapshotId: snapshot.facts.snapshotId,
      symbolId: start.id,
    });
    expect(neighbors.symbols.map((symbol) => symbol.name)).toContain('middle');
    const paths = investigation.paths({
      snapshotId: snapshot.facts.snapshotId,
      fromSymbolId: start.id,
      toSymbolId: end.id,
    });
    expect(paths.paths).toHaveLength(2);
    expect(paths.paths[0]!.relationIds[0]).not.toBe(
      paths.paths[1]!.relationIds[0],
    );
    const relation = paths.relations.find(
      (item) => item.id === paths.paths[0]!.relationIds[0],
    )!;
    const excerpts = investigation.sourceEvidence({
      snapshotId: snapshot.facts.snapshotId,
      evidenceIds: [relation.siteEvidenceId],
    });
    expect(excerpts.items).toEqual([
      expect.objectContaining({
        status: 'available',
        filePath: 'a.ts',
        text: 'alias()',
      }),
    ]);
  }, 15000);
});
