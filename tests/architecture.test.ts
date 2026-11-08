import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  checkApplicationArchitecture,
  checkArchitecture,
  loadApplicationSources,
  loadPackages,
} from '../scripts/architecture.ts';
import type { PackageInput } from '../scripts/architecture.ts';

function core(
  content = "import { z } from 'zod'; export { z };",
): PackageInput {
  const directory = resolve('packages/code-model');
  return {
    name: '@codethread/code-model',
    directory,
    dependencies: { zod: '4.6.7' },
    exports: { '.': './dist/index.js' },
    sources: [{ path: resolve(directory, 'src/index.ts'), content }],
  };
}
function contracts(
  content = "export { idSchema } from '@codethread/code-model';",
): PackageInput {
  const directory = resolve('packages/contracts');
  return {
    name: '@codethread/contracts',
    directory,
    dependencies: { '@codethread/code-model': 'workspace:*', zod: '4.6.7' },
    exports: { '.': './dist/index.js' },
    sources: [{ path: resolve(directory, 'src/index.ts'), content }],
  };
}
describe('CT-CORE-003 architecture boundaries', () => {
  it('accepts the real workspace and declared public imports', async () => {
    expect(checkArchitecture(await loadPackages())).toEqual([]);
    expect(checkArchitecture([core(), contracts()])).toEqual([]);
    expect(checkArchitecture([core("import './..internal/file.js';")])).toEqual(
      [],
    );
  });
  it.each([
    "import '@codethread/code-model/src/internal.js';",
    "export * from '../../code-model/src/index.js';",
    "type T = import('@codethread/code-model/internal').T;",
    "await import('@codethread/code-model/internal');",
    'await import(variable);',
    "const model = require('@codethread/code-model');",
  ])('rejects inaccessible imports: %s', (content) => {
    expect(
      checkArchitecture([core(), contracts(content)]).length,
    ).toBeGreaterThan(0);
  });
  it('rejects undeclared imports, runtime adapters in the core and package cycles', () => {
    expect(checkArchitecture([core("import 'pg';")]).join(' ')).toContain(
      'undeclared',
    );
    const framework = core("import 'fastify';");
    framework.dependencies['fastify'] = '5.0.0';
    expect(checkArchitecture([framework]).join(' ')).toContain('forbidden');
    const circular = core();
    circular.dependencies['@codethread/contracts'] = 'workspace:*';
    expect(checkArchitecture([circular, contracts()]).join(' ')).toContain(
      'cycle',
    );
    const developmentCycle = core();
    developmentCycle.devDependencies = {
      '@codethread/contracts': 'workspace:*',
    };
    expect(
      checkArchitecture([developmentCycle, contracts()]).join(' '),
    ).toContain('cycle');
  });
  it('requires explicit module ownership and a single public export', () => {
    const unknown = core();
    unknown.name = '@codethread/mystery';
    expect(checkArchitecture([unknown]).join(' ')).toContain('ownership');
    const deep = core();
    deep.exports['./internal'] = './src/internal.ts';
    expect(checkArchitecture([deep]).join(' ')).toContain('public root');
  });
  it('rejects internal source cycles while accepting acyclic implementation imports', () => {
    const entry = contracts("export * from './graph.js';");
    const source = {
      path: resolve(entry.directory, 'src/source.ts'),
      content: "type Graph = import('./graph.js').Graph;",
    };
    entry.sources.push(
      {
        path: resolve(entry.directory, 'src/graph.ts'),
        content: "export * from './source.js';",
      },
      source,
    );
    expect(checkArchitecture([core(), entry]).join(' ')).toContain(
      'source import cycle',
    );
    source.content = 'export const source = 1;';
    expect(checkArchitecture([core(), entry])).toEqual([]);
  });
  it('rejects contracts implementation imports through compatibility facades', () => {
    for (const facade of ['index', 'schemas', 'results']) {
      const entry = contracts();
      entry.sources.push({
        path: resolve(entry.directory, 'src/graph.ts'),
        content: `import './${facade}.js';`,
      });
      expect(checkArchitecture([core(), entry]).join(' ')).toContain(
        'implementation import through facade',
      );
    }
  });
  it('rejects trace implementation imports through the public facade', () => {
    const directory = resolve('packages/trace-engine');
    const trace: PackageInput = {
      name: '@codethread/trace-engine',
      directory,
      dependencies: {
        '@codethread/code-model': 'workspace:*',
        '@codethread/contracts': 'workspace:*',
      },
      exports: { '.': './dist/index.js' },
      sources: [
        {
          path: resolve(directory, 'src/index.ts'),
          content: 'export const createInvestigation = () => {};',
        },
        {
          path: resolve(directory, 'src/traversal.ts'),
          content: "type Investigation = import('./index.js').Investigation;",
        },
      ],
    };
    expect(checkArchitecture([core(), contracts(), trace]).join(' ')).toContain(
      'implementation import through facade',
    );
    trace.sources[1]!.content = "import './context.js';";
    trace.sources.push({
      path: resolve(directory, 'src/context.ts'),
      content: 'export const context = {};',
    });
    expect(checkArchitecture([core(), contracts(), trace])).toEqual([]);
  });
  it('keeps compiler extraction and filesystem access out of the trace engine', () => {
    const directory = resolve('packages/trace-engine');
    const trace: PackageInput = {
      name: '@codethread/trace-engine',
      directory,
      dependencies: {
        '@codethread/code-model': 'workspace:*',
        '@codethread/contracts': 'workspace:*',
        typescript: '6.0.3',
      },
      exports: { '.': './dist/index.js' },
      sources: [
        {
          path: resolve(directory, 'src/index.ts'),
          content: "import 'typescript'; import 'node:fs';",
        },
      ],
    };
    const errors = checkArchitecture([core(), contracts(), trace]).join(' ');
    expect(errors).toContain('forbidden dependency typescript');
    expect(errors).toContain('forbidden import node:fs');
  });
  it('accepts the application modules currently present in the workspace', async () => {
    expect(
      checkApplicationArchitecture(await loadApplicationSources()),
    ).toEqual([]);
  });
  it('rejects application cycles, owner-layer imports and server imports in browser code', () => {
    const cycle = checkApplicationArchitecture([
      {
        path: resolve('scripts/investigation/one.ts'),
        content: "import './two.js';",
      },
      {
        path: resolve('scripts/investigation/two.ts'),
        content: "import './one.js';",
      },
    ]);
    expect(cycle.join(' ')).toContain('Application source import cycle');

    const wrongLayer = checkApplicationArchitecture([
      {
        path: resolve('scripts/git-source/selection.ts'),
        content: "import '../investigation/cli.js';",
      },
      {
        path: resolve('scripts/investigation/session.ts'),
        content: "import '../git-source.ts';",
      },
      {
        path: resolve('scripts/viewer.js'),
        content: "import 'node:fs'; import './viewer.ts';",
      },
      {
        path: resolve('scripts/viewer-client/browser.js'),
        content: "import 'some-package';",
      },
    ]);
    expect(wrongLayer.join(' ')).toContain('Git source module imports outside');
    expect(wrongLayer.join(' ')).toContain('compatibility facade');
    expect(wrongLayer.join(' ')).toContain('Browser viewer imports a nonlocal');
    expect(wrongLayer.join(' ')).toContain('Browser module imports a nonlocal');
  });
});
