import type { SourceReadResult, AnalysisFacts } from '@codethread/code-model';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import { quoted } from './terminal.ts';
const MAX_EXCERPT_CODE_POINTS = 360;
const ORDER = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export function rangeText(
  evidence: SourceReadResult & { status: 'available' },
): string {
  const { start, end } = evidence.evidence.range;
  return `${start.line}:${start.column}-${end.line}:${end.column}`;
}

export function fileHashes(facts: AnalysisFacts): Map<string, string> {
  return new Map(facts.files.map((file) => [file.id, file.contentHash]));
}

export function renderEvidence(
  item: SourceReadResult | undefined,
  hashes: ReadonlyMap<string, string>,
  excerptLimit = MAX_EXCERPT_CODE_POINTS,
): string[] {
  if (!item) return ['  Evidence unavailable: EVIDENCE_NOT_FOUND'];
  if (item.status === 'unavailable')
    return [`  Evidence unavailable: ${item.code}`];
  const rawCharacters = Array.from(item.text);
  const excerpt = rawCharacters.slice(0, excerptLimit).join('');
  const shortened = rawCharacters.length > excerptLimit;
  const hash = hashes.get(item.evidence.fileId);
  return [
    `  Evidence: ${quoted(item.filePath)}@${rangeText(item)} sha256:${hash ?? 'unknown'}`,
    `  Excerpt: ${quoted(excerpt)}${shortened ? ' (shortened; use evidence for complete pages)' : ''}`,
  ];
}

function diagnosticCounts(facts: AnalysisFacts): string[] {
  const counts = new Map<string, number>();
  for (const diagnostic of facts.diagnostics)
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  return [...counts]
    .sort(([left], [right]) => ORDER(left, right))
    .map(([code, count]) => `${code}=${count}`);
}

export function overviewBlocks(snapshot: AnalysisSnapshot): string[] {
  const { facts } = snapshot;
  const coverage = Object.entries(facts.coverageByCapability)
    .sort(([left], [right]) => ORDER(left, right))
    .map(([name, status]) => `${name}=${status}`);
  const diagnostics = diagnosticCounts(facts);
  return [
    'CodeThread textual investigation — static source facts only; no execution or runtime dispatch is observed.',
    `Loaded ${facts.counts.files} files, ${facts.counts.declarations} declarations and ${facts.counts.callSites} call sites (${facts.counts.exact} exact, ${facts.counts.unresolved} unresolved, ${facts.counts.ambiguous} ambiguous, ${facts.counts.unsupported} unsupported).`,
    `Analysis diagnostics: ${facts.diagnostics.length}; not-analyzed inputs: ${facts.counts.notAnalyzedInputs}.`,
    `Coverage: ${coverage.join(', ')}`,
    diagnostics.length > 0
      ? `Diagnostic codes: ${diagnostics.join(', ')}`
      : 'Diagnostic codes: none',
    'Commands: files | symbols [path] | inspect <path@line:column|name:value> [calls|references|calls,references] [incoming|outgoing|both] | follow <path@line:column> [filters] | evidence symbol <path@line:column> [offset] | evidence site <path@start-end> [offset] | help | quit',
  ];
}

export function helpBlocks(): string[] {
  return [
    'files — list manifest paths and verified content hashes.',
    'symbols [path] — list declarations with stable path@line:column selectors.',
    'inspect <selector> [kinds] [direction] — inspect one-hop relationships; kinds default to calls.',
    'follow <path@line:column> [kinds] [direction] — inspect an exact target shown by the previous result without re-analysis.',
    'Use references or calls,references to explicitly include REFERENCES; direction defaults to both.',
    'evidence symbol <selector> [offset] — page through the full declaration evidence in UTF-16 units.',
    'evidence site <path@startLine:startColumn-endLine:endColumn> [offset] — page through exact occurrence evidence.',
    'Names can be searched with name:<name> only when unique; ambiguous names return candidates, never a first match.',
    'All relationships are static source facts. The CLI does not establish execution, registration success or runtime dispatch.',
  ];
}
