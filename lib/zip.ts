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
