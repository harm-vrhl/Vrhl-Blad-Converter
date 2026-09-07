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

export const env = {
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

export function missingKeys(): string[] {
  const missing: string[] = [];
  if (!env.mistralKey) missing.push('MISTRAL_API_KEY');
  if (!env.openaiKey) missing.push('OPENAI_API_KEY');
  return missing;
}
