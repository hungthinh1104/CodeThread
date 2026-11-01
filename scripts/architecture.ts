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
const allowed: Record<string, readonly string[]> = {
  '@codethread/code-model': ['zod'],
  '@codethread/contracts': ['zod', '@codethread/code-model'],
};
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

export function checkArchitecture(packages: readonly PackageInput[]): string[] {
  const errors: string[] = [];
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  if (byName.size !== packages.length) errors.push('Duplicate package name');
  for (const entry of packages) {
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
        if (specifier.startsWith('.')) {
          if (
            !inside(
              resolve(source.path, '..', specifier),
              resolve(entry.directory, 'src'),
            )
          ) {
            errors.push(
              `${entry.name}: cross-boundary relative import ${specifier}`,
            );
          }
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
      function visit(node: ts.Node): void {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier
        ) {
          if (ts.isStringLiteral(node.moduleSpecifier))
            inspect(node.moduleSpecifier.text);
        }
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
        ) {
          errors.push(`${entry.name}: CommonJS imports are forbidden`);
        }
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument)) inspect(argument.text);
          else
            errors.push(
              `${entry.name}: nonliteral dynamic import cannot be checked`,
            );
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  function visitPackage(name: string): void {
    if (active.has(name)) {
      errors.push(`Package dependency cycle at ${name}`);
      return;
    }
    if (visited.has(name)) return;
    active.add(name);
    const entry = byName.get(name);
    for (const dependency of Object.keys({
      ...entry?.dependencies,
      ...entry?.devDependencies,
    })) {
      if (byName.has(dependency)) visitPackage(dependency);
    }
    active.delete(name);
    visited.add(name);
  }
  for (const entry of packages) visitPackage(entry.name);
  return [...new Set(errors)].sort();
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error('Source symlinks are not permitted in core packages');
    if (entry.isDirectory()) result.push(...(await sourceFiles(path)));
    else if (/\.[cm]?tsx?$/.test(entry.name)) result.push(path);
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
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const packages = await loadPackages();
    const errors = checkArchitecture(packages);
    process.stdout.write(
      JSON.stringify({
        valid: errors.length === 0,
        packages: packages.map((entry) => entry.name).sort(),
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
