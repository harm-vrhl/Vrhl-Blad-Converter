import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_COOKIE, authEnabled, validToken } from '@/lib/auth';

/**
 * Het slot op de deur. Een pagina zonder geldige cookie gaat naar /login; een
 * API-route antwoordt met 401, want die wordt door code aangeroepen en niet door
 * iemand die een formulier kan invullen.
 */
export async function middleware(request: NextRequest) {
  if (!authEnabled()) return NextResponse.next();
  if (await validToken(request.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'niet ingelogd' }, { status: 401 });
  }
  const login = new URL('/login', request.url);
  if (pathname !== '/') login.searchParams.set('terug', `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // Alles behalve de loginpagina zelf, het inloggen, en wat Next en pdf.js aan
  // statische bestanden serveren.
  matcher: ['/((?!login|api/login|_next/static|_next/image|favicon.ico|icon.svg|pdf.worker.min.mjs).*)']
};
