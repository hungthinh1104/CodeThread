import assert from 'node:assert/strict';
import ts from 'typescript';
import type { RepositoryCorpus } from './repository-corpus.ts';
import type { RepositoryGold } from './repository-gold.ts';
import { equalGoldRange } from './repository-graph-gold.ts';

/** Annotation corrections remain visible and must be justified by the original source. */
export function validateRepositoryGoldCorrections(
  corpus: RepositoryCorpus,
  gold: RepositoryGold,
): void {
  assert.equal(
    gold.authoredBeforePredictions,
    gold.corrections.length === 0,
    'Gold prediction-timing statement is inconsistent',
  );
  const keys = new Set<string>();
  for (const label of gold.labels) {
    const key = JSON.stringify([
      label.repository,
      label.configPath,
      label.site.file,
      label.site.start.offset,
      label.site.end.offset,
    ]);
    assert(!keys.has(key), 'Duplicate labeled occurrence');
    keys.add(key);
  }
  for (const correction of gold.corrections.filter(
    (item) => item.repository === corpus.name,
  )) {
    const labels = gold.labels.filter(
      (label) =>
        label.repository === correction.repository &&
        label.configPath === correction.configPath &&
        label.site.file === correction.site.file &&
        equalGoldRange(label.site, correction.site),
    );
    assert.equal(labels.length, 1, 'Correction has no unique current label');
    assert.equal(
      labels[0]!.status,
      correction.revisedStatus,
      'Corrected label status differs from the audit',
    );
    assert.equal(
      labels[0]!.target,
      null,
      'An unsupported overloaded site must retain a null target',
    );
    const input = corpus.files.find(
      (file) => file.path === correction.previousTarget.file,
    );
    assert(
      input && input.sha256 === correction.previousTarget.sourceSha256,
      'Correction source hash mismatch',
    );
    const source = ts.createSourceFile(
      input.path,
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        input.bytes,
      ),
      ts.ScriptTarget.Latest,
      true,
    );
    const declarations: ts.FunctionDeclaration[] = [];
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node)) declarations.push(node);
      ts.forEachChild(node, visit);
    }
    visit(source);
    const implementation = declarations.find(
      (node) =>
        node.body &&
        node.getStart(source) === correction.previousTarget.start.offset &&
        node.end === correction.previousTarget.end.offset,
    );
    assert(
      implementation?.name,
      'Correction implementation anchor is not in the pinned source',
    );
    const signatures = declarations.filter(
      (node) =>
        !node.body &&
        node.parent === implementation.parent &&
        node.name?.text === implementation.name!.text,
    );
    assert.equal(
      signatures.length,
      correction.overloadSignatures,
      'Correction is not justified by the pinned overload signatures',
    );
  }
}
