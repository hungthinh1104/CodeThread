import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { checkArchitecture, loadPackages } from '../scripts/architecture.ts';
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
});
