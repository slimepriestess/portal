import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PortalMessage } from '@animalabs/portal-protocol';
import { digestMessages, DigestCache, RecentIds, DEFAULT_DIGEST_WORDS, MAX_DIGEST_WORDS, DIGEST_CHARS_PER_WORD } from '../src/digest.js';

const ME = 'persona-me';
const NO_MENTIONS = { personas: [], roles: [], users: [], everyone: false };

let seq = 0;
function msg(over: Partial<PortalMessage> & { text?: string; at?: string; who?: PortalMessage['author'] } = {}): PortalMessage {
  const n = ++seq;
  const { text, at, who, ...rest } = over;
  return {
    id: `rel-${n}`,
    nativeId: `${1000 + n}`,
    channelId: 'c1',
    guildId: 'g1',
    author: who ?? { kind: 'user', userId: 'u1', username: 'ada', displayName: 'Ada', bot: false },
    content: text ?? `message ${n}`,
    cleanContent: text ?? `message ${n}`,
    attachments: [],
    mentions: NO_MENTIONS,
    reactions: [],
    createdAt: at ?? `2026-10-20T14:${String(n % 60).padStart(2, '0')}:00.000Z`,
    ...rest,
  } as PortalMessage;
}
const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i + 1}`).join(' ');
const persona = (id: string, displayName: string): PortalMessage['author'] => ({ kind: 'persona', personaId: id, displayName, avatarUrl: '' });

test('a line is: ordinal, time, author, then the text', () => {
  const m = msg({ text: 'hello there', at: '2026-10-20T14:09:30.000Z' });
  const { lines } = digestMessages([m], { selfPersonaId: ME });
  assert.deepEqual(lines, ['#1 10-20 14:09 Ada: hello there']);
});

test('author kinds: a persona and a bot are tagged, a human is not', () => {
  const lines = digestMessages([
    msg({ who: persona('p2', 'hesperus'), at: '2026-10-20T14:01:00.000Z' }),
    msg({ who: { kind: 'user', userId: 'u9', username: 'rb', displayName: 'RB', bot: true }, at: '2026-10-20T14:02:00.000Z' }),
    msg({ at: '2026-10-20T14:03:00.000Z' }),
  ], { selfPersonaId: ME }).lines;
  assert.match(lines[0]!, /^#1 10-20 14:01 hesperus\[persona\]:/);
  assert.match(lines[1]!, /^#2 10-20 14:02 RB\[bot\]:/);
  assert.match(lines[2]!, /^#3 10-20 14:03 Ada:/);
});

test('messages are numbered oldest first whatever order they arrive in', () => {
  const late = msg({ text: 'second', at: '2026-10-20T15:00:00.000Z' });
  const early = msg({ text: 'first', at: '2026-10-20T14:00:00.000Z' });
  const { lines } = digestMessages([late, early], { selfPersonaId: ME });
  assert.match(lines[0]!, /^#1 .*: first$/);
  assert.match(lines[1]!, /^#2 .*: second$/);
});

test('a cut line says how much was cut and which message holds the rest', () => {
  const m = msg({ text: words(41) });
  const { lines } = digestMessages([m], { words: 30, selfPersonaId: ME });
  assert.equal(lines[0]!.endsWith(`${words(30)}… (+11 words, full: ${m.id})`), true, lines[0]);
});

test('exactly the word limit is whole and one more is cut (the boundary)', () => {
  const at = digestMessages([msg({ text: words(30) })], { words: 30, selfPersonaId: ME }).lines[0]!;
  assert.ok(!at.includes('…') && at.endsWith('w30'), at);
  const over = digestMessages([msg({ text: words(31) })], { words: 30, selfPersonaId: ME }).lines[0]!;
  assert.match(over, /w30… \(\+1 words, full: rel-\d+\)$/);
});

test('whitespace and newlines inside a message collapse to single spaces, so a line is one line', () => {
  const { lines } = digestMessages([msg({ text: 'a\n\n  b\t\tc\nd' })], { selfPersonaId: ME });
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.endsWith(': a b c d'), lines[0]);
});

test('the text is the readable one (cleanContent), not the raw one with <@ids>', () => {
  const m = msg({ content: 'hi <@&123> and <#456>', cleanContent: 'hi @Lark and #general' } as never);
  assert.ok(digestMessages([m], { selfPersonaId: ME }).lines[0]!.endsWith(': hi @Lark and #general'));
});

test('a reply points at the ordinal of what it answers, or says it is not in the batch', () => {
  const a = msg({ text: 'question', at: '2026-10-20T14:00:00.000Z' });
  const b = msg({ text: 'answer', at: '2026-10-20T14:01:00.000Z', replyToId: a.id });
  const c = msg({ text: 'stray', at: '2026-10-20T14:02:00.000Z', replyToId: 'rel-elsewhere' });
  const { lines } = digestMessages([a, b, c], { selfPersonaId: ME });
  assert.match(lines[1]!, /^#2 10-20 14:01 Ada ↩#1: answer$/);
  assert.match(lines[2]!, /^#3 10-20 14:02 Ada ↩\(not in batch\): stray$/);
});

test('reactions show as emoji and count, attachments as a count', () => {
  const m = msg({
    text: 'look',
    reactions: [{ emoji: '👍', count: 2, kind: 'native', by: [] }, { emoji: 'party:99', count: 1, kind: 'native', by: [] }],
    attachments: [{ id: 'a', name: 'x.png', url: 'u', contentType: null, size: 1 }],
  });
  // A custom emoji is `name:id` on the wire; the id is dropped and its count never runs into digits.
  assert.equal(digestMessages([m], { selfPersonaId: ME }).lines[0], '#1 ' + m.createdAt.slice(5, 16).replace('T', ' ') + ' Ada 👍2 :party:1 📎1: look');
});

test('a message that mentions the caller comes back whole, marked, however long', () => {
  const m = msg({ text: words(80), mentions: { ...NO_MENTIONS, personas: [ME] } });
  const line = digestMessages([m], { words: 5, selfPersonaId: ME }).lines[0]!;
  assert.ok(line.includes('★to-you'), line);
  assert.ok(line.endsWith('w80') && !line.includes('…'), line);
});

test('every result carries the relay id of each message, in line order: an agent acts on a message by it', () => {
  const late = msg({ text: 'second', at: '2026-10-20T15:00:00.000Z' });
  const early = msg({ text: 'first', at: '2026-10-20T14:00:00.000Z' });
  const { lines, ids } = digestMessages([late, early], { selfPersonaId: ME });
  assert.deepEqual(ids, [early.id, late.id]);
  assert.equal(ids.length, lines.length);
});

test('a cut line names the RELAY id (what react, reply, edit and the cursors take), not the snowflake', () => {
  const m = msg({ text: words(40) });
  const line = digestMessages([m], { words: 5, selfPersonaId: ME }).lines[0]!;
  assert.ok(line.includes(`full: ${m.id})`) && !line.includes(m.nativeId), line);
});

test('what the persona wrote is never addressed to it, not even a reply to its own earlier message', () => {
  const first = msg({ text: 'my first', who: persona(ME, 'me'), at: '2026-10-20T14:00:00.000Z' });
  const follow = msg({ text: words(60), who: persona(ME, 'me'), at: '2026-10-20T14:01:00.000Z', replyToId: first.id, mentions: { ...NO_MENTIONS, personas: [ME] } });
  const { lines } = digestMessages([first, follow], { words: 5, selfPersonaId: ME });
  assert.ok(!lines[1]!.includes('★'), lines[1]);
  assert.ok(lines[1]!.includes('… (+55 words'), lines[1]);
});

test('a reply to a message this persona wrote that is NOT in the batch counts, when its id is known', () => {
  const known = new RecentIds();
  known.add('rm_old_post');
  const reply = msg({ text: words(60), replyToId: 'rm_old_post' });
  const stranger = msg({ text: words(60), replyToId: 'rm_someone_elses' });
  const { lines } = digestMessages([reply, stranger], { words: 5, selfPersonaId: ME, ownMessageIds: known });
  const [a, b] = [lines.find((l) => l.includes('rm_old_post') || l.includes('★to-you')), lines.find((l) => !l.includes('★'))];
  assert.ok(a!.includes('★to-you') && a!.endsWith('w60'), a);
  assert.ok(b!.includes('… (+55 words'), b);
});

test('without the ids, the same reply is cut: a parent outside the batch is not seen', () => {
  const reply = msg({ text: words(60), replyToId: 'rm_old_post' });
  assert.ok(digestMessages([reply], { words: 5, selfPersonaId: ME }).lines[0]!.includes('… (+55 words'));
});

test('text with no spaces is bounded too: a long CJK line or a URL is cut by characters, and the marker says chars', () => {
  const cjk = '日本語'.repeat(400);
  const url = `https://example.com/${'a'.repeat(2000)}`;
  const lines = digestMessages([msg({ text: cjk, at: '2026-10-20T14:00:00.000Z' }), msg({ text: url, at: '2026-10-20T14:01:00.000Z' })], { words: 10, selfPersonaId: ME }).lines;
  const cap = 10 * DIGEST_CHARS_PER_WORD;
  assert.match(lines[0]!, new RegExp(`… \\(\\+${cjk.length - cap} chars, full: rel-\\d+\\)$`));
  assert.ok(lines[0]!.includes(cjk.slice(0, cap)) && !lines[0]!.includes(cjk.slice(0, cap + 1)));
  assert.match(lines[1]!, /… \(\+\d+ chars, full: rel-\d+\)$/);
  assert.ok(lines[1]!.length < url.length / 4, 'the line is far shorter than the text');
});

test('ordinary prose is still cut by words, and a short message is whole', () => {
  const lines = digestMessages([msg({ text: words(40) }), msg({ text: 'ok' })], { words: 10, selfPersonaId: ME }).lines.join('\n');
  assert.ok(lines.includes('(+30 words') && !lines.includes('chars'), lines);
});

test('a message addressed to the caller is whole even if it has no spaces and is very long', () => {
  const m = msg({ text: 'x'.repeat(3000), mentions: { ...NO_MENTIONS, personas: [ME] } });
  assert.ok(digestMessages([m], { words: 5, selfPersonaId: ME }).lines[0]!.endsWith('x'.repeat(3000)));
});

test('a mention of someone else is cut like any other message', () => {
  const m = msg({ text: words(80), mentions: { ...NO_MENTIONS, personas: ['someone-else'] } });
  const line = digestMessages([m], { words: 5, selfPersonaId: ME }).lines[0]!;
  assert.ok(!line.includes('★') && line.includes('… (+75 words'), line);
});

test('a reply to the caller\'s own message counts as addressed to the caller', () => {
  const mine = msg({ text: 'my earlier post', who: persona(ME, 'me'), at: '2026-10-20T14:00:00.000Z' });
  const reply = msg({ text: words(60), at: '2026-10-20T14:01:00.000Z', replyToId: mine.id });
  const line = digestMessages([mine, reply], { words: 5, selfPersonaId: ME }).lines[1]!;
  assert.ok(line.includes('★to-you') && line.endsWith('w60'), line);
});

test('the message an addressed message replies to comes back whole too, marked', () => {
  const target = msg({ text: words(50), at: '2026-10-20T14:00:00.000Z' });
  const addressed = msg({ text: 'ping', at: '2026-10-20T14:01:00.000Z', replyToId: target.id, mentions: { ...NO_MENTIONS, personas: [ME] } });
  const bystander = msg({ text: words(50), at: '2026-10-20T14:02:00.000Z' });
  const { lines } = digestMessages([target, addressed, bystander], { words: 5, selfPersonaId: ME });
  assert.ok(lines[0]!.includes('★replied-to') && lines[0]!.endsWith('w50'), lines[0]);
  assert.ok(lines[2]!.includes('… (+45 words'), 'a message nobody addressed is still cut');
});

test('a message that replies to someone else\'s unaddressed message pulls nothing whole', () => {
  const target = msg({ text: words(50), at: '2026-10-20T14:00:00.000Z' });
  const plain = msg({ text: 'ok', at: '2026-10-20T14:01:00.000Z', replyToId: target.id });
  assert.ok(digestMessages([target, plain], { words: 5, selfPersonaId: ME }).lines[0]!.includes('… (+45 words'));
});

test('without a persona id nothing is "mine": no message comes back whole by that rule', () => {
  const m = msg({ text: words(40), mentions: { ...NO_MENTIONS, personas: [ME] } });
  assert.ok(digestMessages([m], { words: 5 }).lines[0]!.includes('… (+35 words'));
});

test('the default is 30 words and the limit is bounded', () => {
  assert.equal(DEFAULT_DIGEST_WORDS, 30);
  assert.ok(digestMessages([msg({ text: words(31) })], { selfPersonaId: ME }).lines[0]!.includes('(+1 words'));
  assert.throws(() => digestMessages([msg()], { words: 0, selfPersonaId: ME }), /words/);
  assert.throws(() => digestMessages([msg()], { words: MAX_DIGEST_WORDS + 1, selfPersonaId: ME }), /words/);
  assert.throws(() => digestMessages([msg()], { words: 2.5, selfPersonaId: ME }), /words/);
  assert.doesNotThrow(() => digestMessages([msg()], { words: MAX_DIGEST_WORDS, selfPersonaId: ME }));
});

test('an empty batch is an empty digest', () => {
  assert.deepEqual(digestMessages([], { selfPersonaId: ME }).lines, []);
});

test('the digest is much smaller than the messages it stands for', () => {
  const ms = Array.from({ length: 8 }, (_, i) => msg({ text: words(120), at: `2026-10-20T14:0${i}:00.000Z`, reactions: [{ emoji: '👍', count: 1, kind: 'native', by: [] }] }));
  const full = JSON.stringify({ messages: ms }).length;
  const digest = digestMessages(ms, { selfPersonaId: ME }).lines.join('\n').length;
  assert.ok(digest * 5 < full, `digest ${digest} vs full ${full}`);
});

// ── the cache fetch_message reads ──

test('the cache returns a message by relay id or by snowflake', () => {
  const cache = new DigestCache(10);
  const m = msg();
  cache.put([m]);
  assert.equal(cache.get(m.id), m);
  assert.equal(cache.get(m.nativeId), m);
  assert.equal(cache.get('nope'), undefined);
});

/** The snowflake index is private; its size is what shows a leak, since a stale entry answers nothing. */
const nativeIndexSize = (cache: DigestCache): number => (cache as unknown as { nativeToId: Map<string, string> }).nativeToId.size;

test('the cache keeps the newest N and lets the oldest go, by both keys', () => {
  const cache = new DigestCache(3);
  const ms = Array.from({ length: 5 }, () => msg());
  cache.put(ms);
  assert.equal(cache.size, 3);
  assert.equal(cache.get(ms[0]!.id), undefined);
  assert.equal(cache.get(ms[0]!.nativeId), undefined);
  assert.equal(cache.get(ms[1]!.nativeId), undefined);
  for (const m of ms.slice(2)) assert.equal(cache.get(m.id), m);
  assert.equal(nativeIndexSize(cache), 3, 'the snowflake index forgets what was evicted, or it grows without bound');
});

test('putting a message again refreshes it instead of keeping a copy', () => {
  const cache = new DigestCache(2);
  const [a, b, c] = [msg(), msg(), msg()];
  cache.put([a, b]);
  cache.put([a]);
  cache.put([c]);
  assert.equal(cache.get(a.id), a, 'a was refreshed, so b is the one that goes');
  assert.equal(cache.get(b.id), undefined);
  assert.equal(cache.size, 2);
});

test('an edited message is refreshed in place, a deleted one is dropped, and one never shown is not added', () => {
  const cache = new DigestCache(5);
  const m = msg({ text: 'before' });
  cache.put([m]);
  const edited = { ...m, content: 'after', cleanContent: 'after' } as PortalMessage;
  cache.refresh(edited);
  assert.equal(cache.get(m.id)!.cleanContent, 'after');
  assert.equal(cache.get(m.nativeId)!.cleanContent, 'after');
  const never = msg({ text: 'x' });
  cache.refresh(never);
  assert.equal(cache.get(never.id), undefined);
  assert.equal(cache.size, 1);
  cache.drop(m.id);
  assert.equal(cache.get(m.id), undefined);
  assert.equal(cache.get(m.nativeId), undefined);
  assert.doesNotThrow(() => cache.drop('never-there'));
  assert.equal(nativeIndexSize(cache), 0, 'a dropped message leaves nothing behind in the snowflake index');
});

test('RecentIds keeps the newest N ids', () => {
  const r = new RecentIds(3);
  for (const id of ['a', 'b', 'c', 'd']) r.add(id);
  assert.equal(r.size, 3);
  assert.equal(r.has('a'), false);
  assert.ok(r.has('b') && r.has('c') && r.has('d'));
  r.add('b'); r.add('e');
  assert.ok(r.has('b') && !r.has('c'), 'adding again refreshes');
});

test('the default cache bound is the one the docs state', () => {
  assert.equal(new DigestCache().capacity, 500);
});
