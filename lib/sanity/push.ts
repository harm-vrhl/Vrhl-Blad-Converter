import { mutate, query, uploadImage, type Mutation } from './client';
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
import { packageFiles, type Pakket } from '../canonical';
import type { ExtractedImage } from '../types';

/**
 * De importstappen in volgorde, zoals `stappen` in canonical/sanity/mapping.json:
 * eerst de assets, dan de credits en tags opzoeken of aanmaken, dan het artikel,
 * en pas schrijven als alles klaar staat.
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
  /** De bitmaps van de job, om de bestanden bij een asset te vinden. */
  images: ExtractedImage[];
  /** Levert de inhoud van een bestand uit de job. */
  readFile: (name: string) => Promise<Uint8Array>;
  /** Niets versturen: alleen uitrekenen wat er geschreven zou worden. */
  dryRun?: boolean;
}

export async function pushPackage(pakket: Pakket, options: PushOptions): Promise<PushResult> {
  const { images, readFile, dryRun = false } = options;
  const warnings: string[] = [];
  const refs: Resolved = { assets: new Map(), credits: new Map(), tags: new Map() };
  const extra: SanityDoc[] = [];
  const created: string[] = [];

  // 1. Assets. Sanity dedupliceert zelf op inhoud, dus hetzelfde beeld twee keer
  //    sturen levert hetzelfde asset-id op.
  let uploaded = 0;
  const byId = new Map(images.map((image) => [image.id, image]));
  for (const file of packageFiles(pakket, images)) {
    const asset = (pakket.assets ?? []).find((a) => a.bestand === file.path);
    if (!asset) continue;

    if (dryRun) {
      const image = byId.get(asset.id);
      refs.assets.set(
        asset.id,
        fakeAssetRef(asset.id, image?.width ?? asset.breedte ?? 1000, image?.height ?? asset.hoogte ?? 1000,
          asset.mimeType === 'image/png' ? 'png' : 'jpg')
      );
      continue;
    }

    try {
      const data = await readFile(file.source);
      const naam = file.path.replace(/^assets\//, '');
      const result = await uploadImage(data, naam, asset.mimeType ?? 'image/jpeg');
      refs.assets.set(asset.id, result._id);
      uploaded++;
    } catch (err) {
      warnings.push(`asset '${asset.id}' kon niet worden geupload: ${message(err)}`);
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
  return err instanceof Error ? err.message : String(err);
}
