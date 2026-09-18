"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { QuietToolbar, ToolbarButton } from "@/components/QuietToolbar";
import { zoekInArtikel } from "@/components/article/zoek";
import type { ArticleDocument } from "@/lib/types";

/**
 * Zoeken in het artikel dat nu openstaat. ⌘F focust het veld; Enter en F3
 * lopen de treffers af. De telling komt uit het artikelobject, de sprong uit
 * het scherm, zodat twee keer "de" in dezelfde alinea allebei een plek hebben.
 */
export function Zoekbalk({
  doc,
  onSpring,
}: {
  doc: ArticleDocument;
  onSpring: (query: string, index: number, flits: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const invoer = useRef<HTMLInputElement>(null);
  const vorige = useRef({ query: "", index: -1 });
  const hits = useMemo(() => zoekInArtikel(doc, query), [doc, query]);
  const n = hits.length;
  const at = n ? Math.min(index, n - 1) : 0;

  useEffect(() => {
    if (n && index >= n) setIndex(n - 1);
  }, [index, n]);

  useEffect(() => {
    const needle = query.trim();
    if (!needle || !n) {
      if (!needle) {
        vorige.current = { query: "", index: -1 };
        onSpring("", 0, false);
      }
      return;
    }
    if (vorige.current.query === query && vorige.current.index === at) return;
    const getypt = vorige.current.query !== query;
    vorige.current = { query, index: at };
    if (!getypt) {
      onSpring(query, at, true);
      return;
    }
    const wacht = window.setTimeout(() => onSpring(query, at, false), 200);
    return () => window.clearTimeout(wacht);
  }, [query, at, n, onSpring]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const inVeld = event.target === invoer.current;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        invoer.current?.focus();
        invoer.current?.select();
        return;
      }
      if (event.key === "Escape" && inVeld) {
        event.preventDefault();
        if (query) {
          setQuery("");
          setIndex(0);
        } else invoer.current?.blur();
        return;
      }
      const verder =
        event.key === "F3" || (inVeld && event.key === "Enter" && !event.metaKey && !event.ctrlKey);
      if (!verder) return;
      event.preventDefault();
      if (!n) return;
      setIndex((i) => (i + (event.shiftKey ? n - 1 : 1)) % n);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [n, query]);

  const stap = (delta: number) => {
    if (!n) return;
    setIndex((i) => (i + delta + n) % n);
  };

  const telling = query.trim() ? (n ? `${at + 1}/${n}` : "0") : "";

  return (
    <QuietToolbar aria-label="Zoek in het artikel">
      <Search className="ml-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={invoer}
        type="text"
        value={query}
        autoComplete="off"
        spellCheck={false}
        placeholder="Zoeken"
        aria-label="Zoek in het artikel"
        title="Zoeken (⌘F)"
        className="h-full w-36 min-w-0 bg-transparent px-1 text-xs text-foreground outline-none placeholder:text-muted-foreground"
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
      />
      <span
        className={
          n || !query.trim()
            ? "min-w-10 shrink-0 px-0.5 text-center text-[11px] tabular-nums text-muted-foreground"
            : "min-w-10 shrink-0 px-0.5 text-center text-[11px] tabular-nums text-destructive"
        }
        aria-live="polite"
      >
        {telling}
      </span>
      <ToolbarButton type="button" disabled={!n} title="Vorige (⇧Enter)" onClick={() => stap(-1)}>
        <ChevronUp className="size-3.5" />
        <span className="sr-only">Vorige treffer</span>
      </ToolbarButton>
      <ToolbarButton type="button" disabled={!n} title="Volgende (Enter)" onClick={() => stap(1)}>
        <ChevronDown className="size-3.5" />
        <span className="sr-only">Volgende treffer</span>
      </ToolbarButton>
    </QuietToolbar>
  );
}
