'use client';

import { useEffect, useState, type ComponentProps } from 'react';
import { fileUrl, knownUrl } from '@/lib/client/db';

/** Het adres van een bewaard bestand, zodra het uit de opslag is gehaald. */
export function useStoredUrl(owner: string | null | undefined, name: string | null | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() => (owner && name ? knownUrl(owner, name) : undefined));

  useEffect(() => {
    if (!owner || !name) {
      setUrl(undefined);
      return;
    }
    const known = knownUrl(owner, name);
    if (known) {
      setUrl(known);
      return;
    }
    let live = true;
    void fileUrl(owner, name).then((found) => {
      if (live) setUrl(found ?? undefined);
    });
    return () => {
      live = false;
    };
  }, [owner, name]);

  return url;
}

/**
 * Een `<img>` voor een bestand uit de opslag van deze browser: een render, een
 * thumbnail of een foto uit de PDF. Tot het geladen is staat er niets, zodat er
 * geen gebroken beeld flitst.
 */
export function StoredImage({
  owner,
  name,
  alt = '',
  ...props
}: { owner: string | null | undefined; name: string | null | undefined; alt?: string } & Omit<
  ComponentProps<'img'>,
  'src'
>) {
  const url = useStoredUrl(owner, name);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt={alt} {...props} /> : null;
}
