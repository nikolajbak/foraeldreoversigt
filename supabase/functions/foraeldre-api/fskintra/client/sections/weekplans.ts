/**
 * Weekly plans ("ugeplaner").
 *
 * Two hops: a list page of links, then one page per week. The list is
 * server-rendered HTML; the per-week detail is a client-side Vue app whose
 * data rides in a JSON blob on the page (see parseWeekplan).
 */

import { clean, type Doc, htmlToText } from '../../auth/index.ts';
import { childUrl, type FskintraClient } from '../client.ts';
import { SectionParseError, SectionUnavailableError } from '../errors.ts';
import type { Child, Weekplan, WeekplanDay, WeekplanLink } from '../types.ts';

export async function listWeekplans(client: FskintraClient, child: Child): Promise<WeekplanLink[]> {
  const doc = await client.fetchPage(childUrl(child, 'item/weeklyplansandhomework/list/'));

  const list = doc('ul.sk-weekly-plans-list-container');
  if (!list.length) {
    assertAuthorized(doc, 'ugeplaner (weekly plans)');
    return [];
  }

  const plans: WeekplanLink[] = [];
  list.find('a[href]').each((_, a) => {
    const raw = doc(a).attr('href');
    if (!raw) return;
    const url = client.absUrl(raw);
    plans.push({
      id: url.replace(/\/$/, '').split('/').pop() ?? url,
      title: clean(doc(a).text()),
      url,
    });
  });
  return plans;
}

export async function getWeekplan(
  client: FskintraClient,
  url: string,
): Promise<Weekplan | undefined> {
  const doc = await client.fetchPage(url);
  return parseWeekplan(doc, url);
}

/**
 * Pure parser. The weekly-plan detail page is a client-side Vue app: the day
 * and lesson data is not in the server DOM but in a JSON blob on
 * `#root[data-clientlogic-settings-WeeklyPlansApp]`, which the browser renders.
 * We read that JSON directly rather than a browser (see docs/architecture.md).
 *
 * Returns undefined only when the page carries no such attribute at all (not a
 * weekly-plan page). If the attribute IS present but its JSON is malformed, that
 * is "should have been there" — a bug report — so it throws SectionParseError
 * rather than masquerading as an empty week. `fallbackTitle` (the list-level
 * title) is used when the payload omits FormattedWeek.
 */
export function parseWeekplan(doc: Doc, url: string, fallbackTitle = ''): Weekplan | undefined {
  // cheerio lowercases attribute names, so read the lowercased form even
  // though the server emits it CamelCased.
  const raw = doc('[data-clientlogic-settings-weeklyplansapp]')
    .first()
    .attr('data-clientlogic-settings-weeklyplansapp');
  if (!raw) return undefined;

  let app: WeeklyPlansApp;
  try {
    app = JSON.parse(raw) as WeeklyPlansApp;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new SectionParseError(
      'ugeplaner (weekly plans)',
      url,
      `the WeeklyPlansApp payload was not valid JSON: ${detail}`,
    );
  }

  const selected = app.SelectedPlan;
  if (!selected) {
    throw new SectionParseError(
      'ugeplaner (weekly plans)',
      url,
      'the WeeklyPlansApp payload had no SelectedPlan',
    );
  }

  // Valid JSON with a wrong-shaped field (e.g. DailyPlans as an object, or a
  // day's LessonPlans as a string) is "broken", not "empty": guard array-ness
  // and raise the typed error rather than letting a raw TypeError escape the
  // SectionParseError contract that getWeekplans relies on to isolate a week.
  const dailyPlans = selected.DailyPlans ?? [];
  if (!Array.isArray(dailyPlans)) {
    throw new SectionParseError('ugeplaner (weekly plans)', url, 'DailyPlans was not an array');
  }

  const days: WeekplanDay[] = dailyPlans.map((d) => {
    const lessons = d.LessonPlans ?? [];
    if (!Array.isArray(lessons)) {
      throw new SectionParseError('ugeplaner (weekly plans)', url, 'LessonPlans was not an array');
    }
    return {
      day: clean(d.Day),
      // FormattedDate ("14. sep.") is what the app shows; fall back to the ISO date.
      date: clean(d.FormattedDate || d.Date),
      entries: lessons
        // Drafts are teacher work-in-progress, not published — never shown to a
        // parent. An absent IsDraft is treated as published (shown): the server
        // only sets the flag on actual drafts.
        .filter((lesson) => !lesson.IsDraft)
        .map((lesson) => lessonEntry(lesson))
        .filter((e) => e.length > 0),
    };
  });

  return {
    id: selected.FormattedWeek || url.replace(/\/$/, '').split('/').pop() || url,
    title: clean(selected.FormattedWeek ? `Uge ${selected.FormattedWeek}` : fallbackTitle),
    url,
    days,
  };
}

/** One lesson rendered as "Subject: content", or whichever half is present. */
function lessonEntry(lesson: WeeklyPlanLesson): string {
  const subject = clean(lesson.Subject?.Title ?? lesson.Subject?.FormattedTitle ?? '');
  const body = clean(htmlToText(lesson.Content ?? ''));
  if (subject && body) return `${subject}: ${body}`;
  return subject || body;
}

/**
 * Minimal shape of the WeeklyPlansApp JSON we depend on; the payload has more.
 * This is a parse-boundary DTO over an untrusted, variable server payload, so
 * fields are widened to allow the wrong shape (e.g. a non-array DailyPlans) —
 * parseWeekplan validates array-ness and raises SectionParseError, rather than
 * trusting the JSON.parse cast and crashing on .map.
 */
interface WeeklyPlansApp {
  SelectedPlan?: {
    FormattedWeek?: string;
    DailyPlans?: WeeklyPlanDay[] | unknown;
  };
}

interface WeeklyPlanDay {
  Day?: string;
  Date?: string;
  FormattedDate?: string;
  LessonPlans?: WeeklyPlanLesson[] | unknown;
}

interface WeeklyPlanLesson {
  Subject?: { Title?: string; FormattedTitle?: string };
  Content?: string;
  IsDraft?: boolean;
}

/** The most recent `limit` weeks, fully fetched. */
export async function getWeekplans(
  client: FskintraClient,
  child: Child,
  limit = 4,
): Promise<Weekplan[]> {
  const listed = await listWeekplans(client, child);
  const plans: Weekplan[] = [];
  for (const entry of listed.slice(0, limit)) {
    // Marked partial so the boundary never presents a broken/unloaded week as a
    // genuinely empty one.
    const listFallback: Weekplan = {
      id: entry.id,
      title: entry.title,
      url: entry.url,
      days: [],
      partial: true,
    };
    try {
      const doc = await client.fetchPage(entry.url);
      // Pass the list title so a payload without FormattedWeek still gets a name.
      const plan = parseWeekplan(doc, entry.url, entry.title);
      if (!plan) {
        // A listed week whose detail carries no WeeklyPlansApp attribute is an
        // anomaly worth recording, not a silent empty week.
        client.logger.warn('weekplans.detail_not_a_plan', { url: entry.url });
        plans.push(listFallback);
      } else {
        plans.push(plan);
      }
    } catch (error) {
      // A broken detail page (SectionParseError) must not take out the sibling
      // weeks or vanish silently: record why, surface the plan at list level
      // (flagged partial), and let any other error (auth, network) propagate.
      if (error instanceof SectionParseError) {
        client.logger.warn('weekplans.detail_parse_failed', {
          url: entry.url,
          detail: error.message,
        });
        plans.push(listFallback);
      } else {
        throw error;
      }
    }
  }
  return plans;
}

/**
 * ForældreIntra says "ikke autoriseret" when a module isn't part of the
 * school's subscription. Distinguishing that from a parse failure is what
 * lets `discover` report the section as unavailable instead of empty.
 */
export function assertAuthorized(doc: Doc, section: string): void {
  if (/ikke autoriseret/i.test(doc('body').text())) {
    throw new SectionUnavailableError(section);
  }
}
