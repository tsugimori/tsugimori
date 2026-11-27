import type { OutboundMessage } from '@tsugimori/plugin-sdk';

import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

import type { LineText } from './api.ts';

import { nonempty, record } from './api.ts';

export const maxQuickReplies = 13;
const maxPrompts = 4096;
const retentionMs = 48 * 60 * 60_000;
const promptKey = /^[a-f0-9]{24}$/;
const dataPrefix = 'tsm:';

interface Prompt {
  chatId: string;
  ids: string[];
  messageId: string;
  sentAt: number;
}

const graphemes = new Intl.Segmenter();

function clip(text: string, max: number) {
  if (text.length <= max) return text;
  let end = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    if (index + segment.length >= max) break;
    end = index + segment.length;
  }
  return text.slice(0, end) + '…';
}

export function quickReplies(buttons: NonNullable<OutboundMessage['buttons']>) {
  if (buttons.length > maxQuickReplies)
    throw new Error(`LINE supports up to ${maxQuickReplies} quick replies`);
  const key = randomBytes(12).toString('hex');
  const ids: string[] = [];
  const quickReply: NonNullable<LineText['quickReply']> = {
    items: buttons.map(({ id, label }) => {
      const data = `${dataPrefix}${key}:${id}`;
      if (!id || data.length > 300)
        throw new Error('Invalid LINE postback data length');
      ids.push(id);
      const text = label.trim() || id;
      return {
        type: 'action',
        action: {
          type: 'postback',
          data,
          label: clip(text, 20),
          displayText: clip(text, 300),
        },
      };
    }),
  };
  return { ids, key, quickReply };
}

export function parsePostback(data: string) {
  if (!data.startsWith(dataPrefix) || data.length > 300) return;
  const end = data.indexOf(':', dataPrefix.length);
  if (end < 0) return;
  const key = data.slice(dataPrefix.length, end);
  const callbackId = data.slice(end + 1);
  if (promptKey.test(key) && callbackId) return { callbackId, key };
}

export class LinePostbacks {
  readonly #path: string;
  readonly #now: () => number;
  readonly #prompts = new Map<string, Prompt>();
  #writes = Promise.resolve();

  constructor(path: string, now: () => number) {
    this.#path = path;
    this.#now = now;
  }

  async start() {
    const contents = await readFile(this.#path, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return '{}';
      },
    );
    const entries = record(JSON.parse(contents));
    if (!entries) throw new Error('Invalid LINE postback state');
    this.#prompts.clear();
    for (const [key, value] of Object.entries(entries)) {
      const entry = record(value);
      const chatId = nonempty(entry?.chatId);
      const messageId = nonempty(entry?.messageId);
      const sentAt = entry?.sentAt;
      const ids: unknown = entry?.ids;
      if (
        promptKey.test(key) &&
        chatId &&
        messageId &&
        typeof sentAt === 'number' &&
        Number.isSafeInteger(sentAt) &&
        Array.isArray(ids) &&
        ids.length <= maxQuickReplies &&
        ids.every((id): id is string => typeof id === 'string' && !!id)
      )
        this.#prompts.set(key, { chatId, ids, messageId, sentAt });
    }
    this.#prune();
  }

  messageId(key: string, chatId: string, callbackId: string) {
    const prompt = this.#prompts.get(key);
    if (
      prompt?.chatId === chatId &&
      this.#now() - prompt.sentAt < retentionMs &&
      prompt.ids.includes(callbackId)
    )
      return prompt.messageId;
  }

  remember(key: string, chatId: string, messageId: string, ids: string[]) {
    this.#prompts.set(key, { chatId, ids, messageId, sentAt: this.#now() });
    this.#prune();
    const write = this.#writes.then(async () => {
      const temporary = this.#path + '.' + randomUUID();
      try {
        await writeFile(
          temporary,
          JSON.stringify(Object.fromEntries(this.#prompts)),
          {
            mode: 0o600,
          },
        );
        await rename(temporary, this.#path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    });
    // The caller reports write failures. Later sends can still persist state.
    this.#writes = write.catch(() => undefined);
    return write;
  }

  flush() {
    return this.#writes;
  }

  #prune() {
    const now = this.#now();
    for (const [key, { sentAt }] of this.#prompts) {
      if (this.#prompts.size <= maxPrompts && now - sentAt < retentionMs) break;
      this.#prompts.delete(key);
    }
  }
}
