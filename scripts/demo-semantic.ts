import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { createInvestigation } from '@codethread/trace-engine';
import { loadSemanticCorpus } from './semantic-corpus.ts';

const { files } = await loadSemanticCorpus();
const snapshot = await analyzeManifest({
  repositoryId: '00000000-0000-4000-8000-000000000001',
  compilerOptions: COMPILER_PROFILE,
  files: files.filter((file) => ['a.ts', 'b.ts', 'c.ts'].includes(file.path)),
});
const investigation = createInvestigation(snapshot.facts, snapshot.source);
const start = snapshot.facts.symbols.find(
  (symbol) => symbol.filePath === 'a.ts' && symbol.name === 'start',
);
const end = snapshot.facts.symbols.find(
  (symbol) => symbol.filePath === 'c.ts' && symbol.name === 'end',
);
if (!start || !end) throw new Error('Demo fixture anchors were not found');
const selection = { snapshotId: snapshot.facts.snapshotId, symbolId: start.id };
const neighbors = investigation.neighbors(selection);
const paths = investigation.paths({
  snapshotId: snapshot.facts.snapshotId,
  fromSymbolId: start.id,
  toSymbolId: end.id,
});
const evidenceIds = [
  ...new Set([
    start.declarationEvidenceId,
    end.declarationEvidenceId,
    ...paths.relations.map((relation) => relation.siteEvidenceId),
  ]),
];
const excerpts = investigation.sourceEvidence({
  snapshotId: snapshot.facts.snapshotId,
  evidenceIds,
});
process.stdout.write(
  JSON.stringify(
    {
      identity: snapshot.facts.identity,
      counts: snapshot.facts.counts,
      coverage: snapshot.facts.coverageByCapability,
      selected: start,
      neighbors,
      paths,
      excerpts,
    },
    null,
    2,
  ) + '\n',
);
