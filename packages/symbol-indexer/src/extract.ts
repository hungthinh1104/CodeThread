import ts from 'typescript';
import {
  createSourcePositionIndex,
  analysisResourceLimits,
} from '@codethread/code-model';
import type {
  AnalysisFacts,
  AnalysisObservation,
  CodeRelation,
  CodeSymbol,
  Diagnostic,
  SourceEvidence,
} from '@codethread/code-model';
import type { WorkerOutput } from './protocol.js';
import { hash, identity } from './identity.js';

export function extractFacts(
  program: ts.Program,
  base: AnalysisFacts,
  root: string,
  limits = analysisResourceLimits(),
  projectContext = false,
): WorkerOutput {
  const checker = program.getTypeChecker();
  const files = new Map(base.files.map((file) => [root + file.path, file]));
  const sourceFiles = program
    .getSourceFiles()
    .filter((file) => files.has(file.fileName))
    .sort((a, b) =>
      Buffer.compare(
        Buffer.from(files.get(a.fileName)!.path),
        Buffer.from(files.get(b.fileName)!.path),
      ),
    );
  const semanticDiagnosticFiles =
    projectContext && sourceFiles.length > limits.maxFullSemanticDiagnosticFiles
      ? collectSemanticDiagnosticFiles(sourceFiles, checker)
      : sourceFiles;
  let declarationCount = 0,
    callCount = 0,
    referenceCandidateCount = 0,
    decoratorCount = 0;
  for (const file of sourceFiles) {
    const stack: ts.Node[] = [file];
    while (stack.length) {
      const node = stack.pop()!;
      if (
        ((ts.isFunctionDeclaration(node) && node.name && node.body) ||
          (ts.isMethodDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.body)) &&
        ++declarationCount > limits.maxDeclarations
      )
        return {
          ok: false,
          code: 'RESOURCE_LIMIT',
          message: 'Declaration limit exceeded',
        };
      if (ts.isCallExpression(node) && ++callCount > limits.maxCallSites)
        return {
          ok: false,
          code: 'RESOURCE_LIMIT',
          message: 'Relationship site limit exceeded',
        };
      if (ts.isCallExpression(node))
        for (const argument of node.arguments)
          if (
            (ts.isPropertyAccessExpression(argument) ||
              ts.isElementAccessExpression(argument)) &&
            ++referenceCandidateCount > limits.maxReferenceSites
          )
            return {
              ok: false,
              code: 'RESOURCE_LIMIT',
              message: 'Reference site limit exceeded',
            };
      if (
        ts.isDecorator(node) &&
        ++decoratorCount > limits.maxUnsupportedSyntax
      )
        return {
          ok: false,
          code: 'RESOURCE_LIMIT',
          message: 'Unsupported syntax limit exceeded',
        };
      ts.forEachChild(node, (child) => {
        stack.push(child);
      });
    }
  }
  const positions = new Map(
    sourceFiles.map((file) => [
      file.fileName,
      createSourcePositionIndex(file.text),
    ]),
  );
  const symbols: CodeSymbol[] = [],
    relations: CodeRelation[] = [],
    evidenceRefs: SourceEvidence[] = [],
    diagnostics: Diagnostic[] = [],
    observations: AnalysisObservation[] = [];
  const declarations = new Map<ts.FunctionDeclaration, CodeSymbol>(),
    methods = new Map<ts.MethodDeclaration, CodeSymbol>();
  const evidences = new Map<string, SourceEvidence>();
  const errors = new Map<string, { starts: number[]; maxEnds: number[] }>();
  for (const file of semanticDiagnosticFiles) {
    const source = files.get(file.fileName)!;
    const index = positions.get(file.fileName)!;
    const ranges: { start: number; end: number }[] = [];
    for (const [ordinal, diagnostic] of program
      .getSemanticDiagnostics(file)
      .entries()) {
      if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
      const start = Math.min(
        file.text.length,
        Math.max(0, diagnostic.start ?? 0),
      );
      const end = Math.min(
        file.text.length,
        start + Math.max(1, diagnostic.length ?? file.text.length),
      );
      ranges.push({ start, end });
      const code = 'TS_' + diagnostic.code;
      const rawMessage = ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        '\n',
      );
      const message =
        rawMessage.length > 4096 ? rawMessage.slice(0, 4095) + '…' : rawMessage;
      diagnostics.push({
        snapshotId: base.snapshotId,
        id: identity('compiler-diagnostic', [
          base.snapshotId,
          source.id,
          start,
          end,
          code,
          ordinal,
        ]),
        code,
        severity: 'error',
        message: message || code,
        fileId: source.id,
        filePath: source.path,
        range: { start: index.positionAt(start), end: index.positionAt(end) },
      });
      if (diagnostics.length > limits.maxCompilerDiagnostics)
        return {
          ok: false,
          code: 'RESOURCE_LIMIT',
          message: 'Compiler diagnostic limit exceeded',
        };
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    let maximum = -1;
    errors.set(file.fileName, {
      starts: ranges.map((range) => range.start),
      maxEnds: ranges.map((range) => (maximum = Math.max(maximum, range.end))),
    });
  }
  const contextDiagnostics =
    semanticDiagnosticFiles.length < sourceFiles.length
      ? [
          {
            code: 'SEMANTIC_DIAGNOSTICS_SCOPED',
            message: `Semantic diagnostics were checked for ${semanticDiagnosticFiles.length} of ${sourceFiles.length} source files involved in supported relationships.`,
          },
        ]
      : undefined;
  function hasErrorsInRange(
    file: ts.SourceFile,
    start: number,
    end: number,
  ): boolean {
    const ranges = errors.get(file.fileName);
    if (!ranges) return false;
    let low = 0,
      high = ranges.starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (ranges.starts[middle]! < end) low = middle + 1;
      else high = middle;
    }
    return low > 0 && ranges.maxEnds[low - 1]! > start;
  }
  function hasErrors(node: ts.Node): boolean {
    const file = node.getSourceFile();
    return hasErrorsInRange(file, node.getStart(file), node.end);
  }
  function hasBindingErrors(declaration: ts.FunctionDeclaration): boolean {
    const file = declaration.getSourceFile();
    return hasErrorsInRange(
      file,
      declaration.getStart(file),
      declaration.body?.getStart(file) ?? declaration.end,
    );
  }
  const written = new Set<ts.Symbol>();
  function markWritten(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) {
        written.add(symbol);
        if (symbol.flags & ts.SymbolFlags.Alias)
          written.add(checker.getAliasedSymbol(symbol));
      }
    } else if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSpreadElement(node) ||
      ts.isSpreadAssignment(node)
    )
      markWritten(node.expression);
    else if (ts.isArrayLiteralExpression(node))
      node.elements.forEach(markWritten);
    else if (ts.isObjectLiteralExpression(node))
      node.properties.forEach(markWritten);
    else if (ts.isPropertyAssignment(node)) markWritten(node.initializer);
    else if (ts.isShorthandPropertyAssignment(node)) {
      const symbol = checker.getShorthandAssignmentValueSymbol(node);
      if (symbol) written.add(symbol);
    }
  }
  for (const file of sourceFiles) {
    function visitWrites(node: ts.Node): void {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        markWritten(node.left);
      if (
        (ts.isPrefixUnaryExpression(node) ||
          ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      )
        markWritten(node.operand);
      if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer)
      )
        markWritten(node.initializer);
      ts.forEachChild(node, visitWrites);
    }
    visitWrites(file);
  }
  function evidence(
    file: ts.SourceFile,
    start: number,
    end: number,
  ): SourceEvidence {
    const owner = files.get(file.fileName)!;
    const id = identity('evidence', [base.snapshotId, owner.id, start, end]);
    const existing = evidences.get(id);
    if (existing) return existing;
    const index = positions.get(file.fileName)!;
    const value: SourceEvidence = {
      snapshotId: base.snapshotId,
      id,
      fileId: owner.id,
      contentHash: owner.contentHash,
      range: { start: index.positionAt(start), end: index.positionAt(end) },
      kind: 'static_source',
      extractor: { name: 'ct-index-001b', version: '0.1.0' },
    };
    evidences.set(id, value);
    evidenceRefs.push(value);
    return value;
  }
  for (const file of sourceFiles) {
    const source = files.get(file.fileName)!;
    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const start = node.getStart(file),
          end = node.end;
        const anchor = evidence(file, start, end);
        const key =
          'symbol:v1:' +
          hash(JSON.stringify([source.path, start, end, 'function']));
        const symbol: CodeSymbol = {
          snapshotId: base.snapshotId,
          id: identity('symbol', [base.snapshotId, key]),
          key,
          fileId: source.id,
          filePath: source.path,
          name: node.name.text,
          kind: 'function',
          range: anchor.range,
          declarationEvidenceId: anchor.id,
          evidenceIds: [anchor.id],
        };
        declarations.set(node, symbol);
        symbols.push(symbol);
      } else if (
        ts.isMethodDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.body
      ) {
        const start = node.getStart(file),
          end = node.end;
        const anchor = evidence(file, start, end);
        const key =
          'symbol:v1:' +
          hash(JSON.stringify([source.path, start, end, 'method']));
        const symbol: CodeSymbol = {
          snapshotId: base.snapshotId,
          id: identity('symbol', [base.snapshotId, key]),
          key,
          fileId: source.id,
          filePath: source.path,
          name: node.name.text,
          kind: 'method',
          range: anchor.range,
          declarationEvidenceId: anchor.id,
          evidenceIds: [anchor.id],
        };
        methods.set(node, symbol);
        symbols.push(symbol);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  if (symbols.length > limits.maxDeclarations)
    return {
      ok: false,
      code: 'RESOURCE_LIMIT',
      message: 'Declaration limit exceeded',
    };
  for (const file of sourceFiles) {
    const source = files.get(file.fileName)!;
    function addReference(
      node: ts.Expression,
      owner: CodeSymbol | undefined,
    ): void {
      const site = evidence(file, node.getStart(file), node.end);
      let target: CodeSymbol | undefined;
      let status: 'exact' | 'unresolved' | 'ambiguous' | 'unsupported' =
        'unsupported';
      let code = 'REFERENCE_TARGET_UNSUPPORTED';
      let relationCandidate = true;
      let member: ts.Symbol | undefined;
      let methodDeclarations: ts.MethodDeclaration[] = [];
      if (ts.isElementAccessExpression(node)) {
        code = 'REFERENCE_COMPUTED_UNSUPPORTED';
      } else if (!ts.isPropertyAccessExpression(node)) {
        code = 'REFERENCE_SYNTAX_UNSUPPORTED';
      } else if (node.questionDotToken) {
        code = 'REFERENCE_OPTIONAL_UNSUPPORTED';
      } else {
        member = checker.getSymbolAtLocation(node.name);
        const memberDeclarations = member?.declarations ?? [];
        methodDeclarations = memberDeclarations.filter(ts.isMethodDeclaration);
        const hasAccessor = memberDeclarations.some(
          (declaration) =>
            ts.isGetAccessorDeclaration(declaration) ||
            ts.isSetAccessorDeclaration(declaration),
        );
        if (hasAccessor) {
          code = 'REFERENCE_ACCESSOR_UNSUPPORTED';
        } else if (methodDeclarations.length > 1) {
          const sameOwner = methodDeclarations.every(
            (declaration) =>
              declaration.parent === methodDeclarations[0]!.parent,
          );
          if (sameOwner) {
            code = 'REFERENCE_OVERLOAD_UNSUPPORTED';
          } else {
            status = 'ambiguous';
            code = 'REFERENCE_TARGET_AMBIGUOUS';
          }
        } else if (
          methodDeclarations.length === 1 &&
          memberDeclarations.length === 1
        ) {
          const declaration = methodDeclarations[0]!;
          if (!declaration.body || !ts.isIdentifier(declaration.name)) {
            code = 'REFERENCE_TARGET_UNSUPPORTED';
          } else if (hasErrors(node) || hasErrors(declaration)) {
            status = 'unresolved';
            code = 'INVALID_BINDING';
          } else {
            target = methods.get(declaration);
            if (target) status = 'exact';
            else code = 'REFERENCE_TARGET_UNAVAILABLE';
          }
        } else if (memberDeclarations.length > 0) {
          code = 'REFERENCE_TARGET_UNSUPPORTED';
          relationCandidate = false;
        } else {
          status = 'unresolved';
          code = hasErrors(node)
            ? 'REFERENCE_TARGET_UNRESOLVED'
            : 'REFERENCE_BINDING_UNAVAILABLE';
        }
      }
      if (!owner) {
        status = 'unsupported';
        code = 'OWNER_UNSUPPORTED';
      }
      let diagnostic: Diagnostic | undefined;
      if (status !== 'exact') {
        diagnostic = {
          snapshotId: base.snapshotId,
          id: identity('diagnostic', [
            base.snapshotId,
            source.id,
            site.range.start.offset,
            site.range.end.offset,
            code,
          ]),
          code,
          severity: 'warning',
          message: code,
          fileId: source.id,
          filePath: source.path,
          range: site.range,
        };
        diagnostics.push(diagnostic);
      }
      if (!owner || !relationCandidate) return;
      const key =
        'relation:v1:' +
        hash(
          JSON.stringify([
            owner.key,
            source.path,
            site.range.start.offset,
            site.range.end.offset,
            'references',
          ]),
        );
      const support = [
        ...new Set([
          site.id,
          owner.declarationEvidenceId,
          ...(target ? [target.declarationEvidenceId] : []),
        ]),
      ];
      relations.push({
        snapshotId: base.snapshotId,
        id: identity('relation', [base.snapshotId, key]),
        key,
        sourceSymbolId: owner.id,
        kind: 'references',
        siteEvidenceId: site.id,
        resolution:
          status === 'exact'
            ? { status, targetId: target!.id, evidenceIds: support }
            : {
                status,
                targetId: null,
                evidenceIds: support,
                diagnosticIds: [diagnostic!.id],
              },
      });
    }
    function visit(
      node: ts.Node,
      inheritedOwner?: CodeSymbol,
      inheritedReferenceOwner?: CodeSymbol,
    ): void {
      if (ts.isDecorator(node)) {
        const anchor = evidence(file, node.getStart(file), node.end);
        const code = 'DECORATOR_UNSUPPORTED';
        diagnostics.push({
          snapshotId: base.snapshotId,
          id: identity('diagnostic', [
            base.snapshotId,
            source.id,
            anchor.range.start.offset,
            anchor.range.end.offset,
            code,
          ]),
          code,
          severity: 'warning',
          message: code,
          fileId: source.id,
          filePath: source.path,
          range: anchor.range,
        });
      }
      if (ts.isCallExpression(node)) {
        const site = evidence(file, node.getStart(file), node.end);
        const owner = inheritedOwner;
        let symbol = ts.isIdentifier(node.expression)
          ? checker.getSymbolAtLocation(node.expression)
          : undefined;
        let importedFile: ts.SourceFile | undefined;
        let importBinding: ts.ImportSpecifier | undefined;
        let unsupportedReason: string | undefined = node.questionDotToken
          ? 'CALL_EXPRESSION_UNSUPPORTED'
          : undefined;
        if (!symbol && ts.isIdentifier(node.expression)) {
          const typeSymbol = checker.resolveName(
            node.expression.text,
            node.expression,
            ts.SymbolFlags.Type,
            false,
          );
          if (typeSymbol && !(typeSymbol.flags & ts.SymbolFlags.Value))
            unsupportedReason = 'TYPE_ONLY_BINDING';
        }
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
          const binding = symbol.declarations?.[0];
          if (binding && ts.isImportSpecifier(binding)) importBinding = binding;
          if (
            binding &&
            ts.isImportSpecifier(binding) &&
            (binding.isTypeOnly || binding.parent.parent.isTypeOnly)
          )
            unsupportedReason = 'TYPE_ONLY_BINDING';
          else if (
            binding &&
            ts.isImportSpecifier(binding) &&
            ts.isStringLiteral(binding.parent.parent.parent.moduleSpecifier) &&
            !/^\.\.?\//.test(
              binding.parent.parent.parent.moduleSpecifier.text,
            ) &&
            !projectContext
          )
            unsupportedReason = 'EXTERNAL_MODULE';
          else if (binding && !ts.isImportSpecifier(binding))
            unsupportedReason = 'IMPORT_BINDING_UNSUPPORTED';
          if (
            binding &&
            ts.isImportSpecifier(binding) &&
            !binding.isTypeOnly &&
            !binding.parent.parent.isTypeOnly &&
            ts.isStringLiteral(binding.parent.parent.parent.moduleSpecifier) &&
            (projectContext ||
              /^\.\.?\//.test(
                binding.parent.parent.parent.moduleSpecifier.text,
              ))
          ) {
            importedFile = checker
              .getSymbolAtLocation(binding.parent.parent.parent.moduleSpecifier)
              ?.declarations?.find(ts.isSourceFile);
            symbol = importedFile
              ? checker.getAliasedSymbol(symbol)
              : undefined;
          } else symbol = undefined;
        }
        const functionDeclarations =
          symbol?.declarations?.filter(ts.isFunctionDeclaration) ?? [];
        if (
          symbol &&
          symbol.declarations?.length &&
          functionDeclarations.length === 0
        )
          unsupportedReason ??=
            symbol.flags & ts.SymbolFlags.Value
              ? 'CALL_TARGET_UNSUPPORTED'
              : 'TYPE_ONLY_BINDING';
        if (
          symbol &&
          functionDeclarations.length &&
          symbol.declarations &&
          symbol.declarations.length !== functionDeclarations.length
        )
          unsupportedReason ??= 'MERGED_DECLARATION_UNSUPPORTED';
        if (
          functionDeclarations.length > 1 &&
          functionDeclarations.filter((entry) => entry.body).length === 1 &&
          functionDeclarations.some((entry) => !entry.body)
        )
          unsupportedReason = 'OVERLOAD_UNSUPPORTED';
        if (
          functionDeclarations.length > 0 &&
          functionDeclarations.every((entry) => !entry.body)
        )
          unsupportedReason ??= 'CALL_TARGET_UNSUPPORTED';
        const declaration =
          symbol?.declarations?.length === 1 &&
          ts.isFunctionDeclaration(symbol.declarations[0]!)
            ? symbol.declarations[0]
            : undefined;
        if (
          importedFile &&
          declaration &&
          declaration.getSourceFile() !== importedFile
        )
          unsupportedReason = 'REEXPORT_UNSUPPORTED';
        const target =
          declaration &&
          (!importedFile || declaration.getSourceFile() === importedFile)
            ? declarations.get(declaration)
            : undefined;
        const unresolvedReason =
          symbol && written.has(symbol)
            ? 'MUTATED_BINDING'
            : target &&
                (hasErrors(node) ||
                  (declaration && hasBindingErrors(declaration)) ||
                  (importBinding && hasErrors(importBinding)))
              ? 'INVALID_BINDING'
              : undefined;
        const ambiguous =
          functionDeclarations.filter((entry) => entry.body).length > 1;
        const status =
          !owner || !ts.isIdentifier(node.expression) || unsupportedReason
            ? 'unsupported'
            : ambiguous
              ? 'ambiguous'
              : target && !unresolvedReason
                ? 'exact'
                : 'unresolved';
        let diagnostic: Diagnostic | undefined;
        if (status !== 'exact') {
          const code = !owner
            ? 'OWNER_UNSUPPORTED'
            : status === 'ambiguous'
              ? 'TARGET_AMBIGUOUS'
              : status === 'unsupported'
                ? (unsupportedReason ?? 'CALL_EXPRESSION_UNSUPPORTED')
                : (unresolvedReason ?? 'TARGET_UNRESOLVED');
          diagnostic = {
            snapshotId: base.snapshotId,
            id: identity('diagnostic', [
              base.snapshotId,
              source.id,
              site.range.start.offset,
              site.range.end.offset,
              code,
            ]),
            code,
            severity: 'warning',
            message: code,
            fileId: source.id,
            filePath: source.path,
            range: site.range,
          };
          diagnostics.push(diagnostic);
        }
        let relation: CodeRelation | undefined;
        if (owner) {
          const key =
            'relation:v1:' +
            hash(
              JSON.stringify([
                owner.key,
                source.path,
                site.range.start.offset,
                site.range.end.offset,
                'calls',
              ]),
            );
          const support = [
            ...new Set([
              site.id,
              owner.declarationEvidenceId,
              ...(target && status === 'exact'
                ? [target.declarationEvidenceId]
                : []),
            ]),
          ];
          relation = {
            snapshotId: base.snapshotId,
            id: identity('relation', [base.snapshotId, key]),
            key,
            sourceSymbolId: owner.id,
            kind: 'calls',
            siteEvidenceId: site.id,
            resolution:
              status === 'exact'
                ? { status, targetId: target!.id, evidenceIds: support }
                : {
                    status,
                    targetId: null,
                    evidenceIds: support,
                    diagnosticIds: [diagnostic!.id],
                  },
          };
          relations.push(relation);
        }
        observations.push({
          fileId: source.id,
          evidenceId: site.id,
          ownerId: owner?.id ?? null,
          relationId: relation?.id ?? null,
          diagnosticId: diagnostic?.id ?? null,
          status,
          eligible: status !== 'unsupported',
        });
        for (const argument of node.arguments) {
          if (
            ts.isPropertyAccessExpression(argument) ||
            ts.isElementAccessExpression(argument)
          )
            addReference(argument, inheritedReferenceOwner);
        }
      }
      if (ts.isFunctionLike(node)) {
        const functionOwner = ts.isFunctionDeclaration(node)
          ? declarations.get(node)
          : undefined;
        const methodOwner = ts.isMethodDeclaration(node)
          ? methods.get(node)
          : undefined;
        const callOwner =
          functionOwner ??
          (ts.isMethodDeclaration(node) && ts.isClassLike(node.parent)
            ? methodOwner
            : undefined);
        const referenceOwner = functionOwner ?? methodOwner;
        const body = 'body' in node ? node.body : undefined;
        ts.forEachChild(node, (child) => {
          visit(
            child,
            child === body ? callOwner : undefined,
            child === body ? referenceOwner : undefined,
          );
        });
      } else
        ts.forEachChild(node, (child) => {
          visit(child, inheritedOwner, inheritedReferenceOwner);
        });
    }
    visit(file);
  }
  if (observations.length > limits.maxCallSites)
    return {
      ok: false,
      code: 'RESOURCE_LIMIT',
      message: 'Relationship site limit exceeded',
    };
  const counts = {
    files: base.files.length,
    declarations: symbols.length,
    callSites: observations.length,
    exact: observations.filter((item) => item.status === 'exact').length,
    unresolved: observations.filter((item) => item.status === 'unresolved')
      .length,
    ambiguous: observations.filter((item) => item.status === 'ambiguous')
      .length,
    unsupported: observations.filter((item) => item.status === 'unsupported')
      .length,
    notAnalyzedInputs: 0,
  };
  const pathById = new Map(base.files.map((file) => [file.id, file.path]));
  const textOrder = (left: string, right: string) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right));
  const locationOrder = (left: SourceEvidence, right: SourceEvidence) =>
    textOrder(pathById.get(left.fileId)!, pathById.get(right.fileId)!) ||
    left.range.start.offset - right.range.start.offset ||
    left.range.end.offset - right.range.end.offset ||
    textOrder(left.id, right.id);
  symbols.sort(
    (a, b) =>
      textOrder(a.filePath, b.filePath) ||
      a.range.start.offset - b.range.start.offset ||
      textOrder(a.key, b.key),
  );
  relations.sort(
    (a, b) =>
      locationOrder(
        evidences.get(a.siteEvidenceId)!,
        evidences.get(b.siteEvidenceId)!,
      ) || textOrder(a.key, b.key),
  );
  evidenceRefs.sort(locationOrder);
  observations.sort((a, b) =>
    locationOrder(evidences.get(a.evidenceId)!, evidences.get(b.evidenceId)!),
  );
  diagnostics.sort(
    (a, b) =>
      textOrder(a.filePath ?? '', b.filePath ?? '') ||
      (a.range?.start.offset ?? 0) - (b.range?.start.offset ?? 0) ||
      textOrder(a.id, b.id),
  );
  return {
    ok: true,
    facts: {
      ...base,
      symbols,
      relations,
      evidenceRefs,
      diagnostics,
      observations,
      counts,
      coverageByCapability: {
        'declarations.v1': 'partial',
        'relationships.v1': 'partial',
        'named_functions.v1': 'complete',
        'direct_calls.v1': [...errors.values()].some(
          (entry) => entry.starts.length > 0,
        )
          ? 'partial'
          : counts.unsupported > 0
            ? counts.exact + counts.unresolved + counts.ambiguous > 0
              ? 'partial'
              : 'unsupported'
            : 'complete',
        'imports.v1': 'not_analyzed',
        'references.v1': 'partial',
        'test_behavior.v1': 'not_analyzed',
        'decorators.v1': decoratorCount > 0 ? 'unsupported' : 'not_analyzed',
        'framework_wiring.v1': 'not_analyzed',
        'constructors.v1': 'not_analyzed',
      },
    },
    ...(contextDiagnostics === undefined ? {} : { contextDiagnostics }),
  };
}

function collectSemanticDiagnosticFiles(
  sourceFiles: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
): ts.SourceFile[] {
  const sourceSet = new Set(sourceFiles),
    selected = new Set<ts.SourceFile>();
  const add = (file: ts.SourceFile) => {
    if (sourceSet.has(file)) selected.add(file);
  };
  function addDirectTarget(file: ts.SourceFile, expression: ts.Expression) {
    if (!ts.isIdentifier(expression)) return;
    let symbol = checker.getSymbolAtLocation(expression),
      importedFile: ts.SourceFile | undefined;
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      const binding = symbol.declarations?.[0];
      if (
        binding &&
        ts.isImportSpecifier(binding) &&
        !binding.isTypeOnly &&
        !binding.parent.parent.isTypeOnly &&
        ts.isStringLiteral(binding.parent.parent.parent.moduleSpecifier)
      ) {
        importedFile = checker
          .getSymbolAtLocation(binding.parent.parent.parent.moduleSpecifier)
          ?.declarations?.find(ts.isSourceFile);
        symbol = importedFile ? checker.getAliasedSymbol(symbol) : undefined;
      } else symbol = undefined;
    }
    const declarations = symbol?.declarations ?? [],
      functions = declarations.filter(ts.isFunctionDeclaration);
    if (
      declarations.length === 1 &&
      functions.length === 1 &&
      functions[0]!.body &&
      (!importedFile || functions[0]!.getSourceFile() === importedFile)
    ) {
      add(file);
      add(functions[0]!.getSourceFile());
    }
  }
  function addReferenceTarget(file: ts.SourceFile, expression: ts.Expression) {
    if (
      !ts.isPropertyAccessExpression(expression) ||
      expression.questionDotToken
    )
      return;
    const declarations =
      checker.getSymbolAtLocation(expression.name)?.declarations ?? [];
    const methods = declarations.filter(ts.isMethodDeclaration);
    if (
      declarations.length === 1 &&
      methods.length === 1 &&
      methods[0]!.body &&
      ts.isIdentifier(methods[0]!.name)
    ) {
      add(file);
      add(methods[0]!.getSourceFile());
    }
  }
  for (const file of sourceFiles) {
    function visit(
      node: ts.Node,
      callOwner = false,
      referenceOwner = false,
    ): void {
      if (ts.isCallExpression(node)) {
        if (callOwner) addDirectTarget(file, node.expression);
        if (referenceOwner)
          for (const argument of node.arguments)
            if (
              ts.isPropertyAccessExpression(argument) ||
              ts.isElementAccessExpression(argument)
            ) {
              add(file);
              addReferenceTarget(file, argument);
            }
      }
      if (ts.isFunctionLike(node)) {
        const functionOwner =
            ts.isFunctionDeclaration(node) && node.name && node.body,
          methodOwner =
            ts.isMethodDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.body,
          body = 'body' in node ? node.body : undefined,
          ownsCalls =
            functionOwner ||
            (methodOwner &&
              ts.isMethodDeclaration(node) &&
              ts.isClassLike(node.parent));
        ts.forEachChild(node, (child) => {
          visit(
            child,
            child === body && !!ownsCalls,
            child === body && !!(functionOwner || methodOwner),
          );
        });
      } else
        ts.forEachChild(node, (child) =>
          visit(child, callOwner, referenceOwner),
        );
    }
    visit(file);
  }
  return sourceFiles.filter((file) => selected.has(file));
}
