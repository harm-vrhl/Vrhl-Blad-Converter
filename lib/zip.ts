/**
 * Een ZIP schrijven, zonder dependency.
 *
 * Het pakket moet als een geheel te vervoeren zijn: canonical/validate.mjs
 * controleert met `--bestanden` of het beeld naast het JSON staat, en dat kan
 * alleen als ze samen aankomen. Een archiver erbij halen voor dit ene doel is
 * meer dan het waard is; dit is het formaat zoals het in de spec staat, met
 * alleen de methode die we nodig hebben.
 *
 * Alles wordt opgeslagen zonder compressie. Het pakket wordt in de browser
 * ingepakt, waar geen zlib is, en het levert ook niets op: het beeld is al JPEG
 * of PNG en `pakket.json` is een paar tientallen kilobytes.
 *
 * Bewust weggelaten: compressie, zip64, encryptie en mappen als eigen entry. Een
 * pakket uit een artikel blijft ruim onder de 4 GB en mappen ontstaan vanzelf uit
 * de paden.
 */

export interface ZipEntry {
  /** Het pad in het archief, met forward slashes en zonder leidende slash. */
  path: string;
  data: Uint8Array;
}

const CRC = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export function zip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.path);
    const method = 0; // opgeslagen, niet gecomprimeerd
    const body = entry.data;
    const sum = crc32(entry.data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // versie die nodig is om uit te pakken
    lv.setUint16(6, 0x0800, true); // bit 11: de bestandsnaam is UTF-8
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, sum, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // gemaakt door
    cv.setUint16(6, 20, true); // nodig om uit te pakken
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, sum, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const directory = centrals.reduce((n, part) => n + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directory, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, end];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

interface PackedEntry {
  path: string;
  method: number;
  data: Uint8Array;
  uncompressed: number;
}

/**
 * Een ZIP lezen. Onze eigen pakketten staan ongecomprimeerd (methode 0); een
 * ZIP die Finder of een andere archiver opnieuw heeft ingepakt gebruikt meestal
 * deflate (methode 8). Andere methodes, encryptie en zip64 worden geweigerd:
 * een artikel-pakket past daar nooit in.
 */
export async function unzip(data: Uint8Array): Promise<ZipEntry[]> {
  const packed = zipEntries(data);
  const out: ZipEntry[] = [];
  for (const entry of packed) {
    const raw =
      entry.method === 0 ? entry.data : entry.method === 8 ? await inflateRaw(entry.data) : null;
    if (!raw) {
      throw new Error(
        `ZIP-compressie ${entry.method} wordt niet ondersteund. Gebruik het ZIP-bestand uit Exporteren, Pakket.`
      );
    }
    if (entry.uncompressed && raw.length !== entry.uncompressed) {
      throw new Error(`het bestand ${entry.path} is beschadigd`);
    }
    out.push({ path: entry.path, data: raw });
  }
  return out;
}

/**
 * Alleen ongecomprimeerde entries, synchroon. Dat is wat `zip()` schrijft, en
 * wat `npm run golden` narekent zonder een async inflate.
 */
export function unzipStored(data: Uint8Array): ZipEntry[] {
  return zipEntries(data).map((entry) => {
    if (entry.method !== 0) {
      throw new Error(`ZIP-compressie ${entry.method} wordt niet ondersteund`);
    }
    return { path: entry.path, data: entry.data };
  });
}

function zipEntries(data: Uint8Array): PackedEntry[] {
  if (data.length < 22) throw new Error('dit is geen ZIP-bestand');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eocd = findEocd(view, data.length);
  const disk = u16(view, eocd + 4);
  const here = u16(view, eocd + 8);
  const entries = u16(view, eocd + 10);
  const cdSize = u32(view, eocd + 12);
  const cdOffset = u32(view, eocd + 16);
  if (disk !== 0 || here !== entries) {
    throw new Error('een ZIP over meerdere schijven wordt niet ondersteund');
  }
  if (cdOffset === 0xffffffff || entries === 0xffff) {
    throw new Error('dit ZIP-bestand is te groot (zip64)');
  }
  if (cdOffset + cdSize > data.length) throw new Error('dit ZIP-bestand is beschadigd');

  const out: PackedEntry[] = [];
  let at = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (at + 46 > data.length || u32(view, at) !== CENTRAL) {
      throw new Error('dit ZIP-bestand is beschadigd');
    }
    const flags = u16(view, at + 8);
    const method = u16(view, at + 10);
    const compressed = u32(view, at + 20);
    const uncompressed = u32(view, at + 24);
    const nameLen = u16(view, at + 28);
    const extraLen = u16(view, at + 30);
    const commentLen = u16(view, at + 32);
    const localOff = u32(view, at + 42);
    const nameBytes = data.subarray(at + 46, at + 46 + nameLen);
    const path = decodeName(nameBytes).replace(/\\/g, '/').replace(/^\//, '');
    at += 46 + nameLen + extraLen + commentLen;

    if (!path || path.endsWith('/')) continue;
    if (path.startsWith('__MACOSX/') || /(^|\/)\._/.test(path) || path.endsWith('.DS_Store')) continue;
    if (flags & 0x0001) throw new Error('dit ZIP-bestand is versleuteld');

    if (localOff + 30 > data.length || u32(view, localOff) !== LOCAL) {
      throw new Error(`het bestand ${path} kon niet uit de ZIP worden gelezen`);
    }
    const localName = u16(view, localOff + 26);
    const localExtra = u16(view, localOff + 28);
    const dataAt = localOff + 30 + localName + localExtra;
    if (dataAt + compressed > data.length) {
      throw new Error(`het bestand ${path} kon niet uit de ZIP worden gelezen`);
    }

    out.push({
      path,
      method,
      data: data.subarray(dataAt, dataAt + compressed),
      uncompressed
    });
  }
  return out;
}

function findEocd(view: DataView, length: number): number {
  const min = Math.max(0, length - 22 - 65535);
  for (let i = length - 22; i >= min; i--) {
    if (u32(view, i) !== EOCD) continue;
    const comment = u16(view, i + 20);
    if (i + 22 + comment === length) return i;
  }
  throw new Error('dit is geen ZIP-bestand (of het is beschadigd)');
}

function decodeName(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function u16(view: DataView, at: number): number {
  return view.getUint16(at, true);
}

function u32(view: DataView, at: number): number {
  return view.getUint32(at, true);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('deze browser kan een gecomprimeerde ZIP niet uitpakken');
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
