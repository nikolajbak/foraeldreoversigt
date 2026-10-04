/** Photo albums. Each album is an option of a filter dropdown with its own page. */

import { clean } from '../../auth/index.ts';
import { childUrl, type FskintraClient } from '../client.ts';
import type { Child, PhotoAlbum } from '../types.ts';

export async function getPhotoAlbums(client: FskintraClient, child: Child): Promise<PhotoAlbum[]> {
  const doc = await client.fetchPage(childUrl(child, '/photos/archives'));

  const albums: { title: string; url: string }[] = [];
  doc('#sk-photos-toolbar-filter option[value]').each((_, opt) => {
    const value = doc(opt).attr('value');
    if (!value) return;
    const url = client.absUrl(value);
    // Guard against the dropdown pointing outside this child's area.
    if (!url.startsWith(child.urlPrefix)) return;
    albums.push({ title: clean(doc(opt).text()), url });
  });

  const result: PhotoAlbum[] = [];
  for (const album of albums) {
    const albumDoc = await client.fetchPage(album.url);
    const photos: string[] = [];
    albumDoc('img[src]').each((_, img) => {
      const src = albumDoc(img).attr('src');
      if (src && !/placeholder/i.test(src)) photos.push(client.absUrl(src));
    });
    result.push({
      title: clean(albumDoc('h2').first().text()) || album.title,
      url: album.url,
      photos,
    });
  }

  return result;
}
