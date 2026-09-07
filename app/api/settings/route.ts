import { env } from '@/lib/env';

export const runtime = 'nodejs';

/**
 * What the interface needs to know about how this installation is set up: which
 * way the switches stand by default, and what the optional work costs. The keys
 * themselves never leave the server.
 */
export async function GET() {
  return Response.json({
    ocrPricePerPage: env.ocrPricePerPage,
    currency: env.priceCurrency
  });
}
