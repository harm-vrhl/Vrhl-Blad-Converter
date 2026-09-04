function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
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
