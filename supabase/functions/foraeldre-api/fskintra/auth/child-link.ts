/**
 * What a logged-in ForældreIntra front page looks like, expressed as the one
 * thing it always carries: a link per child.
 *
 * Two layers ask the same question and used to answer it with two subtly
 * different regexes. The login flow (`fskintra-auth`) asks "am I on the front
 * page yet?" to know it is done; the client (`fskintra-client`) asks "is this
 * the front page I can scrape children off?". Those are the same question, so
 * they must share the same answer — otherwise a page login accepts (an
 * absolute href, a trailing slash) is one the client then finds no children
 * on, and you get a login that succeeds into zero children.
 *
 * A child link is three path segments followed by `/Index`, e.g.
 * `/parent/1234/Andrea/Index`. It may be an absolute URL or a bare path, may
 * carry a trailing slash, and may carry a `?query` or `#fragment`. This is the
 * permissive, canonical form. Login also accepts a front page by its URL shape
 * (`INDEX_RE`) as an early check; this predicate is the content-based test both
 * layers share for everything else.
 */
const CHILD_LINK_RE = /^(?:https?:\/\/[^/]+)?(?:\/[^/]*){3}\/Index\/?$/i;

/** Is this href a link to a child's front page? */
export function isChildLink(href: string | undefined | null): boolean {
  if (href == null) return false;
  // Match on the path alone; a real href may carry ?query or #fragment, and
  // login (which checks the URL) and the client (which scrapes hrefs) must
  // agree on the same page regardless.
  const pathOnly = href.split(/[?#]/, 1)[0] ?? href;
  return CHILD_LINK_RE.test(pathOnly);
}
