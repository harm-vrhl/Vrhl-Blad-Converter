"use client";

import { useEffect, useState } from "react";

export type Provider = "openai" | "mistral";

export interface Settings {
  ocrPricePerPage: number;
  currency: string;
  provider: Provider;
  /** Of de gebruiker de aanbieder mag kiezen (AI_PROVIDER_CHOICE). Zo niet, dan geldt `provider`. */
  providerChoice?: boolean;
  providers: Array<{ id: Provider; label: string; model: string; ready: boolean; limit: number | null }>;
  /** Hoeveel artikelen uit een magazine tegelijk worden omgezet. */
  articleConcurrency?: number;
  /** Of deze installatie naar Sanity kan schrijven, en waarheen. */
  sanity?: { ready: boolean; projectId: string | null; dataset: string | null };
}

export const PROVIDER_KEY = "vrhl.provider";

/** Hoe deze installatie ervoor staat, en welke provider er schrijft. */
export function useSettings() {
  // How this installation stands by default, and what the optional OCR costs.
  const [settings, setSettings] = useState<Settings | null>(null);
  const [provider, setProvider] = useState<Provider>("openai");

  useEffect(() => {
    let live = true;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: Settings | null) => {
        if (!live || !body) return;
        setSettings(body);
        let remembered: string | null = null;
        try {
          remembered = window.localStorage.getItem(PROVIDER_KEY);
        } catch {
          remembered = null;
        }
        const usable = body.providers.filter((p) => p.ready && p.limit !== 0).map((p) => p.id);
        // Zonder keuze telt de onthouden voorkeur niet, maar hij blijft bewaard:
        // gaat de keuze weer aan, dan is hij er meteen weer.
        if (!body.providerChoice) remembered = null;
        const pick = [remembered, body.provider].find(
          (id): id is Provider => !!id && usable.includes(id as Provider),
        );
        if (pick) setProvider(pick);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return { settings, setSettings, provider, setProvider };
}
