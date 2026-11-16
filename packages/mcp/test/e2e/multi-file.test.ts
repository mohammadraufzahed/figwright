import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

import { dispatchTargeted, resolveCallRoute, resolveRoutingSession } from '../../src/dispatch.js';
import { runWithCallRoute } from '../../src/routing/file-ref.js';
import { clearFileTarget, getFileTarget } from '../../src/routing/target.js';
import { GET_NODE_TOOL_NAME } from '../../src/tools/get-node.js';
import { LIST_FILES_TOOL_NAME } from '../../src/tools/list-files.js';
import {
  closeSocket,
  connectFakePlugin,
  type LeaderHarness,
  startLeader,
  stopLeader,
} from './_helpers.js';

const KEY_A = '4s7OY6WGaMYBol3BCjh1Zv';

const harnesses: LeaderHarness[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets) closeSocket(ws);
  sockets.length = 0;
  for (const h of harnesses) await stopLeader(h);
  harnesses.length = 0;
  clearFileTarget();
});

/** A plugin in file `name` that answers get_node with the file it lives in. */
const plugin = async (
  h: LeaderHarness,
  sessionId: string,
  name: string,
  headers?: Record<string, string>,
): Promise<WebSocket> => {
  const ws = await connectFakePlugin({
    port: h.port,
    sessionId,
    ...(headers === undefined ? {} : { headers }),
    handlers: {
      [LIST_FILES_TOOL_NAME]: () => ({
        files: [{ fileKey: null, fileName: name, currentPage: { id: '0:1', name: 'Page 1' } }],
      }),
      [GET_NODE_TOOL_NAME]: () => ({ answeredBy: name }),
    },
  });
  sockets.push(ws);
  return ws;
};

describe('per-call file routing over a real relay', () => {
  it('reads the file key the client stamps on the upgrade, and routes a link by it', async () => {
    const h = await startLeader();
    harnesses.push(h);
    await plugin(h, 'sess-a', 'Brand', { 'X-Figma-File-Key': KEY_A });
    await plugin(h, 'sess-b', 'Brand');
    const ctx = { node: h.node, follower: h.follower };

    const infos = h.node.getLeader()?.relay.listSessionInfo() ?? [];
    expect(infos.map(s => [s.id, s.fileKey])).toEqual(
      expect.arrayContaining([
        ['sess-a', KEY_A],
        ['sess-b', null],
      ]),
    );

    const byLink = await resolveCallRoute(
      ctx,
      `https://www.figma.com/design/${KEY_A}/Brand?node-id=5-2`,
    );
    expect(byLink).toMatchObject({ sessionId: 'sess-a', via: 'fileKey' });
    // Same name twice: only the key or the sessionId can tell them apart.
    await expect(resolveCallRoute(ctx, 'Brand')).rejects.toThrow(/matches 2 open files/);
  });

  it('serves concurrent calls to two files from the right plugin, without claiming', async () => {
    const h = await startLeader();
    harnesses.push(h);
    await plugin(h, 'sess-a', 'Brand');
    await plugin(h, 'sess-b', 'Marketing Site');
    const ctx = { node: h.node, follower: h.follower };

    const routedCalls = async (
      file: string,
    ): Promise<{ pinned: string | undefined; out: unknown[] }> => {
      const r = await resolveCallRoute(ctx, file);
      return runWithCallRoute(r, async () => ({
        pinned: await resolveRoutingSession(ctx),
        out: await Promise.all(
          Array.from({ length: 10 }, () =>
            dispatchTargeted(ctx, GET_NODE_TOOL_NAME, { nodeId: '1:2' }),
          ),
        ),
      }));
    };
    const [brand, marketing] = await Promise.all([
      routedCalls('brand'),
      routedCalls('Marketing Site'),
    ]);

    expect([brand.pinned, marketing.pinned]).toEqual(['sess-a', 'sess-b']);
    expect(new Set(brand.out.map(r => (r as { answeredBy: string }).answeredBy))).toEqual(
      new Set(['Brand']),
    );
    expect(new Set(marketing.out.map(r => (r as { answeredBy: string }).answeredBy))).toEqual(
      new Set(['Marketing Site']),
    );
    expect(getFileTarget()).toBeNull();
  });

  it('follows a panel reopened before the call was sent', async () => {
    const h = await startLeader();
    harnesses.push(h);
    const first = await plugin(h, 'sess-old', 'Brand');
    await plugin(h, 'sess-b', 'Marketing Site');
    const ctx = { node: h.node, follower: h.follower };
    const route = await resolveCallRoute(ctx, 'Brand');

    // A reopened panel is a new plugin run: new sessionId, same file.
    first.close(1000);
    const relay = h.node.getLeader()?.relay;
    await expect.poll(() => relay?.listSessionInfo().some(s => s.id === 'sess-old')).toBe(false);
    await plugin(h, 'sess-new', 'Brand');

    const answer = await runWithCallRoute(route, () =>
      dispatchTargeted(ctx, GET_NODE_TOOL_NAME, { nodeId: '1:2' }),
    );
    expect(answer).toEqual({ answeredBy: 'Brand' });
  });
});
