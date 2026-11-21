import { createHash } from 'node:crypto';
import { createSourcePositionIndex } from '@codethread/code-model';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { describe, expect, it } from 'vitest';
import { loadRepositoryCorpus } from '../scripts/repository-corpus.ts';
import {
  inventoryGoldOwner,
  pinnedSourceExcerpt,
} from '../scripts/repository-gold-source.ts';

const owner = [
  'export function register() {',
  '  pass(router.getAll);',
  '  pass(((router.getOne)));',
  '  pass(router["create"]);',
  '  pass((router["remove"]));',
  '}',
].join('\n');
const text = [
  'class Router {',
  '  getAll() { return 1; }',
  '  getOne() { return 2; }',
  '  create() { return 3; }',
  '  remove() { return 4; }',
  '}',
  'const router = new Router();',
  'function pass(handler: () => number) { return handler; }',
  owner,
].join('\n');
const bytes = Buffer.from(text);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const path = 'reference-arguments.ts';
const file = { path, bytes, sha256 };

describe('method-shaped arguments through transparent parentheses', () => {
  it('retains exact property references and unsupported computed references', async () => {
    const result = await analyzeManifest({
      repositoryId: '00000000-0000-4000-8000-000000000076',
      compilerOptions: COMPILER_PROFILE,
      files: [file],
    });
    const { facts, source } = result;
    const references = facts.relations.filter(
      ({ kind }) => kind === 'references',
    );
    expect(references).toHaveLength(4);
    expect(
      references.map((reference) => {
        const evidence = source.readEvidence(reference.siteEvidenceId);
        if (evidence.status !== 'available') throw new Error('Unverified site');
        const owner = facts.symbols.find(
          ({ id }) => id === reference.sourceSymbolId,
        );
        const target = facts.symbols.find(
          ({ id }) => id === reference.resolution.targetId,
        );
        return [
          evidence.text,
          owner?.name,
          reference.resolution.status,
          target?.name ?? null,
        ];
      }),
    ).toEqual([
      ['router.getAll', 'register', 'exact', 'getAll'],
      ['router.getOne', 'register', 'exact', 'getOne'],
      ['router["create"]', 'register', 'unsupported', null],
      ['router["remove"]', 'register', 'unsupported', null],
    ]);
    expect(
      facts.diagnostics.filter(
        ({ code }) => code === 'REFERENCE_COMPUTED_UNSUPPORTED',
      ),
    ).toHaveLength(2);
    expect(facts.coverageByCapability['references.v1']).toBe('partial');
  });

  it('independently inventories every source access regardless of parentheses', async () => {
    const pinned = await loadRepositoryCorpus('ufo');
    const fixture = {
      ...pinned,
      files: [
        {
          ...file,
          blobId: createHash('sha1')
            .update('blob ' + bytes.length + '\0')
            .update(bytes)
            .digest('hex'),
          byteLength: bytes.length,
          mode: '100644' as const,
        },
      ],
    };
    const positions = createSourcePositionIndex(text);
    const inventory = inventoryGoldOwner(fixture, {
      file: path,
      sourceSha256: sha256,
      start: positions.positionAt(text.indexOf(owner)),
      end: positions.positionAt(text.length),
    });
    expect(
      inventory.sites
        .filter(({ kind }) => kind === 'references')
        .map(({ site }) => pinnedSourceExcerpt(fixture, site)),
    ).toEqual([
      'router.getAll',
      'router.getOne',
      'router["create"]',
      'router["remove"]',
    ]);
  });

  it('keeps chained optional access unsupported with and without parentheses', async () => {
    const source = Buffer.from(
      text +
        '\n' +
        [
          'declare const maybe: { current: Router } | null;',
          'function accept(handler: (() => number) | undefined) { return handler; }',
          'export function optional() {',
          '  accept(maybe?.current.getAll);',
          '  accept((maybe?.current.getOne));',
          '}',
        ].join('\n'),
    );
    const { facts, source: retained } = await analyzeManifest({
      repositoryId: '00000000-0000-4000-8000-000000000076',
      compilerOptions: COMPILER_PROFILE,
      files: [
        {
          path,
          bytes: source,
          sha256: createHash('sha256').update(source).digest('hex'),
        },
      ],
    });
    const owner = facts.symbols.find(({ name }) => name === 'optional');
    const references = facts.relations.filter(
      ({ kind, sourceSymbolId }) =>
        kind === 'references' && sourceSymbolId === owner?.id,
    );
    expect(
      references.map(({ resolution, siteEvidenceId }) => {
        const evidence = retained.readEvidence(siteEvidenceId);
        return [
          evidence.status === 'available' && evidence.text,
          resolution.status,
          resolution.targetId,
        ];
      }),
    ).toEqual([
      ['maybe?.current.getAll', 'unsupported', null],
      ['maybe?.current.getOne', 'unsupported', null],
    ]);
    expect(
      facts.diagnostics.filter(
        ({ code }) => code === 'REFERENCE_OPTIONAL_UNSUPPORTED',
      ),
    ).toHaveLength(2);
  });
});
