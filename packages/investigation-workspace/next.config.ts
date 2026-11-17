import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@codethread/contracts', '@codethread/code-model'],
};

export default nextConfig;
