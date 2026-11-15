import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../', import.meta.url);
function readRepositoryFile(path: string): string {
  return readFileSync(new URL(path, repositoryRoot), 'utf8');
}

function parseSource(path: string): ts.SourceFile {
  return ts.createSourceFile(
    fileURLToPath(new URL(path, repositoryRoot)),
    readRepositoryFile(path),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function stringValue(node: ts.Node | undefined): string | null {
  return node && ts.isStringLiteral(node) ? node.text : null;
}

function backendRoutes(): Set<string> {
  const source = parseSource('scripts/backend/http.ts');
  const routes = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'is'
    ) {
      const values = node.arguments.map(stringValue);
      if (values.every((value): value is string => value !== null)) {
        const [method, ...parts] = values;
        routes.add(
          `${method} /${parts.map((part) => (part === '*' ? ':param' : part)).join('/')}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return routes;
}

function viewerApiRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const path of [
    'scripts/viewer-api.ts',
    'scripts/viewer-projection.ts',
  ]) {
    const source = parseSource(path);
    function visit(node: ts.Node): void {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      ) {
        const [identifier, literal] = [node.left, node.right];
        const reverse = [node.right, node.left] as const;
        if (
          ts.isIdentifier(identifier) &&
          identifier.text === 'pathname' &&
          stringValue(literal)?.startsWith('/api/')
        )
          routes.add(`POST ${stringValue(literal)}`);
        else if (
          ts.isIdentifier(reverse[0]) &&
          reverse[0].text === 'pathname' &&
          stringValue(reverse[1])?.startsWith('/api/')
        )
          routes.add(`POST ${stringValue(reverse[1])}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return routes;
}

function staticViewerRoutes(): Set<string> {
  const source = parseSource('scripts/viewer.ts');
  const routes = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'paths' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    )
      for (const element of node.initializer.elements) {
        const path = stringValue(element);
        if (path) routes.add(`GET ${path}`);
      }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return routes;
}

function documentationRoutes(markdown: string): Set<string> {
  const routes = new Set<string>();
  for (const match of markdown.matchAll(/`(GET|POST) (\/[^`\s]*)`/g)) {
    const method = match[1]!,
      path = match[2]!.split('?', 1)[0]!.replace(/:[^/]+/g, ':param');
    routes.add(`${method} ${path}`);
  }
  return routes;
}

function sectionBetween(markdown: string, start: string, end: string): string {
  const startAt = markdown.indexOf(start),
    endAt = markdown.indexOf(end, startAt + start.length);
  if (startAt < 0 || endAt < 0)
    throw new Error(`Could not find documentation section ${start}`);
  return markdown.slice(startAt, endAt);
}

function expectDocumented(implemented: Set<string>, markdown: string): void {
  const documented = documentationRoutes(markdown);
  expect(implemented.size).toBeGreaterThan(0);
  for (const route of implemented) expect(documented, route).toContain(route);
}

describe('implemented HTTP route documentation', () => {
  const inventory = readRepositoryFile('docs/api/inventory.md'),
    backendGuide = readRepositoryFile('docs/backend.md');

  it('lists every backend route in both API and setup documentation', () => {
    const routes = backendRoutes(),
      inventoryRoutes = sectionBetween(
        inventory,
        '## Persistent local backend API candidate',
        '### Error and compatibility boundary',
      ),
      guideRoutes = sectionBetween(
        backendGuide,
        '## Routes',
        '## Retention and backup',
      );
    expectDocumented(routes, inventoryRoutes);
    expectDocumented(routes, guideRoutes);
  });

  it('lists every dynamic viewer API and static asset route', () => {
    const viewerSection = sectionBetween(
        inventory,
        '## Actual ephemeral viewer HTTP routes',
        '## Persistent local backend API candidate',
      ),
      apiRoutes = new Set(
        [...viewerApiRoutes()].filter((route) =>
          route.startsWith('POST /api/'),
        ),
      ),
      staticRoutes = staticViewerRoutes();
    expect(apiRoutes.size).toBe(8);
    expect(staticRoutes.size).toBe(7);
    expectDocumented(apiRoutes, viewerSection);
    expectDocumented(staticRoutes, viewerSection);
  });
});
