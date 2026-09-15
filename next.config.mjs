/** @type {import('next').NextConfig} */
const nextConfig = {
  // Een tweede build of dev-server naast een lopende, zonder elkaars .next te
  // overschrijven: NEXT_DIST_DIR=.next-test npm run build.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // lib/prompts.ts leest prompts.json op het moment zelf, via process.cwd(). Vercel
  // ziet dat niet als import en laat het bestand dan weg uit de functies.
  outputFileTracingIncludes: {
    '/api/**/*': ['./prompts.json']
  }
};

export default nextConfig;
