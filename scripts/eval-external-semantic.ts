import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { createInvestigation } from '@codethread/trace-engine';
import { evaluateSemantic } from './eval-semantic.ts';
import { loadExternalCorpus } from './external-semantic-corpus.ts';

const ratio = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  value: denominator ? numerator / denominator : null,
});

for (const name of ['tinyexec', 'todo'] as const) {
  try {
    const { gold, files } = await loadExternalCorpus(name);
    const snapshot = await analyzeManifest({
      repositoryId:
        name === 'tinyexec'
          ? '00000000-0000-4000-8000-000000000011'
          : '00000000-0000-4000-8000-000000000012',
      compilerOptions: COMPILER_PROFILE,
      files,
    });
    const report = evaluateSemantic(gold, snapshot);
    const diagnostics = new Map(
      snapshot.facts.diagnostics.map((item) => [item.id, item]),
    );
    const unsupported: Record<string, number> = {};
    for (const item of snapshot.facts.observations) {
      if (item.status !== 'unsupported') continue;
      const code = item.diagnosticId
        ? diagnostics.get(item.diagnosticId)?.code
        : undefined;
      const reason = code ?? 'MISSING_DIAGNOSTIC';
      unsupported[reason] = (unsupported[reason] ?? 0) + 1;
    }
    const observed = new Map<
      string,
      Array<(typeof snapshot.facts.observations)[number]>
    >();
    for (const item of snapshot.facts.observations) {
      const evidence = snapshot.source.readEvidence(item.evidenceId);
      if (evidence.status !== 'available') continue;
      const { start, end } = evidence.evidence.range;
      const key = JSON.stringify([
        evidence.filePath,
        start.line,
        start.column,
        [end.line, end.column],
      ]);
      const rows = observed.get(key) ?? [];
      rows.push(item);
      observed.set(key, rows);
    }
    const eligibleAnalyzed = gold.calls.filter((call) => {
      const rows =
        observed.get(
          JSON.stringify([call.file, call.line, call.column, call.end]),
        ) ?? [];
      return (
        call.eligible && rows.length === 1 && rows[0]!.status !== 'unsupported'
      );
    }).length;
    const investigation = createInvestigation(snapshot.facts, snapshot.source);
    const select = (symbolName: string) => {
      const symbol = snapshot.facts.symbols.find(
        (item) => item.name === symbolName,
      );
      if (!symbol)
        throw new Error(`Missing investigation anchor ${symbolName}`);
      return symbol;
    };
    const root = select(name === 'tinyexec' ? 'computeEnv' : 'routes');
    const target = select(
      name === 'tinyexec' ? 'getPathFromEnv' : 'todoRouter',
    );
    const neighbors = investigation.neighbors({
      snapshotId: snapshot.facts.snapshotId,
      symbolId: root.id,
      direction: 'outgoing',
      depth: 2,
    });
    const incoming = investigation.neighbors({
      snapshotId: snapshot.facts.snapshotId,
      symbolId: target.id,
      direction: 'incoming',
      depth: 1,
    });
    const paths = investigation.paths({
      snapshotId: snapshot.facts.snapshotId,
      fromSymbolId: root.id,
      toSymbolId: target.id,
    });
    const evidenceIds = [
      ...new Set([
        ...paths.relations.map((item) => item.siteEvidenceId),
        root.declarationEvidenceId,
        target.declarationEvidenceId,
      ]),
    ];
    const excerpts = investigation.sourceEvidence({
      snapshotId: snapshot.facts.snapshotId,
      evidenceIds,
    });
    const result = {
      name,
      repository: gold.repository,
      revision: gold.revision,
      files: gold.files,
      authoredBeforePredictions: true,
      review: gold.review,
      ...report,
      supportedCoverage: ratio(eligibleAnalyzed, gold.calls.length),
      exactCoverage: ratio(
        report.counts.correctExactResolutions,
        gold.calls.length,
      ),
      unsupportedByDiagnostic: unsupported,
      resourceFailures: [],
      coverageByCapability: snapshot.facts.coverageByCapability,
      investigation: {
        root: root.name,
        target: target.name,
        neighbors,
        incoming,
        paths,
        excerpts,
      },
    };
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!report.gate.passed) process.exitCode = 1;
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'UNCLASSIFIED_ERROR';
    process.stdout.write(
      JSON.stringify({
        name,
        resourceOrInputFailure: {
          code,
          message: error instanceof Error ? error.message : String(error),
        },
      }) + '\n',
    );
    process.exitCode = 1;
  }
}
