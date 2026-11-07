import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runInvestigationCli } from './investigation/cli.ts';

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  void runInvestigationCli();
