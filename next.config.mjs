import { PHASE_PRODUCTION_BUILD } from 'next/constants.js';
import { copyPdfWorker } from './scripts/copy-pdf-worker.mjs';

/** @type {(phase: string) => import('next').NextConfig} */
export default function nextConfig(phase) {
  // Hier en niet in een prebuild-script: Vercel kan `next build` ook direct
  // aanroepen, en dan draait er geen npm-script omheen. De config leest elke build.
  if (phase === PHASE_PRODUCTION_BUILD) {
    try {
      copyPdfWorker();
    } catch (err) {
      throw new Error(
        `Build gestopt: ${err instanceof Error ? err.message : String(err)}. ` +
          'Zonder public/pdf.worker.min.mjs kan de app geen PDF inlezen. Draai npm install opnieuw.'
      );
    }
  }

  return {
    // Een tweede build of dev-server naast een lopende, zonder elkaars .next te
    // overschrijven: NEXT_DIST_DIR=.next-test npm run build.
    distDir: process.env.NEXT_DIST_DIR || '.next',
    // lib/prompts.ts leest prompts.json op het moment zelf, via process.cwd(). Vercel
    // ziet dat niet als import en laat het bestand dan weg uit de functies.
    outputFileTracingIncludes: {
      '/api/**/*': ['./prompts.json']
    }
  };
}
