/**
 * The digest view behind its toggle (portal#79). Off, the served tool surface is today's and a call that asks for the
 * view is refused out loud; on, `view: "digest"` is a per-call choice and `fetch_message` serves what a digest cut.
 * These drive the real PortalAgent.handleToolCall with a client whose fetches are faked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '@animalabs/portal-client';
import type { PortalMessage } from '@animalabs/portal-protocol';
import { PortalAgent } from '../src/agent.js';
import { toolDefinitions } from '../src/tools.js';

const CHANNEL = '100000000000000003';
const NO_MENTIONS = { personas: [], roles: [], users: [], everyone: false };
let n = 0;
function msg(text: string, over: Partial<PortalMessage> = {}): PortalMessage {
  n++;
  return {
    id: `rel-${n}`, nativeId: `${5000 + n}`, channelId: CHANNEL, guildId: 'g1',
    author: { kind: 'user', userId: 'u1', username: 'ada', displayName: 'Ada', bot: false },
    content: text, cleanContent: text, attachments: [], mentions: NO_MENTIONS, reactions: [],
    createdAt: `2026-10-20T14:${String(n % 60).padStart(2, '0')}:00.000Z`, ...over,
  } as PortalMessage;
}
const words = (k: number): string => Array.from({ length: k }, (_, i) => `w${i + 1}`).join(' ');

function setup(opts: { digestView?: boolean } = {}, history: PortalMessage[] = []) {
  const client = new PortalClient({ url: 'ws://test', token: 't', personaId: 'persona-me' });
  const fetches: Array<Record<string, unknown>> = [];
  (client as unknown as { fetchHistory: unknown }).fetchHistory = async (p: Record<string, unknown>) => {
    fetches.push(p);
    return { messages: history };
  };
  const agent = new PortalAgent(client, { hostOwnsChannelLifecycle: true, ...opts });
  return { agent, fetches, history };
}
const served = (agent: PortalAgent, name: string) => agent.tools.find((t) => t.name === name);
function withEnv<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.PORTAL_DIGEST_VIEW;
  if (value === undefined) delete process.env.PORTAL_DIGEST_VIEW; else process.env.PORTAL_DIGEST_VIEW = value;
  try { return fn(); } finally { if (saved === undefined) delete process.env.PORTAL_DIGEST_VIEW; else process.env.PORTAL_DIGEST_VIEW = saved; }
}

// ── off (the default): today's surface ──

test('off by default: no fetch_message in the served tools, and neither fetch tool offers view or words', () => {
  withEnv(undefined, () => {
    const { agent } = setup();
    assert.equal(served(agent, 'fetch_message'), undefined);
    for (const name of ['fetch_history', 'fetch_around']) {
      const props = served(agent, name)!.inputSchema.properties;
      assert.ok(!('view' in props) && !('words' in props), `${name} offers a digest property while off`);
    }
  });
});

test('off: the two fetch tools are served exactly as the static definitions have them', () => {
  withEnv(undefined, () => {
    const { agent } = setup();
    for (const name of ['fetch_history', 'fetch_around']) {
      assert.deepEqual(served(agent, name), toolDefinitions.find((t) => t.name === name));
    }
  });
});

test('off: a call that passes view is refused before anything is fetched, and says how to turn it on', async () => {
  await withEnv(undefined, async () => {
    const { agent, fetches } = setup({}, [msg('hi')]);
    for (const tool of ['fetch_history', 'fetch_around']) {
      await assert.rejects(
        agent.handleToolCall(tool, { channelId: CHANNEL, messageId: 'rel-1', view: 'digest' }),
        /digest view is not enabled on this server[\s\S]*PORTAL_DIGEST_VIEW/,
      );
    }
    assert.equal(fetches.length, 0, 'nothing was fetched for a refused call');
  });
});

test('off: even view "full" is refused, so an agent never believes it is getting a view the server does not have', async () => {
  await withEnv(undefined, async () => {
    const { agent, fetches } = setup();
    await assert.rejects(agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'full' }), /not enabled/);
    await assert.rejects(agent.handleToolCall('fetch_history', { channelId: CHANNEL, words: 10 }), /not enabled/);
    assert.equal(fetches.length, 0);
  });
});

test('off: fetch_message is refused with the same explanation', async () => {
  await withEnv(undefined, async () => {
    const { agent } = setup();
    await assert.rejects(agent.handleToolCall('fetch_message', { messageId: 'rel-1' }), /fetch_message[\s\S]*not enabled[\s\S]*PORTAL_DIGEST_VIEW/);
  });
});

test('off: fetch_history and fetch_around return the relay\'s messages untouched, as before', async () => {
  await withEnv(undefined, async () => {
    const history = [msg(words(100)), msg('short')];
    const { agent } = setup({}, history);
    assert.deepEqual(await agent.handleToolCall('fetch_history', { channelId: CHANNEL }), { messages: history });
    const around = (await agent.handleToolCall('fetch_around', { channelId: CHANNEL, messageId: 'rel-1' })) as { messages: PortalMessage[] };
    assert.ok(Array.isArray(around.messages));
  });
});

// ── on ──

test('on: view and words are offered, with view limited to full and digest, and fetch_message is served', () => {
  const { agent } = setup({ digestView: true });
  for (const name of ['fetch_history', 'fetch_around']) {
    const props = served(agent, name)!.inputSchema.properties as Record<string, { enum?: string[]; type?: string }>;
    assert.deepEqual(props.view!.enum, ['full', 'digest']);
    assert.equal(props.words!.type, 'number');
  }
  assert.deepEqual(served(agent, 'fetch_message')!.inputSchema.required, ['messageId']);
});

test('on: the channel and cursor properties the tools already had are all still there', () => {
  const { agent } = setup({ digestView: true });
  const was = (name: string) => Object.keys(toolDefinitions.find((t) => t.name === name)!.inputSchema.properties);
  for (const name of ['fetch_history', 'fetch_around']) {
    const now = Object.keys(served(agent, name)!.inputSchema.properties);
    for (const p of was(name)) assert.ok(now.includes(p), `${name} lost ${p}`);
    assert.deepEqual(served(agent, name)!.inputSchema.required, toolDefinitions.find((t) => t.name === name)!.inputSchema.required);
  }
});

test('on, but view not asked for: the result is the full messages, as today (the digest is per-call)', async () => {
  const history = [msg(words(100))];
  const { agent } = setup({ digestView: true }, history);
  assert.deepEqual(await agent.handleToolCall('fetch_history', { channelId: CHANNEL }), { messages: history });
  assert.deepEqual(await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'full' }), { messages: history });
});

test('on: view "digest" returns one line per message, a note, and asks the relay for the same page it always did', async () => {
  const history = [msg(words(60)), msg('short one')];
  const { agent, fetches } = setup({ digestView: true }, history);
  const out = (await agent.handleToolCall('fetch_history', { channelId: CHANNEL, limit: 2, view: 'digest', words: 10 })) as {
    view: string; count: number; note: string; lines: string[];
  };
  assert.equal(out.view, 'digest');
  assert.equal(out.count, 2);
  assert.equal(out.lines.length, 2);
  assert.ok(out.lines[0]!.includes('… (+50 words, full: '), out.lines[0]);
  assert.ok(out.lines[1]!.endsWith(': short one'));
  assert.match(out.note, /fetch_message/);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0]!.limit, 2, 'the page size is the caller\'s, not changed by the view');
  assert.ok(!('view' in fetches[0]!) && !('words' in fetches[0]!), 'the relay is not sent a view it does not know');
});

test('on: the digest knows the agent\'s own persona, so a message that mentions it comes back whole', async () => {
  const history = [msg(words(80), { mentions: { ...NO_MENTIONS, personas: ['persona-me'] } }), msg(words(80))];
  const { agent } = setup({ digestView: true }, history);
  const out = (await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 5 })) as { lines: string[] };
  const [a, b] = out.lines.slice().sort((x, y) => x.localeCompare(y));
  const whole = out.lines.find((l) => l.includes('★mentions-you'))!;
  assert.ok(whole.endsWith('w80'));
  assert.ok(out.lines.some((l) => l.includes('… (+75 words')), `${a} / ${b}`);
});

test('on: fetch_around digests the window it already builds, merged and sorted', async () => {
  const history = [msg(words(40)), msg('x')];
  const { agent } = setup({ digestView: true }, history);
  const out = (await agent.handleToolCall('fetch_around', { channelId: CHANNEL, messageId: 'rel-1', view: 'digest', words: 5 })) as { lines: string[]; count: number };
  assert.ok(out.count >= 1 && out.lines.length === out.count);
  assert.ok(out.lines.every((l) => /^#\d+ /.test(l)));
});

test('on: fetch_message returns the whole message a digest cut, by relay id and by snowflake', async () => {
  const long = msg(words(90));
  const { agent } = setup({ digestView: true }, [long]);
  await agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 5 });
  assert.deepEqual(await agent.handleToolCall('fetch_message', { messageId: long.id }), { message: long });
  assert.deepEqual(await agent.handleToolCall('fetch_message', { messageId: long.nativeId }), { message: long });
});

test('on: fetch_message for an id no digest showed says why and what to do, and does not guess', async () => {
  const { agent } = setup({ digestView: true });
  await assert.rejects(
    agent.handleToolCall('fetch_message', { messageId: 'rel-unknown' }),
    /isn't in this server's digest cache[\s\S]*500[\s\S]*restart[\s\S]*fetch_history/,
  );
});

test('on: a view other than full or digest, or words without the digest, is refused before anything is fetched', async () => {
  const { agent, fetches } = setup({ digestView: true }, [msg('hi')]);
  await assert.rejects(agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'brief' }), /view must be "full" or "digest"/);
  await assert.rejects(agent.handleToolCall('fetch_history', { channelId: CHANNEL, words: 10 }), /words only applies to view "digest"/);
  await assert.rejects(agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 0 }), /words/);
  await assert.rejects(agent.handleToolCall('fetch_history', { channelId: CHANNEL, view: 'digest', words: 'ten' }), /words/);
  assert.equal(fetches.length, 0);
});

// ── the toggle itself ──

test('PORTAL_DIGEST_VIEW turns it on at the server (1 or true); anything else leaves it off', () => {
  for (const [value, on] of [['1', true], ['true', true], ['0', false], ['', false], ['yes', false], [undefined, false]] as const) {
    withEnv(value, () => assert.equal(setup().agent.tools.some((t) => t.name === 'fetch_message'), on, `PORTAL_DIGEST_VIEW=${String(value)}`));
  }
});

test('an explicit option beats the environment, both ways', () => {
  withEnv('1', () => assert.equal(setup({ digestView: false }).agent.tools.some((t) => t.name === 'fetch_message'), false));
  withEnv(undefined, () => assert.equal(setup({ digestView: true }).agent.tools.some((t) => t.name === 'fetch_message'), true));
});

test('the host-owned-channels filter still applies with the digest on', () => {
  const { agent } = setup({ digestView: true });
  assert.equal(served(agent, 'subscribe_channel'), undefined);
  assert.ok(served(agent, 'fetch_history') && served(agent, 'send_message'));
});
