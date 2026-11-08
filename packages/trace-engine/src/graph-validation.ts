import {
  codeRelationSchema,
  diagnosticSchema,
  sourceRangeSchema,
  symbolSchema,
} from '@codethread/code-model';
import type { AnalysisFacts } from '@codethread/code-model';
import { ensure, sameRange } from './fact-integrity.js';
import type { RetainedSource } from './source-validation.js';

export function validateGraph(
  facts: AnalysisFacts,
  sources: ReadonlyMap<string, RetainedSource>,
): void {
  const snapshot = facts.snapshotId;
  const files = new Map(facts.files.map((file) => [file.id, file]));
  const evidence = new Map(facts.evidenceRefs.map((item) => [item.id, item]));
  const symbols = new Map(facts.symbols.map((item) => [item.id, item]));
  for (const symbol of facts.symbols) {
    symbolSchema.parse(symbol);
    const file = files.get(symbol.fileId),
      primary = evidence.get(symbol.declarationEvidenceId);
    ensure(
      file &&
        primary &&
        symbol.snapshotId === snapshot &&
        symbol.filePath === file.path &&
        primary.fileId === file.id &&
        sameRange(symbol.range, primary.range),
    );
    ensure(symbol.evidenceIds.every((id: string) => evidence.has(id)));
  }
  const diagnostics = new Map(facts.diagnostics.map((item) => [item.id, item]));
  for (const diagnostic of facts.diagnostics) {
    diagnosticSchema.parse(diagnostic);
    ensure(diagnostic.snapshotId === snapshot);
    if (diagnostic.fileId) {
      const file = files.get(diagnostic.fileId),
        source = sources.get(diagnostic.fileId);
      ensure(
        file &&
          source &&
          diagnostic.filePath === file.path &&
          (!diagnostic.range ||
            source.positions.validateRange(diagnostic.range)),
      );
    }
  }
  for (const relation of facts.relations) {
    codeRelationSchema.parse(relation);
    const owner = symbols.get(relation.sourceSymbolId),
      site = evidence.get(relation.siteEvidenceId);
    ensure(
      owner &&
        site &&
        relation.snapshotId === snapshot &&
        site.fileId === owner.fileId &&
        (relation.kind !== 'calls' ||
          owner.kind === 'function' ||
          owner.kind === 'method'),
    );
    ensure(
      sourceRangeSchema.safeParse({
        start: owner.range.start,
        end: site.range.start,
      }).success &&
        sourceRangeSchema.safeParse({
          start: site.range.end,
          end: owner.range.end,
        }).success,
    );
    ensure(
      relation.resolution.evidenceIds.every((id: string) => evidence.has(id)) &&
        relation.resolution.evidenceIds.includes(owner.declarationEvidenceId),
    );
    if (relation.resolution.status === 'exact') {
      const target = symbols.get(relation.resolution.targetId);
      ensure(
        target &&
          (relation.kind !== 'references' || target.kind === 'method') &&
          relation.resolution.evidenceIds.includes(
            target.declarationEvidenceId,
          ),
      );
    } else
      ensure(
        relation.resolution.diagnosticIds.every((id: string) =>
          diagnostics.has(id),
        ),
      );
  }
}
