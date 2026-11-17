import { readFile } from 'node:fs/promises';
import * as prettier from 'prettier';

const files = [
  'docs/design/DESIGN.md',
  'docs/design/components.md',
  'scripts/viewer.css',
  'tests/design-foundations.test.ts',
];

for (const file of files) {
  const original = await readFile(file, 'utf8');
  const config = (await prettier.resolveConfig(file)) ?? {};
  const formatted = await prettier.format(original, {
    ...config,
    filepath: file,
  });
  process.stdout.write(
    'CT_FORMAT_FILE ' + file + ' ' +
      Buffer.from(formatted).toString('base64') + '\n',
  );
}
