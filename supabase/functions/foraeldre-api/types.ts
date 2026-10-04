export type Kind = 'besked' | 'opslag' | 'begivenhed' | 'aktivitet' | 'lektier' | 'påmindelse';

/** Ét stykke indhold fra en kilde, normaliseret til fælles form. */
export interface Item {
  id: string;
  source: 'aula' | 'holdsport' | 'forældreintra';
  kind: Kind;
  child?: string | null;
  title: string;
  body?: string | null;
  url?: string | null;
  sender?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  published_at?: string | null;
  important?: boolean;
  /** Felter der indgår i ændrings-hashen; resten (fx brødtekst-pynt) gør ikke. */
  hashParts: unknown[];
}

/** Kilden skal logges ind igen af en forælder; serveren kan ikke selv. */
export class NeedsLoginError extends Error {
  override name = 'NeedsLoginError';
}

export function stripHtml(html: string | undefined | null): string {
  if (!html) return '';
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function toIso(v: string | undefined | null): string | null {
  if (!v) return null;
  // Aula: "2026-10-05 08:00:00.0000+0200" → gyldig ISO.
  const fixed = v.replace(' ', 'T').replace(/\.\d+/, '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  const d = new Date(fixed);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
