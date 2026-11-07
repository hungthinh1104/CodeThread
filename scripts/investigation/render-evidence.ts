import type { AnalysisFacts, SourceReadResult } from '@codethread/code-model';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import type { createInvestigation } from '@codethread/trace-engine';
import { CliError } from './commands.ts';
import { commandArgument, quoted } from './terminal.ts';
import { selectSymbol } from './selectors.ts';
import { fileHashes, rangeText } from './render-common.ts';
const EVIDENCE_PAGE_CODE_UNITS = 4096;

export function evidenceMap(
  investigation: ReturnType<typeof createInvestigation>,
  snapshotId: string,
  ids: readonly string[],
): Map<string, SourceReadResult> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return new Map();
  const response = investigation.sourceEvidence({
    snapshotId,
    evidenceIds: uniqueIds,
  });
  return new Map(
    response.items.map((item) => [
      item.status === 'available' ? item.evidence.id : item.evidenceId,
      item,
    ]),
  );
}

export function getAvailableEvidence(
  evidence: ReadonlyMap<string, SourceReadResult>,
  id: string,
): SourceReadResult | undefined {
  return evidence.get(id);
}

function evidencePageText(
  item: SourceReadResult | undefined,
  offset: number,
  selectorType: 'symbol' | 'site',
  selector: string,
  hashes: ReadonlyMap<string, string>,
): string[] {
  if (!item)
    throw new CliError(
      'EVIDENCE_NOT_FOUND',
      'Evidence is not part of this snapshot.',
    );
  if (item.status === 'unavailable')
    throw new CliError(
      item.code,
      `Verified source is unavailable: ${item.code}.`,
    );
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > item.text.length ||
    (offset > 0 &&
      item.text.charCodeAt(offset) >= 0xdc00 &&
      item.text.charCodeAt(offset) <= 0xdfff &&
      item.text.charCodeAt(offset - 1) >= 0xd800 &&
      item.text.charCodeAt(offset - 1) <= 0xdbff)
  )
    throw new CliError(
      'INVALID_EVIDENCE_OFFSET',
      'Evidence offset must be a UTF-16 boundary within the source span.',
    );
  let end = Math.min(offset + EVIDENCE_PAGE_CODE_UNITS, item.text.length);
  if (
    end < item.text.length &&
    item.text.charCodeAt(end - 1) >= 0xd800 &&
    item.text.charCodeAt(end - 1) <= 0xdbff
  )
    end--;
  const page = item.text.slice(offset, end),
    hash = hashes.get(item.evidence.fileId) ?? 'unknown';
  const blocks = [
    `Evidence ${quoted(selector)} — ${quoted(item.filePath)}@${rangeText(item)} sha256:${hash}`,
    `UTF-16 page [${offset}, ${end}) of ${item.text.length}.`,
    `Excerpt: ${quoted(page)}`,
  ];
  if (end < item.text.length)
    blocks.push(
      `Next page: evidence ${selectorType} ${commandArgument(selector)} ${end}`,
    );
  else blocks.push('End of verified evidence.');
  return blocks;
}

function evidenceForSite(facts: AnalysisFacts, selector: string): string {
  const match =
    /^(.*)@([1-9][0-9]*):([1-9][0-9]*)-([1-9][0-9]*):([1-9][0-9]*)$/.exec(
      selector,
    );
  if (!match)
    throw new CliError(
      'INVALID_SELECTOR',
      'Use a complete site selector in the form path@startLine:startColumn-endLine:endColumn.',
    );
  const filePath = match[1]!;
  const [startLine, startColumn, endLine, endColumn] = match
    .slice(2)
    .map(Number);
  const matches = facts.evidenceRefs.filter((evidence) => {
    const file = facts.files.find((item) => item.id === evidence.fileId);
    return (
      file?.path === filePath &&
      evidence.range.start.line === startLine &&
      evidence.range.start.column === startColumn &&
      evidence.range.end.line === endLine &&
      evidence.range.end.column === endColumn
    );
  });
  if (matches.length === 0)
    throw new CliError(
      'EVIDENCE_NOT_FOUND',
      `No evidence matches ${quoted(selector)}.`,
    );
  if (matches.length > 1)
    throw new CliError(
      'EVIDENCE_AMBIGUOUS',
      `${quoted(selector)} matches multiple evidence records; use a declaration selector or a more specific range.`,
    );
  return matches[0]!.id;
}

export function evidenceBlocks(
  snapshot: AnalysisSnapshot,
  investigation: ReturnType<typeof createInvestigation>,
  selectorType: string,
  selector: string,
  offsetText?: string,
): string[] {
  const offset = offsetText === undefined ? 0 : Number(offsetText);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (offsetText !== undefined && !/^(0|[1-9][0-9]*)$/.test(offsetText))
  )
    throw new CliError(
      'INVALID_EVIDENCE_OFFSET',
      'Offset must be a nonnegative safe integer.',
    );
  let evidenceId: string;
  if (selectorType === 'symbol') {
    if (offsetText !== undefined && !/^(0|[1-9][0-9]*)$/.test(offsetText))
      throw new CliError(
        'INVALID_EVIDENCE_OFFSET',
        'Offset must be canonical decimal.',
      );
    evidenceId = selectSymbol(snapshot.facts, selector).declarationEvidenceId;
  } else if (selectorType === 'site') {
    evidenceId = evidenceForSite(snapshot.facts, selector);
  } else
    throw new CliError(
      'INVALID_COMMAND',
      'Use evidence symbol or evidence site.',
    );
  const evidence = evidenceMap(investigation, snapshot.facts.snapshotId, [
      evidenceId,
    ]),
    hashes = fileHashes(snapshot.facts);
  return evidencePageText(
    evidence.get(evidenceId),
    offset,
    selectorType,
    selector,
    hashes,
  );
}
