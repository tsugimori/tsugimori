import type {
  ChatRef,
  ContextBlock,
  PlatformAdapter,
  TaskContextRef,
} from '@tsugimori/plugin-sdk';
import type { Store } from '@tsugimori/storage';

import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { messageAlbumLookup, messageContext } from './message.ts';

export {
  albumAttachments,
  messageAlbumLookup,
  messageContext,
} from './message.ts';

export interface SummaryProvider {
  get(chat: ChatRef): Promise<
    | {
        block?: ContextBlock;
        chatId?: string;
        revision?: number;
        throughSeq: number;
      }
    | undefined
  >;
}

const summaryBacklogLimit = 40;

const noSummary: SummaryProvider = {
  get: () => Promise.resolve(undefined),
};

export interface ContextRequest extends ChatRef {
  afterSeq?: number;
  botIdentity?: PlatformAdapter['botIdentity'];
  history?: 'none';
  incognitoId?: number;
  kind: string;
  ownerId?: string;
  recentMessages: number;
  richText?: boolean;
  skipSeq?: readonly number[];
  throughSeq: number;
}

interface ContextDependencies {
  store: Pick<Store, 'recentMessages'> & Partial<Pick<Store, 'messageAlbum'>>;
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
    (error.code === 'ENOENT' ||
      error.code === 'ENOTDIR' ||
      error.code === 'ELOOP')
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

export const privateGuidelineBlock: ContextBlock = {
  source: 'system',
  trust: 'trusted',
  content:
    'Workspace guideline files follow; AGENTS.md lists further guideline files that you can read with the guide.read tool when a task needs them. Apply rules in specificity order: workspace, platform, then conversation.\nAdd text after using a send tool only if it adds something to what you sent. A message sent with a session command is addressed to you. `mentionsYou` and `repliesToYou` mean it tags or replies to you; usually that is addressed to you, so do not skip it just because it names you, but judge from the text: if it only quotes you to talk to someone else, or tags you only to tell another person about you, it may not need your reply. If the latest message needs no reply or a send tool already delivered the whole reply, answer exactly `NO_REPLY: <short reason>` (one line, no other text).',
};

export const guidelineBlock: ContextBlock = {
  ...privateGuidelineBlock,
  content:
    'Older conversation history is available in storage. ' +
    privateGuidelineBlock.content,
};

export const telegramTableBlocks = {
  'telegram-tables-bullets': {
    source: 'system',
    trust: 'trusted',
    content:
      'Telegram shows Markdown tables as bullet lists; prefer short lists or sections over tables.',
  },
  'telegram-tables-rich': {
    source: 'system',
    trust: 'trusted',
    content:
      'Telegram renders Markdown tables natively; keep tables to 20 columns or fewer.',
  },
} satisfies Record<string, ContextBlock>;

function sanitizeBotName(name = '') {
  return Array.from(name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim())
    .slice(0, 64)
    .join('');
}

function platformIdentityBlock(
  identity: PlatformAdapter['botIdentity'],
): ContextBlock | undefined {
  const displayName = sanitizeBotName(identity?.displayName);
  const username = sanitizeBotName(identity?.username);
  if (!displayName && !username) return;
  const handle = username ? JSON.stringify(`@${username}`) : '';
  const name = displayName ? JSON.stringify(displayName) : handle;
  const suffix = displayName && handle ? ` (${handle})` : '';
  return {
    source: 'system',
    trust: 'trusted',
    content: `On this platform you are ${name}${suffix}. A mention of this name or a reply to your message refers to you.`,
  };
}

export function guidelineFileBlock(
  path: string,
  content: string,
): ContextBlock {
  const chat = path.startsWith('chats/');
  return {
    source: 'rule',
    trust: chat ? 'member' : 'trusted',
    content: `--- ${chat ? 'chat rules: ' + path.split('/').at(-1) : path} ---\n${content}`,
  };
}

type RuleEntry = {
  block: ContextBlock;
  content: string;
  kind: 'rule';
  path: string;
};

export type AssembledEntry =
  | RuleEntry
  | ({ block: ContextBlock } & (
      | Extract<TaskContextRef, { kind: 'system' }>
      | { chatId?: string; kind: 'summary'; revision?: number }
      | { kind: 'history' | 'new'; revision?: number; seq?: number }
    ));

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
    return (await this.assembleWithRefs(request)).map(({ block }) => block);
  }

  async assembleWithRefs(request: ContextRequest) {
    const entries: AssembledEntry[] = [];
    const { incognitoId } = request;
    let afterSummarySeq: number | undefined;
    if (request.afterSeq === undefined) {
      entries.push({
        kind: 'system',
        name: incognitoId === undefined ? 'guidelines' : 'private-guidelines',
        block:
          incognitoId === undefined ? guidelineBlock : privateGuidelineBlock,
      });
    }
    const identity = platformIdentityBlock(request.botIdentity);
    if (identity) entries.push({ kind: 'new', block: identity });
    if (request.kind === 'telegram') {
      const name = request.richText
        ? 'telegram-tables-rich'
        : 'telegram-tables-bullets';
      entries.push({ kind: 'system', name, block: telegramTableBlocks[name] });
    }
    if (request.afterSeq === undefined) {
      entries.push(...(await this.#loadRules(request)));
      const summary =
        request.history === 'none' || incognitoId !== undefined
          ? undefined
          : await this.#summary.get(request);
      if (summary && summary.throughSeq < request.throughSeq) {
        if (summary.block)
          entries.push({
            kind: 'summary',
            block: summary.block,
            revision: summary.revision,
            chatId: summary.chatId,
          });
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
      afterSeq:
        request.history === 'none' ? request.throughSeq - 1 : request.afterSeq,
      afterSummarySeq,
      skipSeq: request.skipSeq,
      includeRaw: false,
    });
    const album = this.#store.messageAlbum
      ? messageAlbumLookup(this.#store, request)
      : undefined;
    for (const message of messages) {
      entries.push({
        kind: message.seq === request.throughSeq ? 'new' : 'history',
        seq: message.seq,
        revision: message.revision,
        block: {
          source: 'message',
          trust:
            message.userId !== null && message.userId === request.ownerId
              ? 'owner'
              : 'member',
          content: message.text,
          message: messageContext(
            message,
            album,
            message.seq === request.throughSeq,
          ),
        },
      });
    }
    return entries;
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
    const blocks: RuleEntry[] = [];
    for (const path of [
      'AGENTS.md',
      'SOUL.md',
      'WORDING.md',
      'MEMORY.md',
      'rules/global.md',
      `platforms/${pathId(request.kind)}.md`,
    ]) {
      const content = await this.#readRule(join(workspace, path));
      if (content !== undefined)
        blocks.push({
          kind: 'rule',
          path,
          content,
          block: guidelineFileBlock(path, content),
        });
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
        if (content !== undefined) {
          const path = `chats/${pathId(request.adapterId)}/${pathId(request.chatId)}/rules/${filename}`;
          blocks.push({
            kind: 'rule',
            path,
            content,
            block: guidelineFileBlock(path, content),
          });
        }
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
