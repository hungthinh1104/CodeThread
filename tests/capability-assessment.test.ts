import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  analyzeManifest,
  COMPILER_PROFILE,
  type AnalysisSnapshot,
} from '@codethread/symbol-indexer';
import type { SourcePosition } from '@codethread/code-model';
import {
  loadExternalCorpus,
  loadTodoClosure,
} from '../scripts/external-semantic-corpus.ts';

const TODO_REPOSITORY_ID = '00000000-0000-4000-8000-000000000022';
const TINYEXEC_REPOSITORY_ID = '00000000-0000-4000-8000-000000000023';

function observationForText(
  snapshot: AnalysisSnapshot,
  text: string,
  filePath?: string,
) {
  const matches = snapshot.facts.observations.flatMap((observation) => {
    const result = snapshot.source.readEvidence(observation.evidenceId);
    return result.status === 'available' &&
      result.text === text &&
      (!filePath || result.filePath === filePath)
      ? [{ observation, result }]
      : [];
  });
  expect(matches, `expected one source occurrence for ${text}`).toHaveLength(1);
  return matches[0]!;
}

function statusesAtGoldCalls(
  gold: Awaited<ReturnType<typeof loadExternalCorpus>>['gold'],
  snapshot: AnalysisSnapshot,
) {
  const observed = new Map<string, string>();
  for (const observation of snapshot.facts.observations) {
    const result = snapshot.source.readEvidence(observation.evidenceId);
    if (result.status !== 'available') continue;
    const { start, end } = result.evidence.range;
    observed.set(
      JSON.stringify([
        result.filePath,
        start.line,
        start.column,
        [end.line, end.column],
      ]),
      observation.status,
    );
  }
  return gold.calls.map((call) => ({
    key: JSON.stringify([call.file, call.line, call.column, call.end]),
    text: call.text,
    status: observed.get(
      JSON.stringify([call.file, call.line, call.column, call.end]),
    ),
  }));
}

function lineColumn(source: ts.SourceFile, offset: number): SourcePosition {
  const position = source.getLineAndCharacterOfPosition(offset);
  return {
    offset,
    line: position.line + 1,
    column: position.character + 1,
  };
}

function createRestrictedProgram(
  inputs: readonly { path: string; bytes: Uint8Array }[],
) {
  const root = resolve('fixtures/external/todo');
  const files = new Map(
    inputs.map(({ path, bytes }) => [
      resolve(root, path),
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ]),
  );
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Force,
    strict: true,
    noEmit: true,
    allowJs: false,
    types: [],
    lib: ['lib.es2023.d.ts'],
  };
  const host = ts.createCompilerHost(options, true);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const libDirectory = resolve(dirname(ts.getDefaultLibFilePath(options)));
  const isCompilerLibrary = (fileName: string) => {
    const normalized = resolve(fileName);
    return (
      normalized.startsWith(libDirectory + sep) &&
      /^lib\..*\.d\.ts$/i.test(normalized.slice(libDirectory.length + 1))
    );
  };
  const virtualText = (fileName: string) => files.get(resolve(fileName));
  host.fileExists = (fileName) =>
    files.has(resolve(fileName)) ||
    (isCompilerLibrary(fileName) && defaultFileExists(fileName));
  host.readFile = (fileName) =>
    virtualText(fileName) ??
    (isCompilerLibrary(fileName) ? defaultReadFile(fileName) : undefined);
  host.getSourceFile = (
    fileName,
    languageVersion,
    onError,
    shouldCreateNew,
  ) => {
    const source = virtualText(fileName);
    if (source !== undefined)
      return ts.createSourceFile(fileName, source, languageVersion, true);
    if (isCompilerLibrary(fileName))
      return defaultGetSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNew,
      );
    return undefined;
  };
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((moduleName) => {
      if (!moduleName.startsWith('.')) return undefined;
      const resolvedFileName = resolve(
        dirname(containingFile),
        `${moduleName}.ts`,
      );
      return files.has(resolvedFileName)
        ? {
            resolvedFileName,
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          }
        : undefined;
    });
  const program = ts.createProgram({
    rootNames: [...files.keys()],
    options,
    host,
  });
  return { program, files };
}

describe('evidence-driven capability assessment', () => {
  it('resolves selected calls as verified relative source files are added', async () => {
    const corpus = await loadExternalCorpus('todo');
    const closure = await loadTodoClosure();
    const base = await analyzeManifest({
      repositoryId: TODO_REPOSITORY_ID,
      compilerOptions: COMPILER_PROFILE,
      files: corpus.files,
    });
    const routeClosure = closure.filter(({ path }) =>
      path.startsWith('routes/'),
    );
    const withRouters = await analyzeManifest({
      repositoryId: TODO_REPOSITORY_ID,
      compilerOptions: COMPILER_PROFILE,
      files: [...corpus.files, ...routeClosure],
    });
    const withPassport = await analyzeManifest({
      repositoryId: TODO_REPOSITORY_ID,
      compilerOptions: COMPILER_PROFILE,
      files: [...corpus.files, ...routeClosure, closure[2]!],
    });
    const reordered = await analyzeManifest({
      repositoryId: TODO_REPOSITORY_ID,
      compilerOptions: COMPILER_PROFILE,
      files: [...corpus.files, ...routeClosure, closure[2]!].reverse(),
    });
    expect(reordered.facts).toEqual(withPassport.facts);
    const baselineCalls = statusesAtGoldCalls(corpus.gold, base);
    const completedCalls = statusesAtGoldCalls(corpus.gold, withPassport);
    expect(baselineCalls).toHaveLength(35);
    expect(completedCalls).toHaveLength(35);
    expect(new Set(baselineCalls.map(({ key }) => key)).size).toBe(35);
    expect(baselineCalls.every(({ status }) => status !== undefined)).toBe(
      true,
    );
    expect(completedCalls.every(({ status }) => status !== undefined)).toBe(
      true,
    );
    const completeByKey = new Map(
      completedCalls.map((call) => [call.key, call]),
    );
    expect(
      baselineCalls
        .filter((call) => call.status !== completeByKey.get(call.key)?.status)
        .map(({ text }) => text)
        .sort(),
    ).toEqual(['authRouter()', 'initialize()', 'userRouter()']);

    expect(observationForText(base, 'authRouter()').observation.status).toBe(
      'unresolved',
    );
    expect(observationForText(base, 'userRouter()').observation.status).toBe(
      'unresolved',
    );
    expect(observationForText(base, 'initialize()').observation.status).toBe(
      'unresolved',
    );
    expect(observationForText(base, 'todoRouter()').observation.status).toBe(
      'exact',
    );

    for (const text of ['authRouter()', 'userRouter()']) {
      const match = observationForText(withRouters, text);
      expect(match.observation.status).toBe('exact');
      const relation = withRouters.facts.relations.find(
        ({ id }) => id === match.observation.relationId,
      );
      const target = withRouters.facts.symbols.find(
        ({ id }) => id === relation?.resolution.targetId,
      );
      expect(target?.filePath).toBe(
        text === 'authRouter()'
          ? 'routes/auth.router.ts'
          : 'routes/user.router.ts',
      );
      const declaration =
        target && withRouters.source.readEvidence(target.declarationEvidenceId);
      expect(declaration?.status).toBe('available');
      if (declaration?.status === 'available')
        expect(declaration.text).toContain(`function ${text.slice(0, -2)}`);
    }
    expect(
      observationForText(withRouters, 'initialize()').observation.status,
    ).toBe('unresolved');
    const initialize = observationForText(withPassport, 'initialize()');
    expect(initialize.observation.status).toBe('exact');
    const initializeRelation = withPassport.facts.relations.find(
      ({ id }) => id === initialize.observation.relationId,
    );
    const initializeTarget = withPassport.facts.symbols.find(
      ({ id }) => id === initializeRelation?.resolution.targetId,
    );
    expect(initializeTarget?.filePath).toBe('config/passport.ts');
    expect(
      observationForText(withPassport, 'todoRouter()').observation.status,
    ).toBe('exact');

    const externalCall = observationForText(
      withPassport,
      'Router()',
      'routes/todo.router.ts',
    );
    expect(externalCall.observation.status).toBe('unsupported');
    const externalDiagnostic = withPassport.facts.diagnostics.find(
      ({ id }) => id === externalCall.observation.diagnosticId,
    );
    expect(externalDiagnostic?.code).toBe('EXTERNAL_MODULE');
    expect(
      withPassport.facts.diagnostics.some(
        ({ code, message }) =>
          code === 'TS_2307' && message.includes("'express'"),
      ),
    ).toBe(true);
  }, 30000);

  it('preserves relevant uncertainty without tainting target body calls', async () => {
    const corpus = await loadExternalCorpus('tinyexec');
    const snapshot = await analyzeManifest({
      repositoryId: TINYEXEC_REPOSITORY_ID,
      compilerOptions: COMPILER_PROFILE,
      files: corpus.files,
    });
    const selected = observationForText(
      snapshot,
      'addNodeBinToPath(cwd, getPathFromEnv(envWithDefault))',
    );
    expect(selected.observation.status).toBe('unresolved');
    const diagnostic = snapshot.facts.diagnostics.find(
      ({ id }) => id === selected.observation.diagnosticId,
    );
    expect(diagnostic?.code).toBe('INVALID_BINDING');
    const unrelatedExact = observationForText(
      snapshot,
      'getPathFromEnv(envWithDefault)',
    );
    expect(unrelatedExact.observation.status).toBe('exact');

    const controls = [
      {
        source:
          'function target() { return 1; }\nfunction caller() { return target(); }\nconst broken = missingOutside;\n',
        text: 'target()',
        status: 'exact',
      },
      {
        source:
          'function target() { return missingInside; }\nfunction caller() { return target(); }\n',
        text: 'target()',
        status: 'exact',
      },
      {
        source:
          'function target(value: number) { return value; }\nfunction caller() { return target(); }\n',
        text: 'target()',
        status: 'unresolved',
      },
    ] as const;
    for (const [index, control] of controls.entries()) {
      const file = {
        path: `controls/${index}.ts`,
        bytes: Buffer.from(control.source, 'utf8'),
      };
      const input = {
        repositoryId: `00000000-0000-4000-8000-00000000002${index + 4}`,
        compilerOptions: COMPILER_PROFILE,
        files: [
          {
            ...file,
            sha256: createHash('sha256').update(file.bytes).digest('hex'),
          },
        ],
      };
      const result = await analyzeManifest(input);
      expect(observationForText(result, control.text).observation.status).toBe(
        control.status,
      );
    }
  }, 30000);

  it('resolves three source method references without claiming calls or dispatch', async () => {
    const corpus = await loadExternalCorpus('todo');
    const closure = await loadTodoClosure();
    const methodInputs = closure.filter(({ path }) =>
      ['controllers/todo.controller.ts', 'models/todo.ts'].includes(path),
    );
    const { program, files } = createRestrictedProgram([
      ...corpus.files,
      ...methodInputs,
    ]);
    const checker = program.getTypeChecker();
    const routePath = resolve('fixtures/external/todo/routes/todo.router.ts');
    const controllerPath = resolve(
      'fixtures/external/todo/controllers/todo.controller.ts',
    );
    const route = program.getSourceFile(routePath);
    expect(route).toBeDefined();
    const references: {
      name: string;
      site: [SourcePosition, SourcePosition];
      target: [SourcePosition, SourcePosition];
      siteText: string;
      declarationText: string;
      targetErrorCodes: number[];
      constInstanceReceiver: boolean;
      targetFile: string;
      targetKind: 'method';
    }[] = [];
    const diagnostics = program.getSemanticDiagnostics();
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.arguments.length >= 2
      ) {
        const argument = node.arguments[1]!;
        if (ts.isPropertyAccessExpression(argument)) {
          const member = checker.getSymbolAtLocation(argument.name);
          const declarations = member?.declarations?.filter(
            ts.isMethodDeclaration,
          );
          if (declarations?.length === 1) {
            const declaration = declarations[0]!;
            const targetSource = declaration.getSourceFile();
            const receiverSymbol = checker.getSymbolAtLocation(
              argument.expression,
            );
            const receiver =
              receiverSymbol && receiverSymbol.flags & ts.SymbolFlags.Alias
                ? checker.getAliasedSymbol(receiverSymbol)
                : receiverSymbol;
            const receiverDeclaration = receiver?.declarations?.find(
              ts.isVariableDeclaration,
            );
            const initializer = receiverDeclaration?.initializer;
            const instanceClass =
              initializer && ts.isNewExpression(initializer)
                ? checker.getSymbolAtLocation(initializer.expression)
                : undefined;
            references.push({
              name: declaration.name.getText(targetSource),
              site: [
                lineColumn(argument.getSourceFile(), argument.getStart()),
                lineColumn(argument.getSourceFile(), argument.end),
              ],
              target: [
                lineColumn(targetSource, declaration.getStart(targetSource)),
                lineColumn(targetSource, declaration.end),
              ],
              siteText: argument.getText(),
              declarationText: declaration.getText(targetSource),
              targetErrorCodes: diagnostics
                .filter(
                  (diagnostic) =>
                    diagnostic.file === targetSource &&
                    diagnostic.start !== undefined &&
                    diagnostic.start < declaration.end &&
                    diagnostic.start + (diagnostic.length ?? 1) >
                      declaration.getStart(targetSource),
                )
                .map(({ code }) => code),
              constInstanceReceiver:
                receiverDeclaration !== undefined &&
                ts.isVariableDeclarationList(receiverDeclaration.parent) &&
                (receiverDeclaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
                initializer !== undefined &&
                ts.isNewExpression(initializer) &&
                (instanceClass?.declarations?.some(ts.isClassDeclaration) ??
                  false),
              targetFile: targetSource.fileName,
              targetKind: 'method',
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(route!);
    expect(references.map(({ name }) => name)).toEqual([
      'getAll',
      'getOne',
      'create',
    ]);
    expect(
      references.map(({ targetFile, target }) => [
        targetFile === controllerPath,
        target[0].line,
        target[1].line,
      ]),
    ).toEqual([
      [true, 10, 26],
      [true, 28, 40],
      [true, 42, 60],
    ]);
    expect(
      references.map(({ site }) => [
        site[0].line,
        site[0].column,
        site[1].line,
        site[1].column,
      ]),
    ).toEqual([
      [8, 19, 8, 34],
      [11, 22, 11, 37],
      [14, 20, 14, 35],
    ]);
    expect(references.map(({ siteText }) => siteText)).toEqual([
      'toDoCtrl.getAll',
      'toDoCtrl.getOne',
      'toDoCtrl.create',
    ]);
    expect(
      references.map(({ declarationText }) =>
        declarationText.slice(0, declarationText.indexOf('(')),
      ),
    ).toEqual(['async getAll', 'async getOne', 'async create']);
    expect(references.map(({ targetErrorCodes }) => targetErrorCodes)).toEqual([
      [],
      [],
      [],
    ]);
    expect(
      references.every(({ constInstanceReceiver }) => constInstanceReceiver),
    ).toBe(true);
    expect(
      diagnostics.some(
        ({ code, file }) => code === 2307 && file?.fileName === controllerPath,
      ),
    ).toBe(true);
    expect(
      diagnostics.some(
        ({ code, file, messageText }) =>
          code === 2307 &&
          file?.fileName === routePath &&
          ts
            .flattenDiagnosticMessageText(messageText, '\n')
            .includes("'express'"),
      ),
    ).toBe(true);
    expect(files.has(controllerPath)).toBe(true);

    const existing = await analyzeManifest({
      repositoryId: TODO_REPOSITORY_ID,
      compilerOptions: COMPILER_PROFILE,
      files: [...corpus.files, ...methodInputs],
    });
    const pinnedReferences = existing.facts.relations.filter(
      ({ kind, siteEvidenceId }) => {
        if (kind !== 'references') return false;
        const site = existing.source.readEvidence(siteEvidenceId);
        return site.status === 'available' && site.text.startsWith('toDoCtrl.');
      },
    );
    expect(pinnedReferences).toHaveLength(3);
    expect(
      pinnedReferences.every(
        (relation) => relation.resolution.status === 'exact',
      ),
    ).toBe(true);
    expect(existing.facts.coverageByCapability['references.v1']).toBe(
      'partial',
    );
    expect(
      observationForText(
        existing,
        "router.get('/', toDoCtrl.getAll)",
        'routes/todo.router.ts',
      ).observation.status,
    ).toBe('unsupported');
  }, 20000);

  it('does not treat computed, accessor, ambiguous, shadowed, or changed bindings as one unique method', () => {
    const source = `
      import { MissingController } from './missing-controller';
      class Outer { handle() {} }
      class Inner { handle() {} }
      class First { run() {} }
      class Second { run() {} }
      class Accessor { get handle() { return () => {}; } }
      const outer = new Outer();
      declare const either: First | Second;
      const accessor = new Accessor();
      function register(_value: unknown) {}
      function shadowed() {
        const outer = new Inner();
        register(outer.handle);
      }
      function missingBinding() {
        return missingModule.value;
      }
      register(MissingController.value);
      register(outer['handle']);
      register(accessor.handle);
      register(either.run);
      outer.handle = () => {};
      register(outer.handle);
      class Derived extends Outer { override handle() {} }
      const dynamic: Outer = new Derived();
      register(dynamic.handle);
      shadowed();
    `;
    const input = {
      path: 'assessment/references.ts',
      bytes: Buffer.from(source, 'utf8'),
    };
    const { program } = createRestrictedProgram([input]);
    const checker = program.getTypeChecker();
    const file = program.getSourceFile(
      resolve('fixtures/external/todo/assessment/references.ts'),
    );
    expect(file).toBeDefined();
    const selected: {
      line: number;
      expression: string;
      symbol: ts.Symbol | undefined;
    }[] = [];
    const computed = new Set<string>();
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(file!) === 'register'
      ) {
        const argument = node.arguments[0]!;
        const label = argument.getText(file!);
        if (ts.isElementAccessExpression(argument)) computed.add(label);
        else if (ts.isPropertyAccessExpression(argument)) {
          selected.push({
            line: lineColumn(file!, argument.getStart()).line,
            expression: label,
            symbol: checker.getSymbolAtLocation(argument.name),
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file!);

    expect(computed.has("outer['handle']")).toBe(true);
    const accessor = selected.find(
      ({ expression }) => expression === 'accessor.handle',
    )?.symbol;
    expect(accessor?.declarations?.some(ts.isGetAccessorDeclaration)).toBe(
      true,
    );
    const ambiguous = selected.find(
      ({ expression }) => expression === 'either.run',
    )?.symbol;
    expect(
      (ambiguous?.declarations ?? []).filter(ts.isMethodDeclaration),
    ).toHaveLength(2);
    const missingReference = selected.find(
      ({ expression }) => expression === 'MissingController.value',
    )?.symbol;
    expect(
      (missingReference?.declarations ?? []).filter(ts.isMethodDeclaration),
    ).toHaveLength(0);
    const shadowedLine = lineColumn(
      file!,
      file!.text.indexOf('register(outer.handle)'),
    ).line;
    const shadowed = selected.find(({ line }) => line === shadowedLine)?.symbol;
    const shadowedMethod = shadowed?.declarations?.find(ts.isMethodDeclaration);
    expect(
      shadowedMethod &&
        ts.isClassDeclaration(shadowedMethod.parent) &&
        shadowedMethod.parent.name?.text,
    ).toBe('Inner');
    const mutated = selected.find(
      ({ expression, line }) => expression === 'outer.handle' && line > 15,
    )?.symbol;
    const mutatedMethod = mutated?.declarations?.find(ts.isMethodDeclaration);
    expect(
      mutatedMethod &&
        ts.isClassDeclaration(mutatedMethod.parent) &&
        mutatedMethod.parent.name?.text,
    ).toBe('Outer');
    const overridden = selected.find(
      ({ expression }) => expression === 'dynamic.handle',
    )?.symbol;
    const overriddenMethod = overridden?.declarations?.find(
      ts.isMethodDeclaration,
    );
    expect(
      overriddenMethod &&
        ts.isClassDeclaration(overriddenMethod.parent) &&
        overriddenMethod.parent.name?.text,
    ).toBe('Outer');
    expect(file!.text).toContain('outer.handle = () => {}');
    const missing = program.getSourceFile(
      resolve('fixtures/external/todo/assessment/references.ts'),
    );
    expect(
      program.getSemanticDiagnostics(missing).some(({ code }) => code === 2307),
    ).toBe(true);
  });
});
