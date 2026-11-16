import { AsyncLocalStorage } from 'node:async_hooks';

import { describeSessions, type PluginSessionInfo, sessionsMatchingFile } from './sessions.js';
import { FileTargetError, type SessionSource } from './target.js';

/**
 * Per-call file routing: the `file` argument every plugin-reaching tool accepts.
 *
 * `use_file` binds a whole server process to one file, and one process is everything inside one MCP
 * client — subagents included. An agent working across several files therefore had to re-claim
 * before every switch, and two of its calls could never run against two files at once. A route
 * resolved per call and carried in async-local storage gives each call its own file without
 * touching the claim, so concurrent calls to different files cannot see each other's choice, and
 * every sub-call of a multi-call tool lands in the file the call named.
 *
 * Precedence: the call's `file`, then the process claim, then the foreground file.
 */
export type RouteVia = 'session' | 'fileKey' | 'linkName' | 'name';

export interface CallRoute {
  sessionId: string;
  fileName: string | null;
  fileKey: string | null;
  via: RouteVia;
}

// The editors a figma.com link can open, and an optional /branch/<key> after the name slug.
const FIGMA_FILE_PATH =
  /^\/(?:file|design|board|proto|slides|make|jam|figjam)\/([0-9A-Za-z]+)(?:\/[^/]*)?(?:\/branch\/([0-9A-Za-z]+))?/;
const FILE_KEY_SHAPE = /^[0-9A-Za-z]{10,}$/;

/** Whether `value` could be a Figma file key (real keys are 22 characters; /design/new is not). */
export const isFileKeyShape = (value: string): boolean => FILE_KEY_SHAPE.test(value);

/**
 * The file key a figma.com link points at, as a one-element list (empty for anything else): the
 * branch key for a branch link — a branch and its main file are different write targets, so a
 * branch link must never fall back to the main file — else the file's own key.
 */
export const fileKeysOfUrl = (raw: string): string[] => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return [];
  }
  if (url.hostname !== 'figma.com' && !url.hostname.endsWith('.figma.com')) return [];
  const match = FIGMA_FILE_PATH.exec(url.pathname);
  if (match === null) return [];
  const key = match[2] ?? match[1];
  return key !== undefined && isFileKeyShape(key) ? [key] : [];
};

/**
 * The file name a figma.com link carries in its slug — `Penpot-Exporter--Community-` for "Penpot
 * Exporter (Community)" — or null. Figma writes every character it does not keep as `-`, so this is
 * only ever compared through {@linkcode slugKey}, never shown as a name.
 */
export const fileSlugOfUrl = (raw: string): string | null => {
  if (fileKeysOfUrl(raw).length === 0) return null;
  const slug = new URL(raw.trim()).pathname.split('/')[3];
  if (slug === undefined || slug === '' || slug === 'branch') return null;
  try {
    return decodeURIComponent(slug);
  } catch {
    return null;
  }
};

/** A name or slug reduced to what both keep: letters and digits, lower-cased, runs joined by `-`. */
const slugKey = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, '-')
    .replaceAll(/^-+|-+$/g, '');

const route = (session: PluginSessionInfo, via: RouteVia): CallRoute => ({
  sessionId: session.id,
  fileName: session.fileName,
  fileKey: session.fileKey ?? null,
  via,
});

const ambiguous = (what: string, matches: readonly PluginSessionInfo[]): FileTargetError =>
  new FileTargetError(
    `${what} matches ${matches.length} open files, so it cannot pick one — Figma allows duplicate ` +
      `names, and one file can be open in two tabs. Pass file as one of these sessionIds: ` +
      `${matches.map(m => `${m.id} (page ${m.pageName ?? '?'})`).join(', ')}`,
  );

const uniqueByKey = (
  sessions: readonly PluginSessionInfo[],
  keys: readonly string[],
): PluginSessionInfo | null => {
  for (const key of keys) {
    const matches = sessions.filter(s => s.fileKey === key);
    if (matches.length > 1) throw ambiguous(`file key ${key}`, matches);
    const only = matches[0];
    if (only !== undefined) return only;
  }
  return null;
};

/**
 * Resolve a call's `file` to one connected session, without binding anything.
 *
 * In order: an exact sessionId; a Figma URL or bare file key, matched against the key the Figma
 * client reported for each session (figma-linux-next stamps it on the plugin's connection — public
 * plugins cannot read it); a file name, which must match exactly one connected file. Anything that
 * matches nothing or more than one is refused with what is connected, never guessed: the fallback
 * would be another file's nodes. A URL never falls back to a name — its slug is lossy, and the
 * common case is a link to the original of a file whose copy is open.
 *
 * `connected` is the relay's own list (free, names may be stale); `probe` asks each plugin for its
 * current name and is paid for whenever a name has to be matched — a sessionId or key never pays
 * it.
 */
export const resolveFileRef = async (
  connected: SessionSource,
  probe: SessionSource,
  ref: string,
): Promise<CallRoute> => {
  const wanted = ref.trim();
  if (wanted === '') {
    throw new FileTargetError(
      'file is empty — pass a sessionId or file name from list_files, or a Figma URL',
    );
  }
  const sessions = await connected();
  if (sessions.length === 0) {
    throw new FileTargetError(
      `no Figma file is connected, so "${wanted}" cannot be reached — open the Figwright plugin ` +
        'in that file first',
    );
  }

  const byId = sessions.find(s => s.id === wanted);
  if (byId !== undefined) return route(byId, 'session');

  const urlKeys = fileKeysOfUrl(wanted);
  const keys = urlKeys.length > 0 ? urlKeys : isFileKeyShape(wanted) ? [wanted] : [];
  const byKey = uniqueByKey(sessions, keys);
  if (byKey !== null) return route(byKey, 'fileKey');
  if (urlKeys.length > 0) {
    const reported = sessions.some(s => (s.fileKey ?? null) !== null);
    // A client that reports no keys (the official desktop app, on any OS) can still be reached by
    // link: by the file name in its slug, when exactly one open file has it. Not when keys are
    // reported — there an unmatched key means the linked file is not open, and its name may well
    // be shared by the copy that is.
    const slug = reported ? null : fileSlugOfUrl(wanted);
    if (slug !== null && slugKey(slug) !== '') {
      const named = await probe();
      const bySlug = named.filter(
        s => s.fileName !== null && slugKey(s.fileName) === slugKey(slug),
      );
      const only = bySlug[0];
      if (bySlug.length === 1 && only !== undefined) return route(only, 'linkName');
      if (bySlug.length > 1) throw ambiguous(`the link's file name "${slug}"`, bySlug);
    }
    throw new FileTargetError(
      `no connected file has file key ${urlKeys.join(' or ')}. ` +
        (reported
          ? ''
          : 'This Figma client does not report file keys to Figwright (figma-linux-next does), ' +
            "and no open file has the link's file name — a link to the original does not reach " +
            'a copy, which Figma names "… (Copy)". ') +
        `Pass a sessionId or file name from list_files instead. Connected now: ${describeSessions(sessions)}`,
    );
  }

  // Names are always probed: the relay's copy only refreshes on selection and page changes, so a
  // file renamed since would be matched — or found unambiguous — by its old name.
  const named = await probe();
  const matches = sessionsMatchingFile(named, wanted);
  const only = matches[0];
  if (matches.length === 1 && only !== undefined) return route(only, 'name');
  if (matches.length === 0) {
    throw new FileTargetError(
      `no connected file matches "${wanted}" as a sessionId, file key or name. ` +
        `Connected now: ${describeSessions(named)}`,
    );
  }
  throw ambiguous(`"${wanted}"`, matches);
};

/**
 * Re-find the file a call was routed to after its session disappeared before the call was sent —
 * the panel was closed and reopened, which mints a new sessionId. Only by file key when the client
 * reported one, else by name, and only when exactly one connected file matches; otherwise it throws
 * with what is connected. Only ever used for a call the relay refused up front: a write that had
 * already been sent is never re-sent elsewhere (the relay answers that one "plugin closed before
 * answering", and the idempotency cache that would have deduped it died with the old panel).
 */
export const recoverCallRoute = async (
  probe: SessionSource,
  gone: CallRoute,
): Promise<CallRoute> => {
  const sessions = await probe();
  if (gone.fileKey !== null) {
    // A known key is the file's identity: a same-name session with another key, or none, is a
    // different file, and the write must not land there.
    const byKey = uniqueByKey(sessions, [gone.fileKey]);
    if (byKey !== null) return route(byKey, gone.via);
    throw new FileTargetError(
      `the file this call was routed to (file key ${gone.fileKey}) is no longer connected — its ` +
        `Figwright panel was closed, or Figma was. Connected now: ${describeSessions(sessions)}`,
    );
  }
  if (gone.fileName === null) {
    throw new FileTargetError(
      `the plugin session this call was routed to (${gone.sessionId}) is gone and never reported ` +
        `a file name, so it cannot be recovered. Connected now: ${describeSessions(sessions)}`,
    );
  }
  const matches = sessionsMatchingFile(sessions, gone.fileName);
  const only = matches[0];
  if (matches.length === 1 && only !== undefined) return route(only, gone.via);
  if (matches.length === 0) {
    throw new FileTargetError(
      `"${gone.fileName}" is no longer connected — its Figwright panel was closed, or Figma was. ` +
        `Connected now: ${describeSessions(sessions)}`,
    );
  }
  throw ambiguous(`"${gone.fileName}" (reopened)`, matches);
};

interface RouteBox {
  route: CallRoute;
}

const scope = new AsyncLocalStorage<RouteBox>();

/** Run one tool call with every dispatch inside it pinned to `callRoute`. */
export const runWithCallRoute = <T>(callRoute: CallRoute, fn: () => Promise<T>): Promise<T> =>
  scope.run({ route: callRoute }, fn);

/** The route of the tool call in progress, or null outside a routed call. */
export const getCallRoute = (): CallRoute | null => scope.getStore()?.route ?? null;

/** Re-point the call in progress after recovery, so its later sub-calls follow. */
export const updateCallRoute = (next: CallRoute): void => {
  const box = scope.getStore();
  if (box !== undefined) box.route = next;
};

/** The one line a routed result carries, naming the file that answered. */
export const describeCallRoute = (r: CallRoute): string =>
  `routed to ${r.fileName === null ? '(unnamed file)' : `"${r.fileName}"`} [session ${r.sessionId}] by ${VIA_LABEL[r.via]}`;

const VIA_LABEL: Record<RouteVia, string> = {
  session: 'session',
  fileKey: 'file key',
  linkName: "the link's file name",
  name: 'name',
};
