import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { evaluateSemantic } from './eval-semantic.ts';
import { loadExternalCorpus } from './external-semantic-corpus.ts';
import {
  collectExternalGraph,
  validateExternalGraph,
} from './external-semantic-graph.ts';

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
    const investigation = collectExternalGraph(
      name,
      snapshot.facts,
      snapshot.source,
    );
    validateExternalGraph(name, gold, files, snapshot.facts, investigation);
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
      graphEvaluation: {
        independentlyPinned: true,
        interpretation:
          'Static source relationships only; runtime behavior was not observed.',
      },
      unsupportedByDiagnostic: unsupported,
      resourceFailures: [],
      coverageByCapability: snapshot.facts.coverageByCapability,
      investigation,
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
