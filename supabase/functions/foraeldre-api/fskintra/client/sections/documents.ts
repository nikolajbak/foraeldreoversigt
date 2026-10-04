/**
 * Class documents ("Klassens dokumenter"), including one level of sub-folders.
 *
 * Sub-folders are not links: they are a JSON array in a hidden `#FoldersJson`
 * field, which is why a naive link crawl finds only the root.
 */

import { clean, type Doc, parseDanishDateTime } from '../../auth/index.ts';
import { childUrl, type FskintraClient } from '../client.ts';
import type { Child, Document } from '../types.ts';

interface Folder {
  Name?: string;
  Title?: string;
  Url?: string;
}

export async function getDocuments(client: FskintraClient, child: Child): Promise<Document[]> {
  const rootTitle = 'Klassens dokumenter';
  const doc = await client.fetchPage(childUrl(child, '/documents/class'));

  const documents = collectDocuments(doc, rootTitle, (url) => client.absUrl(url));

  const foldersJson = doc('#FoldersJson').attr('value');
  if (foldersJson) {
    let folders: Folder[] = [];
    try {
      folders = JSON.parse(foldersJson) as Folder[];
    } catch {
      folders = [];
    }

    for (const folder of folders) {
      // Names starting with "$" are ForældreIntra's own internal folders.
      if (!folder.Url || folder.Name?.startsWith('$')) continue;
      const folderDoc = await client.fetchPage(client.absUrl(folder.Url));
      const label = `${rootTitle} / ${clean(folder.Title).replace(/>/g, '/')}`;
      documents.push(...collectDocuments(folderDoc, label, (url) => client.absUrl(url)));
    }
  }

  return documents;
}

/** Pure parser for one folder page. */
export function collectDocuments(
  doc: Doc,
  folder: string,
  absUrl: (url: string) => string,
): Document[] {
  const docs: Document[] = [];
  doc('div.sk-document').each((_, el) => {
    const node = doc(el);
    const name = clean(node.find('span.sk-documents-document-title').first().text());
    const dateText = clean(node.find('div.sk-documents-date-column').first().text());
    const href = node.find('a[href]').first().attr('href');
    if (!name || !dateText || !href) return;

    const date = parseDanishDateTime(dateText);
    docs.push({ name, folder, url: absUrl(href), ...(date ? { date } : {}), dateText });
  });
  return docs;
}
