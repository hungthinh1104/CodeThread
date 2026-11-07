import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export interface PackageInput {
  name: string;
  directory: string;
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports: Record<string, unknown>;
  sources: { path: string; content: string }[];
}
export interface ApplicationSourceInput {
  path: string;
  content: string;
}
const allowed: Record<string, readonly string[]> = {
  '@codethread/code-model': ['zod'],
  '@codethread/contracts': ['zod', '@codethread/code-model'],
  '@codethread/symbol-indexer': [
    '@codethread/code-model',
    'typescript',
    '@types/node',
  ],
  '@codethread/trace-engine': [
    '@codethread/code-model',
    '@codethread/contracts',
    '@types/node',
  ],
};
const nodeBuiltins: Record<string, readonly string[]> = {
  '@codethread/symbol-indexer': [
    'node:crypto',
    'node:child_process',
    'node:fs',
    'node:path',
    'node:url',
    'node:v8',
  ],
  '@codethread/trace-engine': ['node:crypto'],
};
const contractFacades = new Set(['index.ts', 'schemas.ts', 'results.ts']);
function inside(path: string, directory: string): boolean {
  const remainder = relative(directory, path);
  return (
    remainder === '' ||
    (remainder !== '..' &&
      !remainder.startsWith(`..${sep}`) &&
      !isAbsolute(remainder))
  );
}
function packageName(specifier: string): string {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]!;
}

function visitModuleImports(
  tree: ts.SourceFile,
  inspect: (specifier: string) => void,
  onCommonJs: () => void,
  onUncheckableDynamicImport: () => void,
): void {
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      inspect(node.moduleSpecifier.text);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      inspect(node.argument.literal.text);
    if (
      ts.isImportEqualsDeclaration(node) ||
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require')
    )
      onCommonJs();
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) inspect(argument.text);
      else onUncheckableDynamicImport();
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}

function cycleNodes(graph: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const cycles = new Set<string>();
  function visit(name: string): void {
    if (active.has(name)) {
      cycles.add(name);
      return;
    }
    if (visited.has(name)) return;
    active.add(name);
    for (const target of graph.get(name) ?? []) visit(target);
    active.delete(name);
    visited.add(name);
  }
  for (const name of graph.keys()) visit(name);
  return [...cycles];
}

function sourceName(path: string, root: string): string {
  return relative(root, path).split(sep).join('/');
}

export function checkArchitecture(packages: readonly PackageInput[]): string[] {
  const errors: string[] = [];
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  if (byName.size !== packages.length) errors.push('Duplicate package name');
  for (const entry of packages) {
    const sourceRoot = resolve(entry.directory, 'src');
    const sourceGraph = new Map(
      entry.sources.map((source) => [
        sourceName(resolve(source.path), sourceRoot),
        new Set<string>(),
      ]),
    );
    if (!allowed[entry.name])
      errors.push(`${entry.name}: missing explicit module ownership`);
    if (Object.keys(entry.exports).length !== 1 || !('.' in entry.exports))
      errors.push(`${entry.name}: only the public root export is allowed`);
    for (const dependency of Object.keys({
      ...entry.dependencies,
      ...entry.devDependencies,
    })) {
      if (!allowed[entry.name]?.includes(dependency))
        errors.push(`${entry.name}: forbidden dependency ${dependency}`);
    }
    for (const source of entry.sources) {
      const tree = ts.createSourceFile(
        source.path,
        source.content,
        ts.ScriptTarget.Latest,
        true,
      );
      function inspect(specifier: string): void {
        if (nodeBuiltins[entry.name]?.includes(specifier)) return;
        if (specifier.startsWith('.')) {
          const target = resolve(source.path, '..', specifier);
          if (!inside(target, sourceRoot)) {
            errors.push(
              `${entry.name}: cross-boundary relative import ${specifier}`,
            );
          }
          const origin = sourceName(resolve(source.path), sourceRoot);
          const targetName = sourceName(target, sourceRoot);
          const candidates = [
            targetName,
            targetName.replace(/\.([cm]?)js$/, '.$1ts'),
            targetName.replace(/\.js$/, '.tsx'),
            targetName.replace(/\.js$/, '.d.ts'),
          ];
          const linked = candidates.find((name) => sourceGraph.has(name));
          if (linked) sourceGraph.get(origin)!.add(linked);
          if (
            entry.name === '@codethread/contracts' &&
            !contractFacades.has(origin) &&
            candidates.some((name) => contractFacades.has(name))
          )
            errors.push(
              `${entry.name}: implementation import through facade ${specifier}`,
            );
          return;
        }
        const imported = packageName(specifier);
        if (!entry.dependencies[imported])
          errors.push(`${entry.name}: undeclared import ${specifier}`);
        if (!allowed[entry.name]?.includes(imported))
          errors.push(`${entry.name}: forbidden import ${specifier}`);
        if (specifier !== imported)
          errors.push(`${entry.name}: deep import ${specifier}`);
      }
      visitModuleImports(
        tree,
        inspect,
        () => errors.push(`${entry.name}: CommonJS imports are forbidden`),
        () =>
          errors.push(
            `${entry.name}: nonliteral dynamic import cannot be checked`,
          ),
      );
    }
    for (const name of cycleNodes(sourceGraph))
      errors.push(`${entry.name}: source import cycle at ${name}`);
  }
  const packageGraph = new Map(
    packages.map((entry) => [
      entry.name,
      new Set(
        Object.keys({
          ...entry.dependencies,
          ...entry.devDependencies,
        }).filter((name) => byName.has(name)),
      ),
    ]),
  );
  for (const name of cycleNodes(packageGraph))
    errors.push(`Package dependency cycle at ${name}`);
  return [...new Set(errors)].sort();
}

function applicationLayerError(
  origin: string,
  target: string,
): string | undefined {
  const isScripts = target.startsWith('scripts/');
  if (origin.startsWith('scripts/git-source/') && isScripts) {
    if (!target.startsWith('scripts/git-source/'))
      return `Git source module imports outside its owner: ${origin} -> ${target}`;
  }
  if (origin.startsWith('scripts/investigation/') && isScripts) {
    if (/^scripts\/(?:investigate|git-source)\.(?:ts|js)$/.test(target))
      return `Investigation module imports through a compatibility facade: ${origin} -> ${target}`;
    const allowed =
      target.startsWith('scripts/investigation/') ||
      target.startsWith('scripts/git-source/') ||
      target === 'scripts/viewer.ts' ||
      target === 'scripts/external-semantic-corpus.ts';
    if (!allowed)
      return `Investigation module imports outside its declared layers: ${origin} -> ${target}`;
  }
  if (
    (origin.startsWith('scripts/source-discovery-benchmark/') ||
      origin === 'scripts/benchmark-source-discovery.ts') &&
    isScripts
  ) {
    const allowed =
      target.startsWith('scripts/source-discovery-benchmark/') ||
      target.startsWith('scripts/git-source/');
    if (!allowed)
      return `Source discovery benchmark imports an application interface: ${origin} -> ${target}`;
  }
  if (origin === 'scripts/viewer.js' && isScripts) {
    if (!target.startsWith('scripts/viewer-client/') || !target.endsWith('.js'))
      return `Browser viewer imports a server-side module: ${origin} -> ${target}`;
  }
  if (origin.startsWith('scripts/viewer-client/') && isScripts) {
    if (!target.startsWith('scripts/viewer-client/') || !target.endsWith('.js'))
      return `Browser module imports outside its browser owner: ${origin} -> ${target}`;
  }
  return undefined;
}

function applicationCandidates(targetName: string): string[] {
  const javascript = targetName.match(/\.([cm]?)js$/);
  return [
    targetName,
    ...(javascript
      ? [
          targetName.replace(/\.([cm]?)js$/, '.$1ts'),
          targetName.replace(/\.js$/, '.tsx'),
          targetName.replace(/\.js$/, '.d.ts'),
        ]
      : [
          `${targetName}.ts`,
          `${targetName}.tsx`,
          `${targetName}.js`,
          `${targetName}/index.ts`,
          `${targetName}/index.js`,
        ]),
  ];
}

export function checkApplicationArchitecture(
  sources: readonly ApplicationSourceInput[],
  repositoryRoot = resolve('.'),
): string[] {
  const errors: string[] = [];
  const byName = new Map(
    sources.map((source) => [
      sourceName(resolve(source.path), repositoryRoot),
      source,
    ]),
  );
  if (byName.size !== sources.length)
    errors.push('Duplicate application source path');
  const graph = new Map(
    [...byName.keys()].map((name) => [name, new Set<string>()]),
  );
  for (const [origin, source] of byName) {
    const tree = ts.createSourceFile(
      source.path,
      source.content,
      ts.ScriptTarget.Latest,
      true,
    );
    const inspect = (specifier: string): void => {
      if (!specifier.startsWith('.')) {
        if (origin === 'scripts/viewer.js')
          errors.push(`Browser viewer imports a nonlocal module: ${specifier}`);
        return;
      }
      const targetPath = resolve(source.path, '..', specifier);
      if (!inside(targetPath, repositoryRoot)) {
        errors.push(
          `Application source escapes the repository: ${origin} -> ${specifier}`,
        );
        return;
      }
      const targetName = sourceName(targetPath, repositoryRoot);
      const matched = applicationCandidates(targetName).find((name) =>
        byName.has(name),
      );
      if (matched) graph.get(origin)!.add(matched);
      const violation = applicationLayerError(origin, targetName);
      if (violation) errors.push(violation);
    };
    visitModuleImports(
      tree,
      inspect,
      () => errors.push(`${origin}: CommonJS imports are forbidden`),
      () =>
        errors.push(`${origin}: nonliteral dynamic import cannot be checked`),
    );
  }
  for (const name of cycleNodes(graph))
    errors.push(`Application source import cycle at ${name}`);
  return [...new Set(errors)].sort();
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error('Source symlinks are not permitted');
    if (entry.isDirectory()) result.push(...(await sourceFiles(path)));
    else if (/\.(?:[cm]?tsx?|js)$/.test(entry.name)) result.push(path);
  }
  return result.sort();
}
export async function loadPackages(): Promise<PackageInput[]> {
  const root = fileURLToPath(new URL('../packages/', import.meta.url));
  const result: PackageInput[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new Error('Package symlinks are not permitted');
    if (!entry.isDirectory()) continue;
    const directory = resolve(root, entry.name);
    const manifest = JSON.parse(
      await readFile(resolve(directory, 'package.json'), 'utf8'),
    ) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
    };
    result.push({
      name: manifest.name,
      directory,
      dependencies: { ...manifest.dependencies, ...manifest.peerDependencies },
      devDependencies: manifest.devDependencies ?? {},
      exports: manifest.exports ?? {},
      sources: await Promise.all(
        (await sourceFiles(resolve(directory, 'src'))).map(async (path) => ({
          path,
          content: await readFile(path, 'utf8'),
        })),
      ),
    });
  }
  return result;
}

export async function loadApplicationSources(): Promise<
  ApplicationSourceInput[]
> {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directories = [resolve(root, 'scripts'), resolve(root, 'tests')];
  const paths = (await Promise.all(directories.map(sourceFiles))).flat().sort();
  return await Promise.all(
    paths.map(async (path) => ({
      path,
      content: await readFile(path, 'utf8'),
    })),
  );
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const [packages, applicationSources] = await Promise.all([
      loadPackages(),
      loadApplicationSources(),
    ]);
    const errors = [
      ...checkArchitecture(packages),
      ...checkApplicationArchitecture(applicationSources),
    ];
    process.stdout.write(
      JSON.stringify({
        valid: errors.length === 0,
        packages: packages.map((entry) => entry.name).sort(),
        applicationFiles: applicationSources.length,
        errors,
      }) + '\n',
    );
    process.exitCode = errors.length > 0 ? 1 : 0;
  } catch {
    process.stderr.write(
      JSON.stringify({
        error: {
          code: 'ARCHITECTURE_IO',
          message: 'Unable to inspect package boundaries',
        },
      }) + '\n',
    );
    process.exitCode = 1;
  }
}
