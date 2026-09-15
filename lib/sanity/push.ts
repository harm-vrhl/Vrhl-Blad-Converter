import { mutate, query, type Mutation } from './client';
import {
  creditDocument,
  creditKey,
  fakeAssetRef,
  tagDocument,
  tagKey,
  toSanityDocuments,
  type Resolved,
  type SanityDoc
} from './documents';
import type { Pakket } from '../canonical';
import type { ExtractedImage } from '../types';
import { errorMessage } from '../util';

/**
 * De importstappen in volgorde, zoals `stappen` in canonical/sanity/mapping.json:
 * eerst de assets, dan de credits en tags opzoeken of aanmaken, dan het artikel,
 * en pas schrijven als alles klaar staat.
 *
 * Het uploaden van de assets zelf gebeurt ervoor, één beeld per verzoek
 * (`/api/sanity/asset`): een artikel met zes foto's is samen al snel meer dan de
 * 4,5 MB die één verzoek aan de server mag zijn. Hier komen alleen de id's aan
 * die Sanity daarbij teruggaf.
 */

const ROLES: Record<string, string> = {
  auteurs: 'auteur',
  fotografen: 'fotograaf',
  illustratoren: 'illustrator'
};

export interface PushResult {
  documents: SanityDoc[];
  created: string[];
  uploaded: number;
  warnings: string[];
  dryRun: boolean;
}

export interface PushOptions {
  /** De bitmaps van de job: breedte en hoogte voor een droogloop. */
  images: ExtractedImage[];
  /** Per asset-id van het pakket het `_id` dat Sanity bij het uploaden gaf. */
  assetIds: Record<string, string>;
  /** Niets versturen: alleen uitrekenen wat er geschreven zou worden. */
  dryRun?: boolean;
}

export async function pushPackage(pakket: Pakket, options: PushOptions): Promise<PushResult> {
  const { images, assetIds, dryRun = false } = options;
  const warnings: string[] = [];
  const refs: Resolved = { assets: new Map(), credits: new Map(), tags: new Map() };
  const extra: SanityDoc[] = [];
  const created: string[] = [];

  // 1. Assets, al geupload. Sanity dedupliceert zelf op inhoud, dus hetzelfde
  //    beeld twee keer sturen levert hetzelfde asset-id op.
  let uploaded = 0;
  const byId = new Map(images.map((image) => [image.id, image]));
  for (const asset of pakket.assets ?? []) {
    if (!asset.bestand) continue;

    if (dryRun) {
      const image = byId.get(asset.id);
      refs.assets.set(
        asset.id,
        fakeAssetRef(asset.id, image?.width ?? asset.breedte ?? 1000, image?.height ?? asset.hoogte ?? 1000,
          asset.mimeType === 'image/png' ? 'png' : 'jpg')
      );
      continue;
    }

    const id = assetIds[asset.id];
    if (id) {
      refs.assets.set(asset.id, id);
      uploaded++;
    } else {
      warnings.push(`asset '${asset.id}' is niet geupload`);
    }
  }

  // 2. Credits en tags: opzoeken op naam, aanmaken als ze er nog niet zijn.
  for (const artikel of pakket.artikelen ?? []) {
    for (const [veld, type] of Object.entries(ROLES)) {
      const namen = (artikel.credits as Record<string, string[] | undefined> | undefined)?.[veld] ?? [];
      for (const naam of namen) {
        const key = creditKey(type, naam);
        if (refs.credits.has(key)) continue;
        const id = dryRun ? null : await findCredit(type, naam);
        if (id) {
          refs.credits.set(key, id);
        } else {
          const doc = creditDocument(type, naam);
          refs.credits.set(key, doc._id);
          extra.push(doc);
          created.push(`${type}: ${naam}`);
        }
      }
    }
    for (const naam of artikel.tags ?? []) {
      const key = tagKey(naam);
      if (refs.tags.has(key)) continue;
      const eigen = (pakket.tags ?? []).find((t) => tagKey(t.naam) === key);
      const id = dryRun ? null : await findTag(naam, eigen?.slug);
      if (id) {
        refs.tags.set(key, id);
      } else {
        const doc = tagDocument(naam, eigen?.slug);
        refs.tags.set(key, doc._id);
        extra.push(doc);
        created.push(`tag: ${naam}`);
      }
    }
  }

  // 3. Het artikel zelf.
  const built = toSanityDocuments(pakket, refs);
  warnings.push(...built.warnings);
  const documents = [...extra, ...built.documents];

  if (dryRun) return { documents, created, uploaded: refs.assets.size, warnings, dryRun: true };

  // 4. Schrijven. De referentiedocumenten met createIfNotExists, zodat een naam
  //    die er al staat niet wordt overschreven; het artikel met createOrReplace,
  //    want dat is juist wat een herimport hoort te doen.
  const mutations: Mutation[] = [
    ...extra.map((doc) => ({ createIfNotExists: doc as unknown as Record<string, unknown> })),
    ...built.documents.map((doc) => ({ createOrReplace: doc as unknown as Record<string, unknown> }))
  ];
  await mutate(mutations);

  return { documents, created, uploaded, warnings, dryRun: false };
}

async function findCredit(type: string, naam: string): Promise<string | null> {
  // Niet op diakrieten normaliseren: 'Jose' en 'Jose' met accent zijn twee mensen.
  const id = await query<string | null>(`*[_type == $type && lower(naam) == lower($naam)][0]._id`, { type, naam });
  return id ?? null;
}

async function findTag(naam: string, slug?: string): Promise<string | null> {
  const id = await query<string | null>(
    `*[_type == "tag" && (lower(tagName) == lower($naam) || slug.current == $slug)][0]._id`,
    { naam, slug: slug ?? '' }
  );
  return id ?? null;
}

function message(err: unknown): string {
  return errorMessage(err);
}
