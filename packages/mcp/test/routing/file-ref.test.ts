import { afterEach, describe, expect, it } from 'vitest';

import { dispatchTargeted, resolveCallRoute, resolveRoutingSession } from '../../src/dispatch.js';
import type { Follower } from '../../src/election/follower.js';
import { portConflictMessage } from '../../src/election/leader-lock.js';
import type { Node } from '../../src/election/node.js';
import { readFileKeyHeader } from '../../src/relay/relay.js';
import {
  type CallRoute,
  describeCallRoute,
  fileKeysOfUrl,
  fileSlugOfUrl,
  getCallRoute,
  recoverCallRoute,
  resolveFileRef,
  runWithCallRoute,
} from '../../src/routing/file-ref.js';
import type { PluginSessionInfo } from '../../src/routing/sessions.js';
import { clearFileTarget, getFileTarget, setFileTarget } from '../../src/routing/target.js';
import { FILE_ARG, FILE_ROUTED_TOOL_NAMES, ALL_TOOL_SPECS } from '../../src/tools/registry.js';
import { checkBatchOps, WIRE_TOOL_SCHEMAS } from '../../src/tools/wire-schema.js';

const KEY_A = '4s7OY6WGaMYBol3BCjh1Zv';
const KEY_B = 'Zz9OY6WGaMYBol3BCjh1Qq';

const info = (
  id: string,
  fileName: string | null,
  fileKey: string | null = null,
): PluginSessionInfo => ({
  id,
  fileName,
  pageName: 'Page 1',
  lastActivityAt: 1,
  pluginVersion: '0.7.0',
  fileKey,
});

const source =
  (sessions: readonly PluginSessionInfo[]) => (): Promise<readonly PluginSessionInfo[]> =>
    Promise.resolve(sessions);

const never = (): Promise<readonly PluginSessionInfo[]> => {
  throw new Error('probe must not be needed');
};

describe('fileKeysOfUrl', () => {
  it('reads the key of a design link, and a branch key first', () => {
    expect(fileKeysOfUrl(`https://www.figma.com/design/${KEY_A}/Name?node-id=5-2`)).toEqual([
      KEY_A,
    ]);
    expect(fileKeysOfUrl(`https://www.figma.com/design/${KEY_A}/Name/branch/${KEY_B}/x`)).toEqual([
      KEY_B,
      KEY_A,
    ]);
    expect(fileKeysOfUrl(`https://figma.com/file/${KEY_A}`)).toEqual([KEY_A]);
  });

  it('ignores non-figma hosts, new-file links and plain text', () => {
    expect(fileKeysOfUrl(`https://evil.example/design/${KEY_A}/x`)).toEqual([]);
    expect(fileKeysOfUrl('https://www.figma.com/design/new')).toEqual([]);
    expect(fileKeysOfUrl('Marketing Site')).toEqual([]);
  });
});

describe('resolveFileRef', () => {
  const sessions = [info('s-1', 'Brand', KEY_A), info('s-2', 'Marketing', null)];

  it('matches an exact sessionId first, without probing', async () => {
    await expect(resolveFileRef(source(sessions), never, 's-2')).resolves.toEqual({
      sessionId: 's-2',
      fileName: 'Marketing',
      fileKey: null,
      via: 'session',
    });
  });

  it('matches a link or a bare key by the reported file key', async () => {
    const link = `https://www.figma.com/design/${KEY_A}/Brand?node-id=1-2`;
    expect((await resolveFileRef(source(sessions), never, link)).sessionId).toBe('s-1');
    expect((await resolveFileRef(source(sessions), never, KEY_A)).via).toBe('fileKey');
  });

  it('reaches a file by the link slug when the client reports no keys (official app)', async () => {
    const noKeys = [info('s-1', 'Penpot Exporter (Community)'), info('s-2', 'Marketing')];
    const link = `https://www.figma.com/design/${KEY_B}/Penpot-Exporter--Community-?node-id=5-2`;
    expect(await resolveFileRef(source(noKeys), never, link)).toMatchObject({
      sessionId: 's-1',
      via: 'linkName',
    });
    expect(fileSlugOfUrl(link)).toBe('Penpot-Exporter--Community-');
    expect(fileSlugOfUrl(`https://www.figma.com/design/${KEY_B}`)).toBeNull();
  });

  it('refuses a link slug that matches no file, or two', async () => {
    const copy = [info('s-1', 'Penpot Exporter (Community) (Copy)')];
    const link = `https://www.figma.com/design/${KEY_B}/Penpot-Exporter--Community-`;
    await expect(resolveFileRef(source(copy), never, link)).rejects.toThrow(
      /does not report file keys.*\(Copy\)/,
    );
    const twice = [info('s-1', 'Brand'), info('s-2', 'brand')];
    await expect(
      resolveFileRef(source(twice), never, `https://www.figma.com/design/${KEY_B}/Brand`),
    ).rejects.toThrow(/matches 2 open files/);
  });

  it('refuses a link whose key is not open where keys are reported, never trying its slug', async () => {
    await expect(
      resolveFileRef(source(sessions), never, `https://www.figma.com/design/${KEY_B}/Brand`),
    ).rejects.toThrow(new RegExp(`no connected file has file key ${KEY_B}`));
  });

  it('matches a unique name case-insensitively', async () => {
    expect(await resolveFileRef(source(sessions), never, '  brand ')).toMatchObject({
      sessionId: 's-1',
      via: 'name',
    });
  });

  it('probes for names only when some session has not reported one', async () => {
    let probed = 0;
    const unnamed = [info('s-1', 'Brand'), info('s-2', null)];
    const probe = (): Promise<readonly PluginSessionInfo[]> => {
      probed += 1;
      return Promise.resolve([info('s-1', 'Brand'), info('s-2', 'Marketing')]);
    };
    expect((await resolveFileRef(source(unnamed), probe, 'Marketing')).sessionId).toBe('s-2');
    expect(probed).toBe(1);
  });

  it('refuses a duplicate name and lists the sessionIds to use', async () => {
    const dupes = [info('s-1', 'x'), info('s-2', 'x')];
    await expect(resolveFileRef(source(dupes), never, 'x')).rejects.toThrow(
      /matches 2 open files.*s-1 .*s-2/,
    );
  });

  it('refuses one file key open in two tabs', async () => {
    const twice = [info('s-1', 'Brand', KEY_A), info('s-2', 'Brand', KEY_A)];
    await expect(resolveFileRef(source(twice), never, KEY_A)).rejects.toThrow(/matches 2/);
  });

  it('refuses nothing connected, no match and an empty selector', async () => {
    await expect(resolveFileRef(source([]), never, 'Brand')).rejects.toThrow(/no Figma file/);
    await expect(resolveFileRef(source(sessions), never, 'Nope')).rejects.toThrow(
      /no connected file matches "Nope".*Brand \[s-1\]/,
    );
    await expect(resolveFileRef(source(sessions), never, '  ')).rejects.toThrow(/file is empty/);
  });
});

describe('recoverCallRoute', () => {
  const gone: CallRoute = {
    sessionId: 'old',
    fileName: 'Brand',
    fileKey: KEY_A,
    via: 'name',
  };

  it('re-finds a reopened panel by key, then by unique name', async () => {
    expect((await recoverCallRoute(source([info('new', 'Renamed', KEY_A)]), gone)).sessionId).toBe(
      'new',
    );
    expect(
      (
        await recoverCallRoute(source([info('new', 'Brand')]), {
          ...gone,
          fileKey: null,
        })
      ).sessionId,
    ).toBe('new');
  });

  it('refuses when the file is gone, ambiguous, or was never named', async () => {
    const noKey = { ...gone, fileKey: null };
    await expect(recoverCallRoute(source([]), noKey)).rejects.toThrow(/no longer connected/);
    await expect(
      recoverCallRoute(source([info('a', 'Brand'), info('b', 'Brand')]), noKey),
    ).rejects.toThrow(/matches 2/);
    await expect(
      recoverCallRoute(source([info('a', 'Brand')]), {
        ...noKey,
        fileName: null,
      }),
    ).rejects.toThrow(/never reported a file name/);
  });
});

describe('call-scoped dispatch', () => {
  const makeFollower = (): Follower => ({}) as unknown as Follower;

  /** A leader serving `live` sessions; a pinned call to anything else is refused before sending. */
  const leader = (
    live: () => readonly PluginSessionInfo[],
    seen: string[],
    send?: () => Promise<unknown>,
  ): Node =>
    ({
      isConflicted: () => false,
      port: 3055,
      conflictMessage: portConflictMessage(3055),
      onRoleChange: () => () => {},
      isLeader: () => true,
      getLeader: () => ({
        relay: {
          skewNotice: () => null,
          listSessionInfo: live,
          pickActiveSessionId: () => live()[0]?.id,
          sendRequest: async (name: string, _args: unknown, _t: number, sessionId?: string) => {
            if (send !== undefined && name !== 'list_files') return send();
            const sessions = live();
            if (sessionId !== undefined && !sessions.some(s => s.id === sessionId)) {
              throw new Error(
                `pinned session not connected (sessionId=${sessionId}, method=${name})`,
              );
            }
            if (name === 'list_files') {
              const s = sessions.find(x => x.id === sessionId);
              return {
                files: [
                  {
                    fileKey: null,
                    fileName: s?.fileName ?? null,
                    currentPage: { id: 'p', name: 'P' },
                  },
                ],
              };
            }
            // Yield so concurrent calls genuinely interleave.
            await new Promise(r => setTimeout(r, 1));
            seen.push(`${name}:${sessionId ?? '(unpinned)'}`);
            return { served: sessionId };
          },
        },
      }),
    }) as unknown as Node;

  afterEach(() => clearFileTarget());

  it('keeps concurrent calls to different files apart, and leaves the claim alone', async () => {
    const sessions = [info('s-a', 'A'), info('s-b', 'B')];
    const seen: string[] = [];
    const ctx = {
      node: leader(() => sessions, seen),
      follower: makeFollower(),
    };
    setFileTarget({ sessionId: 's-a', fileName: 'A' });

    const call = async (ref: string, n: number): Promise<unknown> => {
      const r = await resolveCallRoute(ctx, ref);
      return runWithCallRoute(r, async () => {
        const out = [];
        for (let i = 0; i < n; i += 1) out.push(await dispatchTargeted(ctx, `t${ref}`, {}));
        return out;
      });
    };
    await Promise.all([call('A', 20), call('B', 20), call('s-b', 20)]);

    expect(seen.filter(s => s.startsWith('tA:')).every(s => s === 'tA:s-a')).toBe(true);
    expect(seen.filter(s => s.startsWith('tB:')).every(s => s === 'tB:s-b')).toBe(true);
    expect(seen.filter(s => s.startsWith('ts-b:')).every(s => s === 'ts-b:s-b')).toBe(true);
    expect(seen).toHaveLength(60);
    expect(getFileTarget()).toEqual({ sessionId: 's-a', fileName: 'A' });
  });

  it('outranks the claim and pins multi-call tools to the named file', async () => {
    const sessions = [info('s-a', 'A'), info('s-b', 'B')];
    const ctx = { node: leader(() => sessions, []), follower: makeFollower() };
    setFileTarget({ sessionId: 's-a', fileName: 'A' });
    const r = await resolveCallRoute(ctx, 'B');
    await runWithCallRoute(r, async () => {
      expect(await resolveRoutingSession(ctx)).toBe('s-b');
      expect(await dispatchTargeted(ctx, 't', {})).toEqual({ served: 's-b' });
    });
    expect(getCallRoute()).toBeNull();
    expect(await dispatchTargeted(ctx, 't', {})).toEqual({ served: 's-a' });
  });

  it('follows a reopened panel for a call refused before sending, and later sub-calls follow', async () => {
    let sessions = [info('s-a', 'A'), info('s-b', 'B')];
    const seen: string[] = [];
    const ctx = {
      node: leader(() => sessions, seen),
      follower: makeFollower(),
    };
    const r = await resolveCallRoute(ctx, 'B');
    sessions = [info('s-a', 'A'), info('s-b2', 'B')];
    await runWithCallRoute(r, async () => {
      await dispatchTargeted(ctx, 'first', {});
      await dispatchTargeted(ctx, 'second', {});
      expect(describeCallRoute(getCallRoute() as CallRoute)).toBe(
        'routed to "B" [session s-b2] by name',
      );
    });
    expect(seen).toEqual(['first:s-b2', 'second:s-b2']);
  });

  it('never re-sends a call that was already sent when its plugin closed', async () => {
    const sessions = [info('s-b', 'B'), info('s-b2', 'B-copy')];
    let sends = 0;
    const node = leader(
      () => sessions,
      [],
      async () => {
        sends += 1;
        throw new Error(
          'plugin closed before answering (method=set_text) — it was closed or reloaded',
        );
      },
    );
    const ctx = { node, follower: makeFollower() };
    const r = await resolveCallRoute(ctx, 's-b');
    await expect(runWithCallRoute(r, () => dispatchTargeted(ctx, 'set_text', {}))).rejects.toThrow(
      /plugin closed before answering/,
    );
    expect(sends).toBe(1);
  });

  it('refuses the call rather than falling back when the named file closed and is ambiguous', async () => {
    let sessions = [info('s-b', 'B')];
    const ctx = { node: leader(() => sessions, []), follower: makeFollower() };
    const r = await resolveCallRoute(ctx, 'B');
    sessions = [info('x1', 'B'), info('x2', 'B')];
    await expect(runWithCallRoute(r, () => dispatchTargeted(ctx, 't', {}))).rejects.toThrow(
      /matches 2 open files/,
    );
  });
});

describe('file selector registration', () => {
  const unrouted = new Set([
    'ping',
    'list_files',
    'use_file',
    'analyze_project',
    'scan_components',
  ]);

  it('is on every plugin-reaching tool, optional, and on none of the others', () => {
    const routed = ALL_TOOL_SPECS.filter(spec => FILE_ARG in spec.inputSchema.shape).map(
      spec => spec.name,
    );
    expect(routed.toSorted()).toEqual(
      ALL_TOOL_SPECS.map(spec => spec.name)
        .filter(name => !unrouted.has(name))
        .toSorted(),
    );
    expect([...FILE_ROUTED_TOOL_NAMES].toSorted()).toEqual(routed.toSorted());
    const optional = ALL_TOOL_SPECS.filter(spec => FILE_ARG in spec.inputSchema.shape).filter(
      spec => spec.inputSchema.shape[FILE_ARG]?.safeParse(undefined).success !== true,
    );
    expect(optional.map(spec => spec.name)).toEqual([]);
  });

  it('never reaches the plugin: it is absent from every wire schema', () => {
    const leaking = [...WIRE_TOOL_SCHEMAS].filter(([, schema]) => FILE_ARG in schema.shape);
    expect(leaking.map(([name]) => name)).toEqual([]);
  });

  it('is refused on a batch op, pointing at the batch-level selector', () => {
    const rejection = checkBatchOps({
      ops: [
        {
          tool: 'rename_node',
          params: { nodeId: '1:2', name: 'x', file: 'B' },
        },
      ],
    });
    expect(rejection?.message).toMatch(/batch ops\[0\]: file is not accepted on an op/);
  });
});

describe('readFileKeyHeader', () => {
  it('accepts a key-shaped header and drops anything else', () => {
    expect(readFileKeyHeader(KEY_A)).toBe(KEY_A);
    expect(readFileKeyHeader([` ${KEY_A} `])).toBe(KEY_A);
    expect(readFileKeyHeader(undefined)).toBeNull();
    expect(readFileKeyHeader('../../etc')).toBeNull();
    expect(readFileKeyHeader('short')).toBeNull();
  });
});
