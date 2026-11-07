/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: { root: import.meta.dirname },
  serverExternalPackages: ["pg"],
  devIndicators: false,
  outputFileTracingExcludes: { "*": ["var/**", "engine/**"] },
};
export default nextConfig;
