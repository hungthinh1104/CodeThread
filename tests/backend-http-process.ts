import {
  installRuntimeSignals,
  startBackend,
} from '../scripts/backend/runtime.ts';

const url = process.env.CODETHREAD_DATABASE_URL,
  root = process.env.CODETHREAD_ALLOWED_REPO_ROOT,
  analyzerBuildHash = process.env.CODETHREAD_ANALYZER_BUILD_HASH,
  secret = process.env.CODETHREAD_API_TOKEN,
  port = Number(process.env.CODETHREAD_TEST_API_PORT);
if (!url || !root || !analyzerBuildHash || !secret || !Number.isInteger(port))
  throw new Error('HTTP worker process test configuration is incomplete');

const runtime = await startBackend({
  url,
  root,
  analyzerBuildHash,
  secret,
  port,
});
installRuntimeSignals(runtime);
process.send?.('ready');
process.on('message', (message) => {
  if (message === 'crash') {
    if (process.send) process.send('crash-received', () => process.exit(86));
    else process.exit(86);
  }
  if (message === 'stop')
    void runtime.shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
});
