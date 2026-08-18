/**
 * Next.js configuration.
 *
 * Phase 0a: no feature configuration. The only thing worth noting is that we do
 * NOT use the `env` key to forward secrets into the bundle — every variable is
 * read through `src/lib/env.ts` (server) or `src/lib/env.client.ts` (browser).
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    // Never ship a build that does not typecheck.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
