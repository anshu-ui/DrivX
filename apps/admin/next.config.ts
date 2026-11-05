import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The operations console uses Firebase directly from client components, so
  // it can be hosted beside the two Expo web exports on Firebase Hosting.
  output: 'export',
  trailingSlash: true,
  basePath: '/admin',
  /* config options here */
  cacheComponents: false,
  partialPrefetching: false,
  // Shared packages are published as TypeScript source so mobile and web never
  // build against a stale bundle.
  transpilePackages: ['@drivx/design-tokens', '@drivx/domain', '@drivx/firebase-client'],
};

export default nextConfig;
