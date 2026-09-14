function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}


/** A price may legitimately be set to zero, so it cannot use num(). */
function price(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Which model writes the article. Mistral always reads the page; this is the rest. */
export type Provider = 'openai' | 'mistral';
export const PROVIDERS: Provider[] = ['openai', 'mistral'];

export const env = {
  /** The provider a run uses unless the interface asks for the other one. */
  get provider(): Provider {
    return str('AI_PROVIDER', 'openai') === 'mistral' ? 'mistral' : 'openai';
  },
  get mistralKey() {
    return str('MISTRAL_API_KEY', '');
  },
  get openaiKey() {
    return str('OPENAI_API_KEY', '');
  },
  get ocrModel() {
    return str('MISTRAL_OCR_MODEL', 'mistral-ocr-latest');
  },
  get model() {
    return str('OPENAI_MODEL', 'gpt-5.6-terra');
  },
  /**
   * Mistral Medium 3.5, pinned by version rather than by `-latest` so a run can be
   * repeated. Vision, structured outputs and reasoning in one model; on this key
   * it is the newest general model Mistral offers (Large 3 is not on it).
   */
  get mistralModel() {
    return str('MISTRAL_MODEL', 'mistral-medium-2604');
  },
  /** Reasoning budget per run. 'medium' is the working default for this pipeline. */
  get reasoningEffort() {
    return str('OPENAI_REASONING_EFFORT', 'medium');
  },
  get apiStyle() {
    return str('OPENAI_API_STYLE', 'responses') === 'chat' ? ('chat' as const) : ('responses' as const);
  },
  get mistralBase() {
    return str('MISTRAL_BASE_URL', 'https://api.mistral.ai/v1').replace(/\/$/, '');
  },
  get openaiBase() {
    return str('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, '');
  },
  /**
   * How many requests per minute to assume for a Mistral model until its first
   * answer says. After that the limit on the response headers is what counts;
   * this only paces the very first calls of a run.
   */
  get mistralReqPerMinute() {
    return num('MISTRAL_REQ_PER_MINUTE', 60);
  },
  get concurrency() {
    return num('MAX_CONCURRENCY', 4);
  },
  get confidenceThreshold() {
    return num('CONFIDENCE_THRESHOLD', 0.7);
  },
  /**
   * The list prices, per million tokens. gpt-5.6-terra is $2 in and $12 out; a
   * cached input read is $0.10, which is not counted here because the ledger does
   * not know which reads were cached, so the model half of a bill is a ceiling
   * rather than an estimate.
   *
   * Override both when OPENAI_MODEL names something else, or to bill in another
   * currency - PRICE_CURRENCY is only the label on the total.
   */
  get aiPriceInput() {
    return price('OPENAI_PRICE_INPUT', 2);
  },
  get aiPriceOutput() {
    return price('OPENAI_PRICE_OUTPUT', 12);
  },
  /** Mistral Medium 3.5: $1.50 in and $7.50 out per million tokens (docs.mistral.ai, 2026-09-10). */
  get mistralPriceInput() {
    return price('MISTRAL_PRICE_INPUT', 1.5);
  },
  get mistralPriceOutput() {
    return price('MISTRAL_PRICE_OUTPUT', 7.5);
  },
  /**
   * Mistral bills OCR at $4 per 1000 pages, and a page is a page whether it is a
   * whole spread or one cropped paragraph - which is what makes reading a page
   * block by block cost what it costs.
   */
  get ocrPricePerPage() {
    return price('MISTRAL_PRICE_PER_PAGE', 0.004);
  },
  /** What to call the numbers. They are the providers' own, so dollars. */
  get priceCurrency() {
    return str('PRICE_CURRENCY', 'USD');
  },
  get dataDir() {
    return str('DATA_DIR', '.data');
  }
};

/** The model and the list price a provider bills at, per million tokens. */
export function modelFor(provider: Provider): { model: string; input: number; output: number } {
  return provider === 'mistral'
    ? { model: env.mistralModel, input: env.mistralPriceInput, output: env.mistralPriceOutput }
    : { model: env.model, input: env.aiPriceInput, output: env.aiPriceOutput };
}

/**
 * The keys a run needs. Mistral reads every page, so its key is always needed;
 * the OpenAI key only when OpenAI is the one writing.
 */
export function missingKeys(provider: Provider = env.provider): string[] {
  const missing: string[] = [];
  if (!env.mistralKey) missing.push('MISTRAL_API_KEY');
  if (provider === 'openai' && !env.openaiKey) missing.push('OPENAI_API_KEY');
  return missing;
}
