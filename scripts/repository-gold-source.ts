import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSourcePositionIndex } from '@codethread/code-model';
import type { CodeRelation, SourceRange } from '@codethread/code-model';
import ts from 'typescript';
import type { RepositoryCorpus } from './repository-corpus.ts';
import type { RepositoryGoldAnchor } from './repository-gold.ts';

export function equalGoldRange(left: SourceRange, right: SourceRange): boolean {
  return (['start', 'end'] as const).every((edge) =>
    (['offset', 'line', 'column'] as const).every(
      (key) => left[edge][key] === right[edge][key],
    ),
  );
}

export function goldSiteKey(file: string, range: SourceRange): string {
  return JSON.stringify([file, range.start.offset, range.end.offset]);
}

function pinnedSourceText(
  corpus: RepositoryCorpus,
  anchor: RepositoryGoldAnchor,
): string {
  const source = corpus.files.find((file) => file.path === anchor.file);
  assert(
    source &&
      source.sha256 === anchor.sourceSha256 &&
      createHash('sha256').update(source.bytes).digest('hex') ===
        anchor.sourceSha256,
    'Gold source hash differs from pinned bytes',
  );
  const text = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(source.bytes);
  assert(
    createSourcePositionIndex(text).validateRange({
      start: anchor.start,
      end: anchor.end,
    }),
    'Gold source range differs from pinned coordinates',
  );
  return text;
}

export function pinnedSourceExcerpt(
  corpus: RepositoryCorpus,
  anchor: RepositoryGoldAnchor,
): string {
  return pinnedSourceText(corpus, anchor).slice(
    anchor.start.offset,
    anchor.end.offset,
  );
}

export type OwnerOccurrence = {
  site: RepositoryGoldAnchor;
  kind: CodeRelation['kind'];
};

function pinnedDeclaration(
  corpus: RepositoryCorpus,
  owner: RepositoryGoldAnchor,
) {
  const syntax = ts.createSourceFile(
    owner.file,
    pinnedSourceText(corpus, owner),
    ts.ScriptTarget.Latest,
    true,
  );
  let body: ts.Block | undefined;
  function findOwner(node: ts.Node): void {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.body &&
      node.getStart(syntax) === owner.start.offset &&
      node.end === owner.end.offset
    ) {
      body = node.body;
      return;
    }
    ts.forEachChild(node, findOwner);
  }
  findOwner(syntax);
  assert(
    body,
    'Gold declaration anchor is not one source function or method body',
  );
  return { syntax, body };
}

export function verifyGoldDeclarationAnchor(
  corpus: RepositoryCorpus,
  declaration: RepositoryGoldAnchor,
): void {
  pinnedDeclaration(corpus, declaration);
}

/** Syntax inventory only. No checker, extraction results, or target inference. */
export function inventoryGoldOwner(
  corpus: RepositoryCorpus,
  owner: RepositoryGoldAnchor,
): OwnerOccurrence[] {
  const { syntax, body } = pinnedDeclaration(corpus, owner);

  function position(offset: number) {
    const { line, character } = syntax.getLineAndCharacterOfPosition(offset);
    return { offset, line: line + 1, column: character + 1 };
  }

  const sites: OwnerOccurrence[] = [];
  function record(node: ts.Node, kind: OwnerOccurrence['kind']) {
    sites.push({
      kind,
      site: {
        file: owner.file,
        sourceSha256: owner.sourceSha256,
        start: position(node.getStart(syntax)),
        end: position(node.end),
      },
    });
  }
  function visit(node: ts.Node): void {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      record(node, 'calls');
      for (const argument of node.arguments)
        if (
          ts.isPropertyAccessExpression(argument) ||
          ts.isElementAccessExpression(argument)
        )
          record(argument, 'references');
    }
    if (ts.isNewExpression(node)) record(node, 'constructs');
    ts.forEachChild(node, visit);
  }
  visit(body);
  return sites.sort(
    (left, right) =>
      left.site.start.offset - right.site.start.offset ||
      left.site.end.offset - right.site.end.offset,
  );
}
