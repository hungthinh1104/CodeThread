import { lstat, open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import type { GraphNeighborsRequest } from '@codethread/contracts';
import { hashSchema, idSchema, isSnapshotPath } from '@codethread/code-model';
import type {
  AnalysisFacts,
  CodeRelation,
  CodeSymbol,
  SourceReadResult,
} from '@codethread/code-model';
import {
  AnalysisError,
  analyzeManifest,
  COMPILER_PROFILE,
} from '@codethread/symbol-indexer';
import type {
  AnalysisInput,
  AnalysisSnapshot,
} from '@codethread/symbol-indexer';
import { createInvestigation } from '@codethread/trace-engine';
import { TraceError } from '@codethread/trace-engine';
import {
  loadExternalCorpus,
  loadTodoClosure,
} from './external-semantic-corpus.ts';

const MAX_MANIFEST_BYTES = 3 * 1024 * 1024;
const MAX_SOURCE_FILES = 20;
const MAX_SOURCE_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_COMMANDS = 100;
const MAX_COMMAND_LENGTH = 4096;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SYMBOL_ROWS = 100;
const MAX_RELATION_ROWS = 20;
const MAX_UNKNOWN_ROWS = 10;
const MAX_EXCERPT_CODE_POINTS = 360;
const EVIDENCE_PAGE_CODE_UNITS = 4096;
const DEFAULT_REPOSITORY_ID = '00000000-0000-4000-8000-000000000012';
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ORDER = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const supportedRelationKinds = [
  'calls',
  'references',
] as const satisfies readonly CodeRelation['kind'][];
type RelationKind = (typeof supportedRelationKinds)[number];
type Direction = GraphNeighborsRequest['direction'];

class CliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function estimatedBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function parseManifest(bytes: Uint8Array): AnalysisInput {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CliError('INVALID_MANIFEST', 'Manifest must be strict UTF-8.');
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);

  const document = parseDocument(text, { uniqueKeys: true, strict: true });
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new CliError(
      'INVALID_MANIFEST',
      'Manifest must be strict JSON with unique object keys.',
    );

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new CliError('INVALID_MANIFEST', 'Manifest is not valid JSON.');
  }
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ['version', 'repositoryId', 'files']) ||
    raw['version'] !== 1 ||
    !Array.isArray(raw['files']) ||
    raw['files'].length < 1 ||
    raw['files'].length > MAX_SOURCE_FILES
  )
    throw new CliError(
      'INVALID_MANIFEST',
      `Expected version 1 and between 1 and ${MAX_SOURCE_FILES} files.`,
    );

  const repositoryId = idSchema.safeParse(raw['repositoryId']);
  if (!repositoryId.success)
    throw new CliError('INVALID_MANIFEST', 'repositoryId must be a UUID.');

  let totalBytes = 0;
  const seenPaths = new Set<string>();
  const files: AnalysisInput['files'][number][] = [];
  for (const [index, item] of raw['files'].entries()) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['path', 'sha256', 'contentBase64']) ||
      typeof item['path'] !== 'string' ||
      typeof item['sha256'] !== 'string' ||
      typeof item['contentBase64'] !== 'string'
    )
      throw new CliError(
        'INVALID_MANIFEST',
        `files[${index}] must contain path, sha256 and contentBase64.`,
      );

    const { path, sha256, contentBase64 } = item;
    if (!isSnapshotPath(path) || !hashSchema.safeParse(sha256).success)
      throw new CliError(
        'INVALID_MANIFEST',
        `files[${index}] has an unsafe path or invalid SHA-256.`,
      );
    if (seenPaths.has(path))
      throw new CliError('INVALID_MANIFEST', `Duplicate source path: ${path}`);
    seenPaths.add(path);
    if (contentBase64.length % 4 !== 0 || !BASE64_PATTERN.test(contentBase64))
      throw new CliError(
        'INVALID_MANIFEST',
        `files[${index}].contentBase64 is not canonical base64.`,
      );

    const expectedBytes = estimatedBase64Bytes(contentBase64);
    if (expectedBytes > MAX_SOURCE_FILE_BYTES)
      throw new CliError(
        'RESOURCE_LIMIT',
        `${path} exceeds the ${MAX_SOURCE_FILE_BYTES}-byte per-file limit.`,
      );
    totalBytes += expectedBytes;
    if (totalBytes > MAX_TOTAL_SOURCE_BYTES)
      throw new CliError(
        'RESOURCE_LIMIT',
        `Manifest sources exceed the ${MAX_TOTAL_SOURCE_BYTES}-byte total limit.`,
      );

    const sourceBytes = Buffer.from(contentBase64, 'base64');
    if (
      sourceBytes.byteLength !== expectedBytes ||
      sourceBytes.toString('base64') !== contentBase64
    )
      throw new CliError(
        'INVALID_MANIFEST',
        `files[${index}].contentBase64 is not canonical.`,
      );
    files.push({ path, sha256, bytes: sourceBytes });
  }

  return {
    repositoryId: repositoryId.data,
    compilerOptions: COMPILER_PROFILE,
    files,
  };
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readManifestFile(filePath: string): Promise<Uint8Array> {
  if (filePath.length > 4096)
    throw new CliError('INVALID_ARGUMENT', 'Manifest path is too long.');
  const absolutePath = resolve(filePath);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(absolutePath);
  } catch {
    throw new CliError(
      'MANIFEST_UNAVAILABLE',
      'Cannot read the manifest file.',
    );
  }
  if (!before.isFile() || before.isSymbolicLink())
    throw new CliError(
      'INVALID_MANIFEST',
      'Manifest path must name a regular, non-symlink file.',
    );
  if (before.size > MAX_MANIFEST_BYTES)
    throw new CliError(
      'MANIFEST_TOO_LARGE',
      `Manifest exceeds the ${MAX_MANIFEST_BYTES}-byte file limit.`,
    );

  const handle = await open(absolutePath, 'r').catch(() => {
    throw new CliError(
      'MANIFEST_UNAVAILABLE',
      'Cannot read the manifest file.',
    );
  });
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !sameFile(before, opened) ||
      opened.size !== before.size ||
      opened.size > MAX_MANIFEST_BYTES
    )
      throw new CliError(
        'MANIFEST_CHANGED',
        'Manifest changed while it was being opened.',
      );

    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      length > MAX_MANIFEST_BYTES ||
      length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new CliError(
        length > MAX_MANIFEST_BYTES ? 'MANIFEST_TOO_LARGE' : 'MANIFEST_CHANGED',
        length > MAX_MANIFEST_BYTES
          ? `Manifest exceeds the ${MAX_MANIFEST_BYTES}-byte file limit.`
          : 'Manifest changed while it was being read.',
      );
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function loadTodoDemo(): Promise<AnalysisInput> {
  const original = await loadExternalCorpus('todo');
  const closure = await loadTodoClosure();
  return {
    repositoryId: DEFAULT_REPOSITORY_ID,
    compilerOptions: COMPILER_PROFILE,
    files: [...original.files, ...closure].map(({ path, sha256, bytes }) => ({
      path,
      sha256,
      bytes,
    })),
  };
}

function escapeTerminal(value: string): string {
  let result = '';
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (
      point < 0x20 ||
      (point >= 0x7f && point <= 0x9f) ||
      point === 0x061c ||
      (point >= 0x200e && point <= 0x200f) ||
      (point >= 0x2028 && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069)
    )
      result += `\\u{${point.toString(16)}}`;
    else result += character;
  }
  return result;
}

function quoted(value: string): string {
  return JSON.stringify(escapeTerminal(value));
}

function rangeText(
  evidence: SourceReadResult & { status: 'available' },
): string {
  const { start, end } = evidence.evidence.range;
  return `${start.line}:${start.column}-${end.line}:${end.column}`;
}

function sourceSelector(symbol: CodeSymbol): string {
  return `${symbol.filePath}@${symbol.range.start.line}:${symbol.range.start.column}`;
}

function commandArgument(value: string): string {
  return /\s/.test(value) ? quoted(value) : value;
}

function displaySelector(symbol: CodeSymbol): string {
  const selector = sourceSelector(symbol);
  return commandArgument(selector);
}

function fileHashes(facts: AnalysisFacts): Map<string, string> {
  return new Map(facts.files.map((file) => [file.id, file.contentHash]));
}

function renderEvidence(
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

function appendBounded(blocks: readonly string[]): string {
  const marker = `[Text response truncated at ${MAX_RESPONSE_BYTES} bytes; whole later rows omitted.]`;
  const markerBytes = Buffer.byteLength(marker + '\n');
  const result: string[] = [];
  let used = 0;
  for (const block of blocks) {
    const chunk = block.endsWith('\n') ? block : `${block}\n`;
    const bytes = Buffer.byteLength(chunk);
    if (used + bytes + markerBytes > MAX_RESPONSE_BYTES) {
      result.push(marker);
      break;
    }
    result.push(chunk);
    used += bytes;
  }
  return result.join('').trimEnd() + '\n';
}

function writePage(blocks: readonly string[]): void {
  process.stdout.write(appendBounded(blocks));
}

function diagnosticCounts(facts: AnalysisFacts): string[] {
  const counts = new Map<string, number>();
  for (const diagnostic of facts.diagnostics)
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  return [...counts]
    .sort(([left], [right]) => ORDER(left, right))
    .map(([code, count]) => `${code}=${count}`);
}

function overviewBlocks(snapshot: AnalysisSnapshot): string[] {
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

function tokenize(line: string): string[] {
  if (line.length > MAX_COMMAND_LENGTH)
    throw new CliError('COMMAND_TOO_LONG', 'Command exceeds 4096 characters.');
  const tokens: string[] = [];
  let index = 0;
  while (index < line.length) {
    while (/\s/.test(line[index] ?? '')) index++;
    if (index >= line.length) break;
    if (line[index] === '"') {
      const start = index++;
      let escaped = false;
      for (; index < line.length; index++) {
        const character = line[index]!;
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') {
          index++;
          break;
        }
      }
      if (line[index - 1] !== '"')
        throw new CliError('INVALID_COMMAND', 'Unclosed JSON-quoted argument.');
      let value: unknown;
      try {
        value = JSON.parse(line.slice(start, index)) as unknown;
      } catch {
        throw new CliError('INVALID_COMMAND', 'Invalid JSON-quoted argument.');
      }
      if (typeof value !== 'string')
        throw new CliError(
          'INVALID_COMMAND',
          'Quoted arguments must be strings.',
        );
      tokens.push(value);
      if (index < line.length && !/\s/.test(line[index]!))
        throw new CliError(
          'INVALID_COMMAND',
          'Separate quoted arguments with spaces.',
        );
    } else {
      const start = index;
      while (index < line.length && !/\s/.test(line[index]!)) index++;
      tokens.push(line.slice(start, index));
    }
  }
  return tokens;
}

function parseKinds(value: string | undefined): RelationKind[] {
  if (value === undefined) return ['calls'];
  const kinds = value.split(',');
  if (
    kinds.length < 1 ||
    kinds.length > 2 ||
    kinds.some(
      (kind) => !supportedRelationKinds.some((supported) => supported === kind),
    ) ||
    new Set(kinds).size !== kinds.length
  )
    throw new CliError(
      'INVALID_RELATION_FILTER',
      'Choose calls, references, or calls,references.',
    );
  const result: RelationKind[] = [];
  for (const kind of kinds) {
    if (isSupportedRelationKind(kind)) result.push(kind);
  }
  return result;
}

function isSupportedRelationKind(value: string): value is RelationKind {
  return supportedRelationKinds.some((kind) => kind === value);
}

function parseDirection(value: string | undefined): Direction {
  if (value === undefined) return 'both';
  if (value === 'incoming' || value === 'outgoing' || value === 'both')
    return value;
  throw new CliError(
    'INVALID_DIRECTION',
    'Direction must be incoming, outgoing or both.',
  );
}

function parseLocationSelector(value: string) {
  if (value.length > 2048)
    throw new CliError('INVALID_SELECTOR', 'Source selector is too long.');
  const match = /^(.*)@([1-9][0-9]*):([1-9][0-9]*)$/.exec(value);
  if (!match)
    throw new CliError(
      'INVALID_SELECTOR',
      'Use a source selector in the form path@line:column.',
    );
  const line = Number(match[2]),
    column = Number(match[3]);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column))
    throw new CliError(
      'INVALID_SELECTOR',
      'Line and column must be safe integers.',
    );
  return { filePath: match[1]!, line, column };
}

function selectSymbol(facts: AnalysisFacts, selector: string): CodeSymbol {
  if (selector.startsWith('name:')) {
    const name = selector.slice('name:'.length);
    if (name.length === 0)
      throw new CliError('INVALID_SELECTOR', 'Display-name selector is empty.');
    const candidates = facts.symbols.filter((symbol) => symbol.name === name);
    if (candidates.length === 0)
      throw new CliError(
        'SYMBOL_NOT_FOUND',
        `No symbol is named ${quoted(name)}.`,
      );
    if (candidates.length > 1)
      throw new CliError(
        'SYMBOL_AMBIGUOUS',
        `Name ${quoted(name)} matches ${candidates.length} declarations; use one source selector: ${candidates.slice(0, 10).map(displaySelector).join(', ')}${candidates.length > 10 ? ', …' : ''}`,
      );
    return candidates[0]!;
  }

  const location = parseLocationSelector(selector);
  const matches = facts.symbols.filter(
    (symbol) =>
      symbol.filePath === location.filePath &&
      symbol.range.start.line === location.line &&
      symbol.range.start.column === location.column,
  );
  if (matches.length === 0)
    throw new CliError(
      'SYMBOL_NOT_FOUND',
      `No declaration starts at ${quoted(selector)}. Use symbols to list anchors.`,
    );
  if (matches.length > 1)
    throw new CliError(
      'SYMBOL_AMBIGUOUS',
      `${quoted(selector)} matches ${matches.length} declarations; narrow the source anchor.`,
    );
  return matches[0]!;
}

function listFiles(snapshot: AnalysisSnapshot): string[] {
  if (snapshot.facts.files.length === 0)
    return ['No source files were analyzed.'];
  return snapshot.facts.files.map(
    (file) =>
      `${quoted(file.path)} (${file.byteLength} bytes, sha256:${file.contentHash})`,
  );
}

function listSymbols(snapshot: AnalysisSnapshot, path?: string): string[] {
  if (
    path !== undefined &&
    !snapshot.facts.files.some((file) => file.path === path)
  )
    throw new CliError(
      'SOURCE_NOT_FOUND',
      `No manifest source named ${quoted(path)}.`,
    );
  const symbols = path
    ? snapshot.facts.symbols.filter((symbol) => symbol.filePath === path)
    : snapshot.facts.symbols;
  if (symbols.length === 0)
    return [`No supported declarations${path ? ` in ${quoted(path)}` : ''}.`];
  const rows = symbols
    .slice(0, MAX_SYMBOL_ROWS)
    .map(
      (symbol) =>
        `${displaySelector(symbol)}  ${symbol.kind}  ${quoted(symbol.name)}`,
    );
  if (symbols.length > MAX_SYMBOL_ROWS)
    rows.push(
      `Symbol list limited to ${MAX_SYMBOL_ROWS} of ${symbols.length}; filter by source path.`,
    );
  return rows;
}

function evidenceMap(
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

function getAvailableEvidence(
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

function inspectBlocks(
  snapshot: AnalysisSnapshot,
  investigation: ReturnType<typeof createInvestigation>,
  selected: CodeSymbol,
  kinds: RelationKind[],
  direction: Direction,
  targets: Map<string, CodeSymbol>,
): string[] {
  const { facts } = snapshot;
  const request = {
    snapshotId: facts.snapshotId,
    symbolId: selected.id,
    direction,
    relationKinds: kinds,
    depth: 1,
    nodeLimit: 50,
  };
  const graph = investigation.neighbors(request),
    symbols = new Map(facts.symbols.map((symbol) => [symbol.id, symbol])),
    hashes = fileHashes(facts),
    displayedRelations = graph.relations.slice(0, MAX_RELATION_ROWS),
    orphanObservations = facts.observations
      .filter(
        (observation) =>
          observation.ownerId === selected.id &&
          observation.status !== 'exact' &&
          observation.relationId === null,
      )
      .slice(0, MAX_UNKNOWN_ROWS);
  const evidenceIds = [selected.declarationEvidenceId];
  for (const relation of displayedRelations) {
    evidenceIds.push(relation.siteEvidenceId);
    const source = symbols.get(relation.sourceSymbolId);
    if (source) evidenceIds.push(source.declarationEvidenceId);
    if (relation.resolution.status === 'exact') {
      const target = symbols.get(relation.resolution.targetId);
      if (target) evidenceIds.push(target.declarationEvidenceId);
    }
  }
  for (const observation of orphanObservations)
    evidenceIds.push(observation.evidenceId);
  const evidence = evidenceMap(investigation, facts.snapshotId, evidenceIds),
    declaration = getAvailableEvidence(
      evidence,
      selected.declarationEvidenceId,
    );
  if (!declaration || declaration.status !== 'available')
    throw new CliError(
      declaration?.status === 'unavailable'
        ? declaration.code
        : 'EVIDENCE_NOT_FOUND',
      `Selected declaration evidence is unavailable for ${displaySelector(selected)}.`,
    );

  const blocks = [
    `${selected.kind} ${quoted(selected.name)} — ${displaySelector(selected)}`,
    'STATIC RELATIONSHIPS ONLY. A reference is not a call or runtime dispatch.',
    ...renderEvidence(declaration, hashes),
  ];
  const owned = facts.observations.filter(
    (observation) => observation.ownerId === selected.id,
  );
  if (owned.length > 0) {
    const counts = new Map<string, number>();
    for (const observation of owned)
      counts.set(observation.status, (counts.get(observation.status) ?? 0) + 1);
    blocks.push(
      `Owned call-site observations: ${[...counts]
        .sort(([left], [right]) => ORDER(left, right))
        .map(([status, count]) => `${status}=${count}`)
        .join(', ')}.`,
    );
  }
  const sourceDiagnostics = facts.diagnostics.filter(
    (item) => item.filePath === selected.filePath,
  );
  blocks.push(
    `Snapshot coverage: ${Object.entries(facts.coverageByCapability)
      .sort(([left], [right]) => ORDER(left, right))
      .map(([name, status]) => `${name}=${status}`)
      .join(', ')}`,
    `Diagnostics in this source file: ${sourceDiagnostics.length}.`,
  );

  targets.clear();
  if (graph.relations.length === 0) {
    blocks.push(
      `No ${kinds.join(', ')} relationships were returned in the ${direction} one-hop view. Partial or unsupported coverage means this is not proof that no relationship exists.`,
    );
  }
  for (const relation of displayedRelations) {
    const isOutgoing = relation.sourceSymbolId === selected.id,
      counterpartId = isOutgoing
        ? relation.resolution.status === 'exact'
          ? relation.resolution.targetId
          : null
        : relation.sourceSymbolId,
      counterpart = counterpartId ? symbols.get(counterpartId) : undefined,
      site = getAvailableEvidence(evidence, relation.siteEvidenceId),
      diagnosticText =
        relation.resolution.status === 'exact'
          ? ''
          : relation.resolution.diagnosticIds
              .map((id) => graph.diagnostics.find((item) => item.id === id))
              .filter((item) => item !== undefined)
              .map((item) => `${item.code}: ${escapeTerminal(item.message)}`)
              .join('; ');
    const heading = `[${relation.kind.toUpperCase()} ${relation.resolution.status}] ${isOutgoing ? 'outgoing →' : 'incoming ←'}`;
    if (relation.resolution.status === 'exact') {
      if (
        !counterpart ||
        !relation.resolution.evidenceIds.includes(
          counterpart.declarationEvidenceId,
        )
      )
        throw new CliError(
          'INVALID_FACTS',
          'Exact relationship is missing its target declaration evidence.',
        );
      const targetEvidence = getAvailableEvidence(
        evidence,
        counterpart.declarationEvidenceId,
      );
      if (
        !site ||
        site.status !== 'available' ||
        !targetEvidence ||
        targetEvidence.status !== 'available'
      ) {
        const unavailable = [site, targetEvidence]
          .filter((item) => item?.status === 'unavailable')
          .map((item) => (item?.status === 'unavailable' ? item.code : ''));
        blocks.push(
          `${heading} omitted: verified site/declaration evidence unavailable (${unavailable.join(', ') || 'EVIDENCE_NOT_FOUND'}).`,
        );
        continue;
      }
      const selector = sourceSelector(counterpart);
      targets.set(selector, counterpart);
      blocks.push(
        [
          `${heading} ${quoted(counterpart.name)} (${counterpart.kind}) — ${displaySelector(counterpart)}`,
          `  ${relation.kind === 'calls' ? 'Call' : 'Reference'} occurrence:`,
          ...renderEvidence(site, hashes),
          '  Target declaration:',
          ...renderEvidence(targetEvidence, hashes),
        ].join('\n'),
      );
    } else {
      blocks.push(
        [
          `${heading} — target unknown (${relation.resolution.status})`,
          diagnosticText
            ? `  Diagnostic: ${diagnosticText}`
            : '  No exact target was inferred.',
          ...renderEvidence(site, hashes),
        ].join('\n'),
      );
    }
  }
  if (graph.relations.length > displayedRelations.length)
    blocks.push(
      `CLI display omitted ${graph.relations.length - displayedRelations.length} of ${graph.relations.length} returned relationship occurrences; narrow the source or direction.`,
    );
  if (graph.meta.truncated)
    blocks.push(
      `Query truncated: ${graph.meta.truncationReasons.join(', ')}; applied depth=${graph.meta.appliedLimits.depth}, nodes=${graph.meta.appliedLimits.nodes}, relationships=${graph.meta.appliedLimits.relationships}.`,
    );
  else {
    blocks.push(
      `Applied query limits: depth=${graph.meta.appliedLimits.depth}, nodes=${graph.meta.appliedLimits.nodes}, relationships=${graph.meta.appliedLimits.relationships}.`,
      'Query truncation: none reported by the trace engine.',
    );
  }

  if (orphanObservations.length > 0) {
    blocks.push(
      `Unsupported/unresolved call sites without graph edges (${orphanObservations.length}${facts.observations.filter((item) => item.ownerId === selected.id && item.status !== 'exact' && item.relationId === null).length > orphanObservations.length ? '+' : ''}):`,
    );
    for (const observation of orphanObservations) {
      const diagnostic = observation.diagnosticId
        ? facts.diagnostics.find((item) => item.id === observation.diagnosticId)
        : undefined;
      const item = getAvailableEvidence(evidence, observation.evidenceId);
      blocks.push(
        [
          `${observation.status}${diagnostic ? ` — ${diagnostic.code}: ${escapeTerminal(diagnostic.message)}` : ''}`,
          ...renderEvidence(item, hashes),
        ].join('\n'),
      );
    }
  }
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

function evidenceBlocks(
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

function helpBlocks(): string[] {
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

function printError(error: unknown): void {
  const code =
    error instanceof CliError ||
    error instanceof AnalysisError ||
    error instanceof TraceError
      ? error.code
      : 'INTERNAL_ERROR';
  const message =
    error instanceof Error
      ? escapeTerminal(error.message)
      : 'Unexpected failure.';
  process.stderr.write(`ERROR[${code}] ${message}\n`);
}

async function startSession(snapshot: AnalysisSnapshot): Promise<void> {
  const investigation = createInvestigation(snapshot.facts, snapshot.source),
    targets = new Map<string, CodeSymbol>(),
    input = process.stdin,
    output = process.stdout,
    terminal = Boolean(input.isTTY && output.isTTY),
    readline = createInterface({ input, output, terminal });
  let lastKinds: RelationKind[] = ['calls'],
    lastDirection: Direction = 'both',
    commands = 0;
  writePage(overviewBlocks(snapshot));
  if (terminal) {
    readline.setPrompt('ct> ');
    readline.prompt();
  }
  try {
    for await (const line of readline) {
      commands++;
      try {
        if (commands > MAX_SESSION_COMMANDS)
          throw new CliError(
            'SESSION_LIMIT',
            `Session is limited to ${MAX_SESSION_COMMANDS} commands.`,
          );
        const tokens = tokenize(line),
          [command, ...args] = tokens;
        if (!command) {
          if (terminal) readline.prompt();
          continue;
        }
        if (command === 'quit' || command === 'exit') {
          readline.close();
          break;
        }
        if (command === 'help') {
          if (args.length !== 0)
            throw new CliError('INVALID_COMMAND', 'help takes no arguments.');
          writePage(helpBlocks());
        } else if (command === 'files') {
          if (args.length !== 0)
            throw new CliError('INVALID_COMMAND', 'files takes no arguments.');
          writePage(listFiles(snapshot));
        } else if (command === 'symbols') {
          if (args.length > 1)
            throw new CliError(
              'INVALID_COMMAND',
              'Usage: symbols [source-path].',
            );
          writePage(listSymbols(snapshot, args[0]));
        } else if (command === 'inspect' || command === 'follow') {
          if (args.length < 1 || args.length > 3)
            throw new CliError(
              'INVALID_COMMAND',
              `Usage: ${command} <source-selector> [kinds] [direction].`,
            );
          const selected = selectSymbol(snapshot.facts, args[0]!);
          if (command === 'follow') {
            if (args[0]!.startsWith('name:'))
              throw new CliError(
                'INVALID_SELECTOR',
                'Follow targets by the source selector printed with each relationship.',
              );
            if (!targets.has(sourceSelector(selected)))
              throw new CliError(
                'TARGET_NOT_IN_LAST_RESULTS',
                `${displaySelector(selected)} was not a displayed exact target of the previous inspection.`,
              );
          }
          const kinds = parseKinds(
              args[1] ??
                (command === 'follow' ? lastKinds.join(',') : undefined),
            ),
            direction = parseDirection(
              args[2] ?? (command === 'follow' ? lastDirection : undefined),
            );
          const nextTargets = new Map<string, CodeSymbol>(),
            blocks = inspectBlocks(
              snapshot,
              investigation,
              selected,
              kinds,
              direction,
              nextTargets,
            );
          targets.clear();
          for (const [key, value] of nextTargets) targets.set(key, value);
          lastKinds = kinds;
          lastDirection = direction;
          writePage(blocks);
        } else if (command === 'evidence') {
          if (args.length < 2 || args.length > 3)
            throw new CliError(
              'INVALID_COMMAND',
              'Usage: evidence symbol <selector> [offset] | evidence site <path@range> [offset].',
            );
          writePage(
            evidenceBlocks(
              snapshot,
              investigation,
              args[0]!,
              args[1]!,
              args[2],
            ),
          );
        } else
          throw new CliError(
            'INVALID_COMMAND',
            `Unknown command ${quoted(command)}. Type help for commands.`,
          );
      } catch (error) {
        printError(error);
        process.exitCode = 2;
        readline.close();
        break;
      }
      if (terminal) readline.prompt();
    }
  } finally {
    readline.close();
  }
}

function parseArguments(
  args: readonly string[],
): { kind: 'manifest'; path: string } | { kind: 'demo' } | { kind: 'help' } {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h'))
    return { kind: 'help' };
  if (args.length === 2 && args[0] === '--manifest' && args[1]!.length > 0)
    return { kind: 'manifest', path: args[1]! };
  if (args.length === 2 && args[0] === '--demo' && args[1] === 'todo')
    return { kind: 'demo' };
  throw new CliError(
    'INVALID_ARGUMENT',
    'Usage: pnpm investigate -- --manifest <manifest.json> | pnpm demo:investigation',
  );
}

async function runInvestigationCli(
  args = process.argv.slice(2),
): Promise<void> {
  try {
    const command = parseArguments(args);
    if (command.kind === 'help') {
      writePage([
        'CodeThread bounded textual source investigation.',
        'Usage: pnpm investigate -- --manifest <manifest.json>',
        'Pinned example: pnpm demo:investigation',
        `Manifest limit: ${MAX_MANIFEST_BYTES} bytes; source limits: ${MAX_SOURCE_FILES} files, ${MAX_SOURCE_FILE_BYTES} bytes/file, ${MAX_TOTAL_SOURCE_BYTES} bytes total.`,
      ]);
      return;
    }
    const input =
      command.kind === 'demo'
        ? await loadTodoDemo()
        : parseManifest(await readManifestFile(command.path));
    const snapshot = await analyzeManifest(input);
    await startSession(snapshot);
  } catch (error) {
    printError(error);
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  void runInvestigationCli();
