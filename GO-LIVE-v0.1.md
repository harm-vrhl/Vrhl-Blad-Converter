# v0.1 live zetten

Checklist voor wie de app op Vercel zet en voor de redactie die hem gebruikt.

## Vercel (beheerder)

1. **Plan:** Pro met **Fluid Compute** aan. Zware routes (`page`, `frontmatter`,
   `styling`, `images`, magazine `boundary`/`content`) mogen tot **800 seconden**
   duren; zonder Pro/Fluid stoppen ze eerder.
2. **Omgevingsvariabelen:** alles uit [`.env.example`](.env.example) dat je nodig
   hebt, minimaal:
   - `MISTRAL_API_KEY`, `OPENAI_API_KEY`
   - `APP_PASSWORD` (nooit leeg op productie: anders is de app open en betaalt
     iedereen jullie tokens)
   - `AUTH_SECRET` (bijv. `openssl rand -hex 32`)
   - Optioneel voor Vrhl-Blad-Studio: `NEXT_PUBLIC_SANITY_PROJECT_ID`,
     `NEXT_PUBLIC_SANITY_DATASET`, `SANITY_API_TOKEN`
3. **Firewall:** in het Vercel-dashboard **Firewall > Configure > New Rule**:
   - If `@vercel/firewall`
   - Rate limit ID **`inloggen`**
   - Fixed window **10 minuten**, **10** verzoeken, sleutel **IP**
   - Then **Default (429)**
   - **Review Changes > Publish**

   Zonder deze regel remt elke server alleen lokaal; wachtwoord raden is dan
   zwakker beschermd.

4. **Deploy:** na `npm run build` lokaal groen, deploy de branch. `prompts.json`
   gaat mee via `outputFileTracingIncludes` in `next.config.mjs`.

## Redactie (korte briefing)

- **Inloggen:** één gedeeld wachtwoord voor iedereen. Geen accounts; wie het
  wachtwoord heeft, kan omzetten op jullie kosten.
- **Waar staat mijn werk:** in **deze browser** (IndexedDB). Andere computer of
  profiel = leeg. **Backup:** exporteer **Blad** (`.blad`) of stuur naar
  Vrhl-Blad-Studio als concept.
- **Controle:** kijk het tabblad *Controle* na vóór je verstuurt. Open punten
  vragen om bevestiging bij Studio-push.
- **Studio:** alles gaat als **concept**; er staat niets meteen live.
- **Magazine:** twee artikelen op dezelfde pagina? De hele pagina gaat mee bij
  beide; dat is bekend gedrag in v0.1.

## Na een deploy

- Test inloggen en één korte PDF (artikelmodus).
- Controleer dat een mislukte login na tien pogingen wordt afgeremd (429).
