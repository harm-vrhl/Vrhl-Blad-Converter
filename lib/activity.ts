/**
 * Wat er in de serverlog over een taak mag staan: wie, wat, hoe lang, wat het
 * kostte. Geen artikeltekst, geen PDF, geen wachtwoorden. Rekenen, geen I/O
 * (staat in npm run golden); de server schrijft de regel, de browser meldt
 * alleen het begin en einde van een taak.
 *
 * Twee lagen:
 *   taak   wat iemand deed (artikel omzetten, magazine analyseren, inloggen)
 *   stap   wat de server daarvoor aanriep (OCR, leesvolgorde, paginascan)
 *
 * Een taak heeft een `task`-id; stappen van dezelfde run dragen hetzelfde id.
 * Parallelle runs in één tabblad (drie artikelen uit een magazine) hebben elk
 * hun eigen id.
 */

export type ActivityKind = 'taak' | 'stap';

export type ActivityStatus = 'start' | 'ok' | 'fail';

export type Taak =
  | 'artikel.omzetten'
  | 'magazine.analyseren'
  | 'export'
  | 'studio.versturen'
  | 'blad.importeren'
  | 'inlog';

export interface ActivityUsage {
  calls?: number;
  tokens?: number;
  cost?: number;
  currency?: string;
}

export interface ActivityEvent {
  id: string;
  at: string;
  kind: ActivityKind;
  status: ActivityStatus;
  taak?: Taak | string;
  /** Groepeert de stappen van één run. */
  task?: string;
  naam?: string;
  clientId?: string;
  /** Bestandsnaam, of een korte omschrijving. */
  titel?: string;
  pages?: number;
  job?: string;
  route?: string;
  page?: number;
  ms?: number;
  usage?: ActivityUsage;
  error?: string;
  /** Alleen bij export: json, html, mdx, docx, pdf, blad. */
  formaat?: string;
}

/** Wat de browser meestuurt bij een verzoek, los van de invoer van de agent. */
export interface ActivityStamp {
  clientId?: string;
  naam?: string;
  task?: string;
  taak?: Taak | string;
}

const TAAK_TITEL: Record<string, string> = {
  'artikel.omzetten': 'Artikel omzetten',
  'magazine.analyseren': 'Magazine analyseren',
  export: 'Export',
  'studio.versturen': 'Naar Vrhl-Blad-Studio',
  'blad.importeren': 'Blad geopend',
  inlog: 'Inloggen'
};

const ROUTE_LABEL: Record<string, string> = {
  '/api/run/check': 'Sleutels',
  '/api/run/ocr': 'OCR',
  '/api/run/frontmatter': 'Frontmatter',
  '/api/run/images': 'Beeldbeoordeling',
  '/api/run/page': 'Leesvolgorde',
  '/api/run/styling': 'Opmaak',
  '/api/magazine/scan': 'Paginascan',
  '/api/magazine/boundary': 'Grenscontrole',
  '/api/magazine/content': 'Inhoudscontrole',
  '/api/sanity/asset': 'Beeld naar studio',
  '/api/sanity/push': 'Pakket naar studio'
};

const EXPORT_LABEL: Record<string, string> = {
  json: 'JSON',
  html: 'HTML',
  mdx: 'MDX',
  docx: 'Word',
  pdf: 'PDF',
  blad: '.blad'
};

export function taakLabel(taak: string | undefined): string {
  if (!taak) return 'Taak';
  return TAAK_TITEL[taak] ?? taak;
}

export function routeLabel(route: string | undefined): string {
  if (!route) return 'Stap';
  return ROUTE_LABEL[route] ?? route.replace(/^\/api\//, '');
}

export function exportLabel(formaat: string | undefined): string {
  if (!formaat) return 'bestand';
  return EXPORT_LABEL[formaat] ?? formaat;
}

/** Korte kop: wat er gebeurde, zonder wie of hoe lang. */
export function titelVan(event: Pick<ActivityEvent, 'kind' | 'taak' | 'titel' | 'formaat' | 'route' | 'page' | 'status'>): string {
  if (event.kind === 'stap') {
    return event.page != null ? `${routeLabel(event.route)} p. ${event.page}` : routeLabel(event.route);
  }
  if (event.taak === 'inlog') return event.status === 'ok' ? 'Ingelogd' : 'Inloggen mislukt';
  if (event.taak === 'export') {
    const wat = `Export ${exportLabel(event.formaat)}`;
    return event.titel ? `${wat}: ${event.titel}` : wat;
  }
  const kop = taakLabel(event.taak);
  return event.titel ? `${kop}: ${event.titel}` : kop;
}

/**
 * Eén regel voor de Runtime Logs van Vercel. Bewust kort en vast van vorm,
 * zodat je in het dashboard filtert op `src:vrhl` en de `msg` scant.
 */
export function regelVan(event: ActivityEvent): string {
  const status = event.status === 'start' ? 'bezig' : event.status === 'ok' ? 'ok' : 'mislukt';
  const wie = event.naam || event.clientId || 'anoniem';
  const parts = [status, titelVan(event), wie];
  if (event.kind === 'taak' && event.pages != null) {
    parts.push(event.pages === 1 ? '1 pagina' : `${event.pages} pagina's`);
  }
  if (event.ms != null && event.status !== 'start') parts.push(duur(event.ms));
  if (event.usage?.tokens != null) parts.push(`${Math.round(event.usage.tokens)} tok`);
  if (event.usage?.cost != null) parts.push(bedrag(event.usage.cost, event.usage.currency));
  if (event.error) parts.push(event.error);
  return parts.join(' · ');
}

/** Alleen cijfers die een rekening of duur mogen zijn; geen tekst uit het artikel. */
export function usageOf(value: unknown): ActivityUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const inner = raw.usage && typeof raw.usage === 'object' ? (raw.usage as Record<string, unknown>) : raw;
  const calls = num(inner.calls);
  const tokens = num(inner.tokens);
  const cost = num(inner.cost) ?? num(inner.ai);
  const currency = typeof inner.currency === 'string' ? inner.currency.slice(0, 8) : undefined;
  if (calls == null && tokens == null && cost == null) return undefined;
  return { calls, tokens, cost, currency };
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function duur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const min = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${min} min ${rest} s` : `${min} min`;
}

function bedrag(cost: number, currency?: string): string {
  const n = cost.toFixed(2);
  return currency && currency !== 'USD' ? `${n} ${currency}` : `$${n}`;
}
