import { serviceConfig } from './config.ts';
import { installRuntimeSignals, startBackend } from './runtime.ts';

const config = serviceConfig();
try {
  const runtime = await startBackend(config);
  installRuntimeSignals(runtime);
  console.log(
    'CodeThread persistent API listening on 127.0.0.1:' + config.port,
  );
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
