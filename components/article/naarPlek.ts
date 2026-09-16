"use client";

/**
 * Naar een stuk tekst in de Artikel-tab springen, en het even laten oplichten.
 *
 * Gezocht wordt op tekst en niet op een blok-id. De blokken in de Artikel-tab
 * hebben geen vast id, ze verschuiven als de redacteur sleept, en een melding kan
 * ook over de kop gaan of over iets in een kader. Tekst is wat een melding en het
 * scherm delen.
 *
 * Direct na het wisselen van tab staat het artikel er nog niet; daarom wordt er
 * een seconde lang opnieuw gekeken. Lukt het niet, dan is de tekst waarschijnlijk
 * al aangepast, en zegt de aanroeper dat.
 */
export function naarPlek(zoek: string): Promise<boolean> {
  const varianten = zoekvarianten(zoek);
  return new Promise((klaar) => {
    let poging = 0;
    const kijk = () => {
      const root = document.querySelector(".reader");
      const element = root ? vind(root, varianten) : null;
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        element.classList.remove("controle-flits");
        // Een reflow ertussen, zodat de animatie ook bij een tweede klik opnieuw start.
        void element.offsetWidth;
        element.classList.add("controle-flits");
        window.setTimeout(() => element.classList.remove("controle-flits"), 2600);
        klaar(true);
        return;
      }
      if (++poging < 20) window.setTimeout(kijk, 50);
      else klaar(false);
    };
    requestAnimationFrame(kijk);
  });
}

function vind(root: Element, varianten: string[]): HTMLElement | null {
  const kandidaten = [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, p, li, blockquote, figcaption")];
  for (const doel of varianten) {
    const raak = kandidaten.filter((el) => normaal(el.textContent ?? "").includes(doel));
    // Het kleinste element dat de tekst bevat: de alinea, niet het kader eromheen.
    raak.sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));
    if (raak[0]) return raak[0];
  }
  return null;
}

/** Eerst het hele stuk, dan korter: een melding kan net over een alineagrens lopen. */
function zoekvarianten(zoek: string): string[] {
  const heel = normaal(zoek.replace(/…/g, " "));
  const woorden = heel.split(" ").filter(Boolean);
  const uit = [heel];
  if (woorden.length > 6) uit.push(woorden.slice(0, 6).join(" "), woorden.slice(-6).join(" "));
  if (woorden.length > 3) uit.push(woorden.slice(1, 4).join(" "));
  return [...new Set(uit)].filter((v) => v.length >= 4);
}

function normaal(tekst: string): string {
  return tekst
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
