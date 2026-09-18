import { driver, type DriveStep, type Driver, type DriverHook, type Side } from "driver.js";

const KEY = "vrhl-uitleg-gezien";

/** Wat op het werkscherm al zichtbaar is; stappen zonder anker worden overgeslagen. */
export type TourFilter = {
  omzetten: boolean;
  voortgang: boolean;
  tabs: boolean;
  artikel: boolean;
};

export type TourCtx = {
  /** Onthoudt het tabblad; na afloop zet de tour het terug. */
  bewaarWeergave?: () => void;
  herstelWeergave?: () => void;
  openSidebar?: () => void;
  /** Alleen vlak vóór de stap over het Artikel-tabblad. */
  voorArtikelStap?: () => void;
  filter?: TourFilter;
};

let actief: Driver | null = null;

export function uitlegGezien(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return true;
  }
}

export function markeerUitlegGezien(): void {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    /* onthouden is gemak, geen noodzaak */
  }
}

export function tourBezig(): boolean {
  return !!actief?.isActive();
}

export function stopTour(): void {
  actief?.destroy();
  actief = null;
}

/** Start de rondleiding die bij het huidige scherm hoort. */
export function startTour(ctx?: TourCtx): void {
  stopTour();
  const scherm = kiesScherm();
  if (scherm === "artikel") {
    ctx?.bewaarWeergave?.();
    if (ctx?.filter?.voortgang ?? true) ctx?.openSidebar?.();
  }
  const gaan = () => {
    const weinigBeweging = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const instance = driver({
      animate: !weinigBeweging,
      duration: 280,
      overlayColor: "#0a0a0a",
      overlayOpacity: 0.55,
      stagePadding: 8,
      stageRadius: 12,
      popoverOffset: 12,
      smoothScroll: false,
      allowClose: true,
      allowScroll: true,
      skipMissingElement: true,
      disableActiveInteraction: true,
      showProgress: true,
      progressText: "{{current}} van {{total}}",
      nextBtnText: "Volgende",
      prevBtnText: "Vorige",
      doneBtnText: "Klaar",
      popoverClass: "uitleg-popover",
      steps: stappen(scherm, ctx),
      onDestroyed: () => {
        ctx?.herstelWeergave?.();
        markeerUitlegGezien();
        actief = null;
      },
    });
    actief = instance;
    instance.drive();
  };
  // Zijbalk-animatie duurt 300 ms; driver moet stap 3 niet op een dicht paneel zetten.
  if (scherm === "artikel") window.setTimeout(gaan, 450);
  else gaan();
}

/** Na tab- of zijbalk-wissel even wachten, dan driver opnieuw positioneren. */
function naLayout(ms: number, werk?: () => void): DriverHook {
  return (_element, _step, { driver }) => {
    werk?.();
    window.setTimeout(() => driver.refresh(), ms);
  };
}

function kiesScherm(): "start" | "artikel" | "magazine" {
  if (inBeeld("[data-tour=magazine-sidebar]")) return "magazine";
  if (inBeeld("[data-tour=workflow]") || inBeeld("[data-tour=tabs]")) return "artikel";
  return "start";
}

/** MagazineView blijft gemonteerd achter `hidden`; die ankers tellen niet. */
function inBeeld(selector: string): boolean {
  const el = document.querySelector(selector);
  if (!el) return false;
  return !el.closest("[hidden]");
}

function stappen(scherm: "start" | "artikel" | "magazine", ctx?: TourCtx): DriveStep[] {
  if (scherm === "artikel") return aanwezig(artikelStappen(ctx));
  if (scherm === "magazine") return aanwezig(magazine);
  return aanwezig(start);
}

/** Elementstappen waarvan het anker ontbreekt, eruit; overlaystappen blijven. */
function aanwezig(bron: DriveStep[]): DriveStep[] {
  return bron.filter((stap) => {
    if (!stap.element || typeof stap.element !== "string") return true;
    if (artikelStap(stap)) return true;
    return inBeeld(stap.element);
  });
}

function artikelStap(stap: DriveStep): boolean {
  return typeof stap.element === "string" && stap.element.includes('data-tour="artikel"');
}

function overlay(title: string, description: string): DriveStep {
  return { popover: { title, description } };
}

function plek(
  id: string,
  title: string,
  description: string,
  side?: Side,
  ctx?: TourCtx,
): DriveStep {
  const step: DriveStep = {
    element: `[data-tour="${id}"]`,
    popover: { title, description, ...(side ? { side } : {}) },
  };
  if (id === "artikel") {
    step.waitForElement = 2000;
    step.onHighlightStarted = naLayout(80, () => ctx?.voorArtikelStap?.());
  }
  if (id === "workflow") {
    step.onHighlightStarted = naLayout(360, () => ctx?.openSidebar?.());
  }
  return step;
}

const start: DriveStep[] = [
  overlay(
    "Welkom",
    "Met deze app maak je van een PDF uit het blad een artikel voor Vrhl-Blad. Je krijgt de tekst en foto's netjes onder elkaar. De volgorde wordt bepaald door onze AI-workflow. Het systeem is erop afgestemd om de tekst zo accuraat mogelijk te herkennen, maar controleer de uitkomst altijd.",
  ),
  plek(
    "mode",
    "Wat voor PDF heb je?",
    "Kies <b>Eén artikel</b> als de PDF één verhaal bevat. Kies <b>Volledig magazine</b> als het een heel nummer is. De app zoekt dan eerst uit welke artikelen erin staan. Daarna kies jij welke je wilt omzetten.",
  ),
  plek(
    "dropzone",
    "Stap 1: kies een PDF",
    "Sleep het bestand naar dit vak, of klik erop om een bestand te kiezen.",
  ),
  plek(
    "blad",
    "Verder met eerder werk",
    "Heb je eerder een artikel bewaard als <b>.blad</b>-bestand? Open het hier. Je gaat dan verder waar je was, zonder alles opnieuw om te zetten.",
  ),
  plek(
    "earlier",
    "Eerder omgezet",
    "Hier staan de artikelen die je in deze browser al hebt omgezet. Let op: ze staan alleen op deze computer. Wat echt bewaard moet blijven, zet je in Vrhl-Blad-Studio.",
  ),
  overlay(
    "Stap 2: omzetten",
    "Na het kiezen van een PDF klik je op <b>Omzetten</b>. De app leest elke pagina, zet de tekst in de goede volgorde en neemt vet en cursief over. Dit duurt meestal een paar minuten.",
  ),
  overlay(
    "Stap 3: nakijken en versturen",
    "Kijk in het tabblad <b>Controle</b> wat nog aandacht nodig heeft. Fouten verbeter je in het tabblad <b>Artikel</b>. Klaar? Stuur het artikel naar Vrhl-Blad-Studio, of download het als bestand.",
  ),
  plek(
    "uitleg",
    "Deze uitleg opnieuw zien",
    "Klik op <b>Uitleg</b> als je iets kwijt bent. Je krijgt dan de uitleg die bij het scherm hoort waar je op dat moment bent.",
    "bottom",
  ),
];

function artikelStappen(ctx?: TourCtx): DriveStep[] {
  const f: TourFilter = ctx?.filter ?? {
    omzetten: true,
    voortgang: true,
    tabs: true,
    artikel: true,
  };
  const voorOmzetten = !f.voortgang && !f.artikel;

  const steps: DriveStep[] = [
    overlay(
      "Het werkscherm",
      voorOmzetten
        ? "Je PDF staat klaar. Rechtsboven klik je op <b>Omzetten</b> om te beginnen. Links in de zijbalk zie je daarna de voortgang; in het midden komen tabbladen en het artikel."
        : "Hier zet je het artikel om en kijk je het na. Links zie je hoe ver de app is. Bovenaan staan de tabbladen en de knoppen. In het midden staat het artikel zelf.",
    ),
  ];

  if (f.omzetten) {
    steps.push(
      plek(
        "omzetten",
        "Omzetten",
        "Klik hier om te beginnen. Stopt het halverwege, bijvoorbeeld door een storing? Klik dan op <b>Verder waar het stopte</b>. Wat al klaar was, hoeft niet opnieuw.",
        "bottom",
      ),
    );
  }

  if (f.voortgang) {
    steps.push(
      plek(
        "workflow",
        "Hoe ver is de app?",
        "Hier zie je stap voor stap wat de app doet. Eerst leest hij de tekst van de pagina's, dan zoekt hij de kop en de foto's, en daarna zet hij alles in de goede volgorde. De tekst verschijnt al terwijl de app bezig is.",
        "right",
        ctx,
      ),
    );
  } else {
    steps.push(
      overlay(
        "Voortgang",
        "Zodra je op <b>Omzetten</b> klikt, vult de zijbalk links zich met stappen: OCR, kop, beelden en per pagina de tekst.",
      ),
    );
  }

  if (f.tabs) {
    steps.push(
      plek(
        "tabs",
        "Vier tabbladen",
        "<b>Pagina's</b>: de originele PDF.<br><b>Artikel</b>: de tekst zoals hij online komt. Hier verbeter je fouten.<br><b>JSON</b>: de technische versie. Die heb je meestal niet nodig.<br><b>Controle</b>: een lijst met dingen om na te kijken. Het getal laat zien hoeveel er nog openstaan.",
      ),
    );
  } else {
    steps.push(
      overlay(
        "Tabbladen",
        "Tijdens en na Omzetten verschijnen hier <b>Pagina's</b>, <b>Artikel</b>, <b>JSON</b> en <b>Controle</b>.",
      ),
    );
  }

  if (f.artikel) {
    steps.push(
      plek(
        "artikel",
        "Tekst verbeteren",
        "Klik in de tekst en typ, net als in Word. Vet is ⌘B, cursief ⌘I, onderstrepen ⌘U. Een stuk tekst weghalen? Maak het helemaal leeg. Staat een stuk op de verkeerde plek? Sleep het naar de goede plek.",
        undefined,
        ctx,
      ),
      plek(
        "zoek",
        "Zoeken",
        "Typ een woord om het in het artikel te vinden. Met ⌘F kom je hier ook. Druk op Enter om naar de volgende plek te gaan waar het woord staat.",
        "bottom",
      ),
      plek(
        "export",
        "Downloaden",
        "Download het artikel als bestand, bijvoorbeeld als Word of PDF. Kies <b>Blad</b> om je werk te bewaren. Dat bestand kun je later weer openen om verder te gaan.",
        "bottom",
      ),
      plek(
        "studio",
        "Naar Vrhl-Blad-Studio",
        "Als het artikel klaar is, klik je hier. Het komt dan als concept in Vrhl-Blad-Studio. Het staat nog niet online. Staat er in <b>Controle</b> nog iets open? Dan vraagt de app eerst of je dat wilt nakijken.",
        "bottom",
      ),
    );
  } else {
    steps.push(
      overlay(
        "Nakijken en versturen",
        "Is Omzetten klaar? Verbeter tekst in <b>Artikel</b>, loop <b>Controle</b> na, en download of stuur het artikel naar Vrhl-Blad-Studio.",
      ),
    );
  }

  steps.push(
    plek(
      "uitleg",
      "Deze uitleg opnieuw zien",
      "Klik op <b>Uitleg</b> als je iets kwijt bent. Je krijgt dan de uitleg die bij het scherm hoort waar je op dat moment bent.",
      "bottom",
    ),
  );

  return steps;
}

const magazine: DriveStep[] = [
  overlay(
    "Een heel magazine",
    "Een magazine bevat veel artikelen. Daarom gaat het in twee stappen. Eerst zoekt de app uit welke artikelen erin staan en op welke pagina's. Daarna kies jij welke artikelen je wilt omzetten.",
  ),
  plek(
    "magazine-sidebar",
    "Wat de app doet",
    "Hier zie je hoe ver de app is. Hij bekijkt elke pagina en zoekt uit welke pagina's bij elkaar horen. De inhoudsopgave van het blad helpt daarbij. Twijfelt de app? Dan kijkt hij nog een keer extra.",
    "right",
  ),
  plek(
    "magazine-actie",
    "Eerst analyseren, dan omzetten",
    "Klik eerst op <b>Analyseren</b>. De app maakt dan een lijst met alle artikelen. Vink daarna de artikelen aan die je wilt hebben en klik op <b>Omzetten</b>. Je kunt op dit scherm blijven terwijl de app bezig is.",
    "bottom",
  ),
  plek(
    "magazine-lijst",
    "De lijst met artikelen",
    "Elke regel is één artikel, met de pagina's waarop het staat. Staan er twee artikelen op één pagina? Dan gaat die hele pagina bij allebei mee. Is een artikel omgezet, dan open je het hier om het na te kijken.",
  ),
  overlay(
    "Daarna: elk artikel apart",
    "Elk artikel dat je kiest, wordt omgezet alsof het een losse PDF is. Je kijkt het daarna na op dezelfde manier: in <b>Controle</b> en <b>Artikel</b>, en dan stuur je het naar Vrhl-Blad-Studio.",
  ),
  plek(
    "uitleg",
    "Deze uitleg opnieuw zien",
    "Klik op <b>Uitleg</b> als je iets kwijt bent. Je krijgt dan de uitleg die bij het scherm hoort waar je op dat moment bent.",
    "bottom",
  ),
];
