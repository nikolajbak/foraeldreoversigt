/**
 * HTML helpers shared by the login flow and the page parsers.
 *
 * These are the pieces that have to survive ForældreIntra's markup drift:
 * whitespace normalisation (the site is full of non-breaking spaces),
 * browser-faithful form serialisation, and Danish date parsing.
 */

import * as cheerio from 'npm:cheerio@^1.2.0';
import type { AnyNode, Element } from 'npm:domhandler@^6.0.1';

export type Doc = cheerio.CheerioAPI;
export type Node = cheerio.Cheerio<AnyNode>;

export function parse(html: string): Doc {
  return cheerio.load(html);
}

/** Collapse whitespace and the non-breaking spaces ForældreIntra sprinkles everywhere. */
export function clean(text: string | undefined | null): string {
  return (text ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** Readable plain text from a fragment, keeping block-level line breaks. */
export function textOf($: Doc, el: Element | Node | undefined): string {
  if (!el) return '';
  const node = 'length' in el ? el : $(el);
  const clone = node.clone();
  clone.find('br').replaceWith('\n');
  clone.find('p, div, li, tr, h1, h2, h3, h4, h5, h6').append('\n');
  return clone
    .text()
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim();
}

export interface FormSpec {
  action: string;
  method: 'GET' | 'POST';
  fields: URLSearchParams;
}

/**
 * Serialize a form the way a browser would: every successful control, hidden
 * fields included. ASP.NET's `__RequestVerificationToken` lives in one of those,
 * so dropping hidden inputs breaks every POST.
 */
export function serializeForm(
  $: Doc,
  form: Node,
  overrides: Record<string, string> = {},
): FormSpec {
  const fields = new URLSearchParams();

  form.find('input, select, textarea').each((_, raw) => {
    const el = $(raw);
    const name = el.attr('name');
    if (!name || el.attr('disabled') !== undefined) return;

    const tag = (raw as Element).tagName?.toLowerCase();
    if (tag === 'select') {
      const selected = el.find('option[selected]').first();
      const option = selected.length ? selected : el.find('option').first();
      fields.append(name, option.attr('value') ?? clean(option.text()));
      return;
    }
    if (tag === 'textarea') {
      fields.append(name, el.text());
      return;
    }

    const type = (el.attr('type') ?? 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'image' || type === 'file') return;
    if ((type === 'checkbox' || type === 'radio') && el.attr('checked') === undefined) return;
    fields.append(name, el.attr('value') ?? '');
  });

  for (const [name, value] of Object.entries(overrides)) {
    fields.delete(name);
    fields.append(name, value);
  }

  return {
    action: form.attr('action') ?? '',
    method: (form.attr('method') ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
    fields,
  };
}

/** Find the first form containing a control with one of the given names. */
export function findFormWithField($: Doc, ...names: string[]): Node | undefined {
  for (const name of names) {
    const control = $(`form [name="${name}"]`).first();
    if (control.length) {
      const form = control.closest('form');
      if (form.length) return form;
    }
  }
  return undefined;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  januar: 1,
  feb: 2,
  februar: 2,
  mar: 3,
  mars: 3,
  marts: 3,
  apr: 4,
  april: 4,
  maj: 5,
  jun: 6,
  juni: 6,
  jul: 7,
  juli: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  okt: 10,
  oktober: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/**
 * Parse a Danish timestamp such as "ons. 25. jun. 2018 16:26", "25. juni 2018
 * kl. 16:26" or "I dag kl. 09:12" into an ISO-8601 local date-time.
 *
 * Deliberately not locale-based: the Python reference required a system
 * `da_DK` locale and failed confusingly without one. A month table is a few
 * lines and works everywhere.
 *
 * Returns undefined rather than guessing when the shape is unfamiliar — the
 * raw string is always kept alongside it, so nothing is lost.
 */
export function parseDanishDateTime(input: string, now = new Date()): string | undefined {
  const text = clean(input)
    .toLowerCase()
    .replace(/\bkl\.?\b/g, ' ');
  const time = /(\d{1,2})[:.](\d{2})/.exec(text);
  const hh = time ? Number(time[1]) : 12;
  const mm = time ? Number(time[2]) : 0;

  const relative = /\bi\s*(dag|går|morgen)\b/.exec(text);
  if (relative) {
    const shift = relative[1] === 'går' ? -1 : relative[1] === 'morgen' ? 1 : 0;
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + shift, hh, mm);
    return toIsoLocal(day);
  }

  const named = /(\d{1,2})\.?\s+([a-zæøå]+)\.?\s+(\d{4})/.exec(text);
  if (named) {
    const month = MONTHS[named[2] ?? ''];
    if (month) return toIsoLocal(new Date(Number(named[3]), month - 1, Number(named[1]), hh, mm));
  }

  const numeric = /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/.exec(text);
  if (numeric) {
    const year = Number(numeric[3]);
    return toIsoLocal(
      new Date(year < 100 ? 2000 + year : year, Number(numeric[2]) - 1, Number(numeric[1]), hh, mm),
    );
  }

  return undefined;
}

function toIsoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Plain text from an HTML fragment (message bodies arrive as HTML in JSON). */
export function htmlToText(html: string): string {
  const $ = parse(`<div id="__frag">${html}</div>`);
  return textOf($, $('#__frag'));
}
