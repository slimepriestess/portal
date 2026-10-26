/**
 * The digest view of fetched history (portal#79): one line per message instead of the whole object, rendered here
 * from the full messages the relay already returned. It saves the agent's context, not relay bandwidth, and it is
 * off unless the server turns it on (agent.ts, PORTAL_DIGEST_VIEW).
 *
 * Two rules keep a digest honest. A line that was cut says how much, and which message holds the rest, so it is never
 * mistaken for the whole message. And a message the agent most needs whole comes back whole: one addressed to it, and
 * the message an addressed message replies to.
 *
 * "Addressed to it" is derived from what a history message carries. The relay works out addressedToMe only for live
 * events, so here it is: the message mentions this persona (mentions.personas), or replies to a message in the same
 * batch that this persona wrote. A name typed in the text without a mention, a role mention the relay did not resolve to
 * this persona, and a reply to a message outside the batch are not seen.
 */
import type { PortalMessage } from '@animalabs/portal-protocol';

export const DEFAULT_DIGEST_WORDS = 30;
export const MAX_DIGEST_WORDS = 500;
export const DEFAULT_DIGEST_CACHE = 500;

export interface DigestOptions {
  /** Words kept of each cut message (default 30, 1 to 500). */
  words?: number;
  /** This agent's own persona id: what "addressed to me" means. */
  selfPersonaId?: string;
}

export interface DigestResult {
  lines: string[];
  /** The messages in digest order (oldest first), so a caller can cache what the lines stand for. */
  ordered: PortalMessage[];
}

/** The digest limit as a checked integer: a wrong value is refused, never clamped to something the caller did not ask for. */
export function checkedWords(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DIGEST_WORDS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIGEST_WORDS) {
    throw new Error(`Nothing ran: words must be a whole number from 1 to ${MAX_DIGEST_WORDS}, got ${JSON.stringify(value)}.`);
  }
  return value;
}

const when = (m: PortalMessage): string => m.createdAt.slice(5, 16).replace('T', ' ');

function who(m: PortalMessage): string {
  const a = m.author;
  if (a.kind === 'persona') return `${a.displayName}[persona]`;
  if (a.kind === 'user') return `${a.displayName || a.username}${a.bot ? '[bot]' : ''}`;
  return 'system';
}

/** A custom emoji arrives as `name:id`; the id is dropped so its count never runs into digits. */
function emojiLabel(emoji: string): string {
  const custom = /^(.+):\d+$/.exec(emoji);
  return custom ? `:${custom[1]}:` : emoji;
}

export function digestMessages(messages: readonly PortalMessage[], opts: DigestOptions = {}): DigestResult {
  const limit = checkedWords(opts.words);
  const ordered = [...messages].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const ordinal = new Map(ordered.map((m, i) => [m.id, i + 1] as const));
  const byId = new Map(ordered.map((m) => [m.id, m] as const));
  const self = opts.selfPersonaId;

  const addressed = new Set<string>();
  if (self !== undefined) {
    for (const m of ordered) {
      const parent = m.replyToId ? byId.get(m.replyToId) : undefined;
      const repliesToMe = parent !== undefined && parent.author.kind === 'persona' && parent.author.personaId === self;
      if (m.mentions.personas.includes(self) || repliesToMe) addressed.add(m.id);
    }
  }
  // The message an addressed message answers is read with it, so the question stays beside the ping.
  const repliedTo = new Set<string>();
  for (const id of addressed) {
    const replyToId = byId.get(id)?.replyToId;
    if (replyToId !== undefined && byId.has(replyToId) && !addressed.has(replyToId)) repliedTo.add(replyToId);
  }

  const lines = ordered.map((m, i) => {
    const text = (m.cleanContent ?? m.content ?? '').trim().replace(/\s+/g, ' ');
    const all = text === '' ? [] : text.split(' ');
    const whole = addressed.has(m.id) || repliedTo.has(m.id);
    const body = whole || all.length <= limit ? text : `${all.slice(0, limit).join(' ')}… (+${all.length - limit} words, full: ${m.nativeId})`;
    const reply = m.replyToId ? ` ↩${ordinal.has(m.replyToId) ? `#${ordinal.get(m.replyToId)}` : '(not in batch)'}` : '';
    const reactions = m.reactions.map((r) => ` ${emojiLabel(r.emoji)}${r.count}`).join('');
    const attached = m.attachments.length > 0 ? ` 📎${m.attachments.length}` : '';
    const mark = addressed.has(m.id) ? ' ★mentions-you' : repliedTo.has(m.id) ? ' ★replied-to' : '';
    return `#${i + 1} ${when(m)} ${who(m)}${reply}${reactions}${attached}${mark}: ${body}`;
  });
  return { lines, ordered };
}

/**
 * The last messages a digest showed, by relay id and by snowflake, for `fetch_message`. Bounded: the newest `capacity`
 * stay and the oldest go. It lives in this process only, so a restart empties it and a miss says so.
 */
export class DigestCache {
  private readonly byId = new Map<string, PortalMessage>();
  private readonly nativeToId = new Map<string, string>();

  constructor(readonly capacity: number = DEFAULT_DIGEST_CACHE) {}

  get size(): number {
    return this.byId.size;
  }

  put(messages: readonly PortalMessage[]): void {
    for (const m of messages) {
      // Insertion order is recency: a message shown again moves to the newest end.
      this.byId.delete(m.id);
      this.byId.set(m.id, m);
      this.nativeToId.set(m.nativeId, m.id);
    }
    while (this.byId.size > this.capacity) {
      const oldest = this.byId.keys().next().value as string;
      const gone = this.byId.get(oldest)!;
      this.byId.delete(oldest);
      this.nativeToId.delete(gone.nativeId);
    }
  }

  get(ref: string): PortalMessage | undefined {
    return this.byId.get(ref) ?? this.byId.get(this.nativeToId.get(ref) ?? '');
  }
}
