import type { ChatRef, ContextBlock } from '@tsugimori/plugin-sdk';
import type { Store } from '@tsugimori/storage';

import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export interface SummaryProvider {
  get(
    chat: ChatRef,
  ): Promise<{ block?: ContextBlock; throughSeq: number } | undefined>;
}

const summaryBacklogLimit = 40;

const noSummary: SummaryProvider = {
  get: () => Promise.resolve(undefined),
};

export interface ContextRequest extends ChatRef {
  afterSeq?: number;
  kind: string;
  ownerId?: string;
  recentMessages: number;
  skipSeq?: readonly number[];
  throughSeq: number;
}

interface ContextDependencies {
  store: Pick<Store, 'recentMessages'>;
  summary?: SummaryProvider;
  workspace: string;
}

export function pathId(id: string) {
  if (id === '.') return '%2E';
  if (id === '..') return '%2E%2E';
  if (!id) throw new Error('Expected a non-empty workspace path identifier');
  return encodeURIComponent(id).replaceAll('%3A', ':');
}

function isMissing(error: unknown) {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

async function existsAtPath(path: string) {
  try {
    return (await realpath(path)) === path;
  } catch (error) {
    if (!isMissing(error)) throw error;
    return false;
  }
}

export class ContextAssembler {
  readonly #workspace: string;
  readonly #store: ContextDependencies['store'];
  readonly #summary: SummaryProvider;
  readonly #rules = new Map<string, { text: string; version: string }>();

  constructor({ workspace, store, summary = noSummary }: ContextDependencies) {
    this.#workspace = workspace;
    this.#store = store;
    this.#summary = summary;
  }

  async workdir(chat: ChatRef) {
    let path = await realpath(this.#workspace);
    for (const segment of [
      'chats',
      pathId(chat.adapterId),
      pathId(chat.chatId),
    ]) {
      path = join(path, segment);
      await mkdir(path, { recursive: true });
      if (!(await existsAtPath(path)))
        throw new Error('Conversation directory must be within its workspace');
    }
    return path;
  }

  async assemble(request: ContextRequest) {
    const blocks: ContextBlock[] = [];
    let afterSummarySeq: number | undefined;
    if (request.afterSeq === undefined) {
      blocks.push({
        source: 'system',
        trust: 'trusted',
        content:
          'Older conversation history is available in storage. Apply rules in specificity order: global, platform, then conversation.',
      });
      blocks.push(...(await this.#loadRules(request)));
      const summary = await this.#summary.get(request);
      if (summary && summary.throughSeq < request.throughSeq) {
        if (summary.block) blocks.push(summary.block);
        afterSummarySeq = summary.throughSeq;
      }
    }
    const messages = this.#store.recentMessages(request, {
      // Cap raw history while older unsummarized messages wait for a summary.
      limit:
        afterSummarySeq === undefined
          ? request.recentMessages
          : request.recentMessages + summaryBacklogLimit,
      throughSeq: request.throughSeq,
      afterSeq: request.afterSeq,
      afterSummarySeq,
      skipSeq: request.skipSeq,
    });
    for (const message of messages) {
      blocks.push({
        source: 'message',
        trust:
          message.userId !== null && message.userId === request.ownerId
            ? 'owner'
            : 'member',
        content: message.text,
      });
    }
    return blocks;
  }

  async #loadRules(request: ContextRequest) {
    const workspace = await realpath(this.#workspace);
    const chatRules = join(
      workspace,
      'chats',
      pathId(request.adapterId),
      pathId(request.chatId),
      'rules',
    );
    const global = join(workspace, 'rules', 'global.md');
    const platform = join(workspace, 'platforms', `${pathId(request.kind)}.md`);
    const blocks: ContextBlock[] = [];
    for (const path of [global, platform]) {
      const content = await this.#readRule(path);
      if (content !== undefined)
        blocks.push({ source: 'rule', trust: 'trusted', content });
    }
    if (await existsAtPath(chatRules)) {
      const entries = await readdir(chatRules, { withFileTypes: true }).catch(
        (error: unknown) => {
          if (!isMissing(error)) throw error;
          return [];
        },
      );
      const filenames = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name)
        .sort();
      for (const filename of filenames) {
        const content = await this.#readRule(join(chatRules, filename));
        if (content !== undefined)
          blocks.push({ source: 'rule', trust: 'member', content });
      }
    }
    return blocks;
  }

  async #readRule(path: string) {
    if (!(await existsAtPath(path))) {
      this.#rules.delete(path);
      return;
    }
    try {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat({ bigint: true });
        if (!stat.isFile()) return;
        const version = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}`;
        const cached = this.#rules.get(path);
        if (cached?.version === version) return cached.text;
        const text = await file.readFile('utf8');
        this.#rules.set(path, { version, text });
        return text;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.#rules.delete(path);
    }
  }
}
