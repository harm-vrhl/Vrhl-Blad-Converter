import { NextResponse } from 'next/server';
import { allPrompts } from '@/lib/prompts';

export const runtime = 'nodejs';

/** Shows exactly what every run is told, straight from prompts.json. */
export async function GET() {
  try {
    return NextResponse.json(allPrompts());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
