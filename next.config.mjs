/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.GOOSE_NEXT_DIST_DIR || ".next",
  turbopack: { root: import.meta.dirname },
  serverExternalPackages: ["pg"],
  devIndicators: false,
  outputFileTracingExcludes: { "*": ["var/**", "engine/**"] },
};
export default nextConfig;
