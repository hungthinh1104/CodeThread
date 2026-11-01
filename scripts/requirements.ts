import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseDocument } from 'yaml';

export interface Requirement {
  id: string;
  title: string;
  module: string;
  statement: string;
  lifecycle: 'proposed' | 'accepted' | 'deprecated';
  priority: 'must' | 'should' | 'could';
  acceptance: { id: string; given: string; when?: string; then: string }[];
  depends_on: string[];
  verification: {
    method: 'automated' | 'manual' | 'mixed' | 'benchmark' | 'study';
    description?: string;
    test_ids?: string[];
  };
}

export class RegistryError extends Error {
  readonly code: string;
  readonly details: string[];
  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'RegistryError';
  }
}
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const registryDirectory = fileURLToPath(
  new URL('../requirements/', import.meta.url),
);
const schemaPath = fileURLToPath(
  new URL('../requirements/schema.json', import.meta.url),
);

export async function parseRegistry(
  files: readonly { path: string; content: string }[],
): Promise<Requirement[]> {
  const schema: unknown = JSON.parse(await readFile(schemaPath, 'utf8'));
  const validate = new Ajv2020({
    allErrors: true,
    strict: true,
  }).compile<Requirement>(schema as object);
  const requirements: Requirement[] = [];
  const ids = new Set<string>();
  for (const file of [...files].sort((left, right) =>
    compare(left.path, right.path),
  )) {
    if (Buffer.byteLength(file.content, 'utf8') > 1024 * 1024)
      throw new RegistryError('FILE_LIMIT', 'Requirement file exceeds 1 MiB', [
        file.path,
      ]);
    let value: unknown;
    try {
      const document = parseDocument(file.content, {
        uniqueKeys: true,
        version: '1.2',
      });
      if (document.errors.length > 0 || document.warnings.length > 0)
        throw new Error('Malformed YAML or unsupported tag');
      value = document.toJS({ maxAliasCount: 0 });
    } catch {
      throw new RegistryError(
        'INVALID_YAML',
        'Malformed YAML, duplicate keys, tags, or aliases',
        [file.path],
      );
    }
    if (!validate(value)) {
      throw new RegistryError(
        'INVALID_REQUIREMENT',
        'Requirement does not match the schema',
        [
          file.path,
          ...(validate.errors ?? []).map(
            (error) =>
              `${error.instancePath || '/'} ${error.message ?? 'invalid'}`,
          ),
        ],
      );
    }
    if (ids.has(value.id))
      throw new RegistryError(
        'DUPLICATE_ID',
        'Requirement IDs must be unique',
        [value.id],
      );
    if (
      new Set(value.acceptance.map((criterion) => criterion.id)).size !==
      value.acceptance.length
    ) {
      throw new RegistryError(
        'DUPLICATE_ACCEPTANCE',
        'Acceptance IDs must be unique within a requirement',
        [value.id],
      );
    }
    ids.add(value.id);
    requirements.push({
      ...value,
      depends_on: [...value.depends_on].sort(compare),
    });
  }
  requirements.sort((left, right) => compare(left.id, right.id));
  const byId = new Map(
    requirements.map((requirement) => [requirement.id, requirement]),
  );
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(id: string, chain: string[]): void {
    if (active.has(id))
      throw new RegistryError(
        'DEPENDENCY_CYCLE',
        'Requirement dependency cycle',
        [...chain, id],
      );
    if (visited.has(id)) return;
    const requirement = byId.get(id);
    if (!requirement)
      throw new RegistryError('UNKNOWN_DEPENDENCY', 'Unknown dependency', [
        ...chain,
        id,
      ]);
    active.add(id);
    for (const dependency of requirement.depends_on)
      visit(dependency, [...chain, id]);
    active.delete(id);
    visited.add(id);
  }
  for (const requirement of requirements) visit(requirement.id, []);
  return requirements;
}

export async function loadRegistry(
  directory = registryDirectory,
): Promise<Requirement[]> {
  const names = (await readdir(directory))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort(compare);
  if (names.length === 0)
    throw new RegistryError(
      'EMPTY_REGISTRY',
      'No requirement YAML files found',
    );
  const files = await Promise.all(
    names.map(async (name) => ({
      path: name,
      content: await readFile(resolve(directory, name), 'utf8'),
    })),
  );
  return parseRegistry(files);
}

export function findRequirement(
  requirements: readonly Requirement[],
  id: string,
): Requirement {
  const requirement = requirements.find((entry) => entry.id === id);
  if (!requirement)
    throw new RegistryError('UNKNOWN_ID', 'Unknown requirement ID', [id]);
  return requirement;
}

export function requirementContext(
  requirements: readonly Requirement[],
  id: string,
): object {
  const requirement = findRequirement(requirements, id);
  const byId = new Map(requirements.map((entry) => [entry.id, entry]));
  const seen = new Set([id]);
  const queue = requirement.depends_on.map((dependency) => ({
    id: dependency,
    depth: 1,
  }));
  const reachable: { requirement: Requirement; depth: number }[] = [];
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    const dependency = byId.get(item.id);
    if (!dependency)
      throw new RegistryError('UNKNOWN_DEPENDENCY', 'Unknown dependency', [
        item.id,
      ]);
    reachable.push({ requirement: dependency, depth: item.depth });
    queue.push(
      ...dependency.depends_on.map((child) => ({
        id: child,
        depth: item.depth + 1,
      })),
    );
  }
  const candidates = reachable.filter((item) => item.depth <= 2).slice(0, 20);
  const dependencies: Requirement[] = [];
  const reasons = new Set<string>();
  if (reachable.some((item) => item.depth > 2)) reasons.add('depth_limit');
  if (reachable.filter((item) => item.depth <= 2).length > 20)
    reasons.add('dependency_limit');
  const references = ['docs/architecture.md', 'requirements/schema.json'];
  if (requirement.module === 'code-model' || requirement.module === 'contracts')
    references.push(`packages/${requirement.module}/src/index.ts`);
  function result(): object {
    return {
      requirement,
      dependencies,
      module: requirement.module,
      references,
      limits: { depth: 2, dependencies: 20, bytes: 65536 },
      truncated: dependencies.length < reachable.length,
      truncationReasons: [...reasons].sort(compare),
      omittedCount: reachable.length - dependencies.length,
    };
  }
  const bytes = (): number =>
    Buffer.byteLength(JSON.stringify(result()) + '\n', 'utf8');
  if (bytes() > 65536)
    throw new RegistryError(
      'CONTEXT_LIMIT',
      'Selected requirement exceeds the context budget',
      [id],
    );
  for (const candidate of candidates) {
    dependencies.push(candidate.requirement);
    if (bytes() > 65536) {
      dependencies.pop();
      reasons.add('byte_limit');
      break;
    }
  }
  // Adding a reason or changing counters can itself grow the envelope.
  while (bytes() > 65536 && dependencies.length > 0) dependencies.pop();
  if (bytes() > 65536)
    throw new RegistryError(
      'CONTEXT_LIMIT',
      'Selected requirement exceeds the context budget',
      [id],
    );
  return result();
}

export async function runRequirements(
  args: readonly string[],
): Promise<object> {
  const [command, id, ...extra] = args;
  if (
    !['validate', 'list', 'show', 'context'].includes(command ?? '') ||
    extra.length > 0 ||
    (command === 'show' || command === 'context' ? !id : id !== undefined)
  ) {
    throw new RegistryError(
      'USAGE',
      'Use validate, list, show <id>, or context <id>',
    );
  }
  const requirements = await loadRegistry();
  if (command === 'validate')
    return { valid: true, count: requirements.length };
  if (command === 'list')
    return {
      requirements: requirements.map(
        ({ id, title, module, lifecycle, priority }) => ({
          id,
          title,
          module,
          lifecycle,
          priority,
        }),
      ),
    };
  if (command === 'show') return findRequirement(requirements, id!);
  return requirementContext(requirements, id!);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    process.stdout.write(
      JSON.stringify(await runRequirements(process.argv.slice(2))) + '\n',
    );
  } catch (error) {
    const failure =
      error instanceof RegistryError
        ? error
        : new RegistryError('REGISTRY_IO', 'Unable to load the registry');
    process.stderr.write(
      JSON.stringify({
        error: {
          code: failure.code,
          message: failure.message,
          details: failure.details,
        },
      }) + '\n',
    );
    process.exitCode = failure.code === 'USAGE' ? 2 : 1;
  }
}
