/**
 * Hoe het CMS heet voor wie de app gebruikt.
 *
 * Vrhl-Blad-Studio is het eigen CMS van de redactie; Sanity draait eronder. Alles
 * wat een redacteur leest (de knop, meldingen, fouten) noemt Vrhl-Blad-Studio.
 * Alles wat technisch echt Sanity is, houdt die naam: `lib/sanity/`, de routes
 * onder `/api/sanity`, de variabelen `SANITY_*` en een foutcode die Sanity zelf
 * teruggeeft. Hernoem je die, dan werkt de koppeling op Vercel niet meer.
 *
 * Staat hier en nergens anders, zodat een nieuwe naam één regel is.
 */
export const STUDIO = 'Vrhl-Blad-Studio';

/** Waar een geslaagde verzending mee begint; de interface kleurt de melding daarop groen. */
export const STUDIO_GELUKT = `Naar ${STUDIO}:`;
