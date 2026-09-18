/**
 * Het logboek: welke taken gebruikers uitvoeren, zonder artikeltekst, PDF of
 * wachtwoorden. Rekenen, geen I/O; de server bewaart, de interface tekent.
 *
 * Twee lagen:
 *   taak   wat iemand deed (artikel omzetten, magazine analyseren, inloggen)
 *   stap   wat de server daarvoor aanriep (OCR, leesvolgorde, paginascan)
 *
 * Een taak heeft een `task`-id; stappen van dezelfde run dragen hetzelfde id,
 * zodat het logboek ze onder die taak kan zetten. Parallelle runs in één tabblad
 * (drie artikelen uit een magazine) hebben elk hun eigen id.
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
}

export interface TaakRij {
  task: string;
  taak: string;
  titel: string;
  naam?: string;
  status: ActivityStatus;
  at: string;
  ms?: number;
  pages?: number;
  usage?: ActivityUsage;
  error?: string;
  formaat?: string;
  stappen: ActivityEvent[];
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

/** Eén regel die in het logboek bovenaan een gebeurtenis staat. */
export function titelVan(event: Pick<ActivityEvent, 'kind' | 'taak' | 'titel' | 'formaat' | 'route' | 'page' | 'status'>): string {
  if (event.kind === 'stap') {
    const waar = event.page != null ? `${routeLabel(event.route)} p. ${event.page}` : routeLabel(event.route);
    return waar;
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
 * Taken met hun stappen eronder. Een start en een ok/fail met hetzelfde
 * `task`-id worden één rij; stappen zonder taak blijven los.
 */
export function groepTaken(events: ActivityEvent[]): { taken: TaakRij[]; los: ActivityEvent[] } {
  const byTask = new Map<string, ActivityEvent[]>();
  const los: ActivityEvent[] = [];
  for (const event of events) {
    if (!event.task) {
      los.push(event);
      continue;
    }
    const list = byTask.get(event.task);
    if (list) list.push(event);
    else byTask.set(event.task, [event]);
  }

  const taken: TaakRij[] = [];
  for (const [task, list] of byTask) {
    const taakEvents = list.filter((e) => e.kind === 'taak');
    const stappen = list
      .filter((e) => e.kind === 'stap')
      .sort((a, b) => a.at.localeCompare(b.at));
    if (!taakEvents.length) {
      los.push(...list);
      continue;
    }
    const ordered = [...taakEvents].sort((a, b) => a.at.localeCompare(b.at));
    const first = ordered[0];
    const last = [...ordered].reverse().find((e) => e.status !== 'start') ?? ordered[ordered.length - 1];
    taken.push({
      task,
      taak: last.taak ?? first.taak ?? 'taak',
      titel: titelVan(last.titel ? last : first),
      naam: last.naam ?? first.naam,
      status: last.status,
      at: first.at,
      ms: last.ms ?? (last.at !== first.at ? Date.parse(last.at) - Date.parse(first.at) : undefined),
      pages: last.pages ?? first.pages,
      usage: last.usage ?? first.usage,
      error: last.error,
      formaat: last.formaat ?? first.formaat,
      stappen
    });
  }

  taken.sort((a, b) => b.at.localeCompare(a.at));
  los.sort((a, b) => b.at.localeCompare(a.at));
  return { taken, los };
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
