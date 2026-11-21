import type { NextConfig } from 'next';

const testDistDir = process.env.CODETHREAD_WORKSPACE_TEST_DIST_DIR;
const testDistMatch = testDistDir
  ? /^\.next\/workspace-test-(\d+)$/.exec(testDistDir)
  : undefined;
if (testDistDir && !testDistMatch)
  throw new Error('Invalid Investigation Workspace test output directory.');

const nextConfig: NextConfig = {
  ...(testDistMatch
    ? {
        distDir: testDistDir,
        typescript: {
          tsconfigPath: `tsconfig.workspace-test-${testDistMatch[1]}.json`,
        },
      }
    : {}),
  poweredByHeader: false,
  images: { unoptimized: true },
  reactStrictMode: true,
  transpilePackages: ['@codethread/contracts', '@codethread/code-model'],
};

export default nextConfig;
