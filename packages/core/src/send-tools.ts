import type {
  ChatRef,
  ExecScope,
  MediaDestination,
  MediaFile,
  PlatformAdapter,
  QueuedMedia,
  ToolContext,
  ToolDefinition,
} from '@tsugimori/plugin-sdk';
import type { Store } from '@tsugimori/storage';
import type { Tracer } from '@tsugimori/trace';
import type { FileHandle } from 'node:fs/promises';

import { ToolFailure } from '@tsugimori/plugin-sdk';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import type { Outbound } from './outbound.ts';

import { findAttachments } from './attachments.ts';
import { findFfmpeg, prepareImage } from './media.ts';

const string = { type: 'string', minLength: 1, maxLength: 1024 };
const id = { type: 'string', minLength: 1, maxLength: 512 };
const completeReply =
  ' If this completes your reply, finish with NO_REPLY: <short reason>. Add text only if it adds something.';
const properties = (
  properties: Record<string, unknown>,
  required: string[],
) => ({ type: 'object', properties, required, additionalProperties: false });
const attachmentSchema = properties(
  {
    messageId: id,
    index: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
  ['messageId', 'index'],
);
const uploadSchema = {
  ...properties({ path: string, attachment: attachmentSchema }, []),
  oneOf: [{ required: ['path'] }, { required: ['attachment'] }],
};
type Source =
  { attachment: { index: number; messageId: string } } | { path: string };

interface Dependencies {
  outbound: Outbound;
  scope(workdir: string): ExecScope;
  store: Store;
  trace: Tracer;
  workdir(chat: ChatRef): Promise<string>;
}

interface Round {
  address: MediaDestination;
  onDelivery(ids: readonly string[], error?: unknown): void;
  onQueued(handle: QueuedMedia, task: ToolContext): void;
  source: string;
}

export function sendTools(
  deps: Dependencies,
  adapter: PlatformAdapter,
  round?: Round,
) {
  const tools: ToolDefinition[] = [];
  const current = () => {
    if (!round)
      throw new ToolFailure('Media tools require an active chat task');
    return round;
  };
  const send = async (
    task: ToolContext,
    text: string,
    run: Parameters<Outbound['sendMedia']>[4],
  ) => {
    const { address, onDelivery, onQueued } = current();
    const result = await deps.outbound.sendMedia(
      adapter,
      { ...address, text },
      task.signal,
      task.taskId,
      run,
      onDelivery,
    );
    if ('queued' in result) {
      onQueued(result, task);
      return { queued: true };
    }
    return result;
  };
  if (adapter.capabilities.reactions && adapter.sendReaction) {
    const react = adapter.sendReaction.bind(adapter);
    tools.push({
      name: 'send.reaction',
      description:
        'React with a platform-supported emoji to a message in this chat. Omit messageId to react to the triggering message.' +
        completeReply,
      schema: properties(
        { emoji: { ...string, maxLength: 32 }, messageId: id },
        ['emoji'],
      ),
      async run(args, task) {
        const { address, source, onDelivery } = current();
        const { emoji, messageId = source } = args as {
          emoji: string;
          messageId?: string;
        };
        const chat = deps.store.resolveChat(task.chat);
        const target = deps.store.getMessage(chat, messageId, '');
        if (
          !target ||
          target.deleted ||
          target.threadId !== (address.threadId ?? null) ||
          deps.store.resolveChat({
            adapterId: adapter.id,
            chatId: address.chatId,
          }).chatId !== address.chatId
        )
          throw new ToolFailure(
            'Reaction target is unavailable in this conversation',
          );
        try {
          await deps.trace.span(
            'outbound.agent_reaction',
            { ...chat, taskId: task.taskId },
            () => react({ ...address, emoji, messageId }, task.signal),
          );
        } catch (error) {
          onDelivery([], error);
          throw error;
        }
        onDelivery([messageId]);
        return { messageId };
      },
    });
  }
  if (adapter.capabilities.stickers && adapter.sendSticker) {
    const sticker = adapter.sendSticker.bind(adapter);
    tools.push({
      name: 'send.sticker',
      description:
        'Send a sticker to this chat. Use fileId from sticker.search and include packageId when returned.' +
        completeReply,
      schema: properties({ fileId: id, packageId: id }, ['fileId']),
      run: (args, task) => {
        const { fileId, packageId } = args as {
          fileId: string;
          packageId?: string;
        };
        return send(task, '[sticker]', (address) =>
          sticker({ ...address, fileId, packageId }, task.signal),
        );
      },
    });
  }
  for (const kind of ['image', 'file'] as const) {
    const upload =
      kind === 'image'
        ? adapter.sendImage?.bind(adapter)
        : adapter.sendFile?.bind(adapter);
    const capability =
      kind === 'image'
        ? adapter.capabilities.images
        : adapter.capabilities.files;
    if (!capability || !upload) continue;
    tools.push({
      name: `send.${kind}`,
      description:
        `Send ${kind === 'image' ? 'an image' : adapter.kind === 'line' ? 'an MP4 video' : 'a file or MP4 video'} to this chat from a path in the chat workspace or an attachment reference from this chat. Provide exactly one source.` +
        completeReply,
      schema: uploadSchema,
      async run(args, task) {
        current();
        const file = await loadMedia(
          deps,
          adapter,
          args as Source,
          task,
          capability.maxBytes,
        );
        task.signal.throwIfAborted();
        return send(task, `[${kind}]`, (address) =>
          upload(
            {
              ...address,
              file,
              async preview(maxBytes) {
                const ffmpeg = await findFfmpeg();
                if (!ffmpeg)
                  throw new ToolFailure(
                    'ffmpeg is required to prepare this media preview',
                  );
                try {
                  const image = await prepareImage(
                    file.bytes,
                    {
                      index: 0,
                      kind: file.mime === 'video/mp4' ? 'video' : 'image',
                      mime: file.mime,
                    },
                    { maxBytes, maxEdge: 640 },
                    task.signal,
                    ffmpeg,
                  );
                  return {
                    bytes: Buffer.from(image.data, 'base64'),
                    mime: image.mime,
                  };
                } catch {
                  task.signal.throwIfAborted();
                  throw new ToolFailure('Could not prepare this media preview');
                }
              },
            },
            task.signal,
          ),
        );
      },
    });
  }
  return tools;
}

async function loadMedia(
  deps: Dependencies,
  adapter: PlatformAdapter,
  source: Source,
  { chat, signal }: ToolContext,
  limit: number,
): Promise<MediaFile> {
  const error = () =>
    new ToolFailure(
      `Media exceeds the platform's ${limit / 1024 ** 2} MB size limit`,
    );
  if ('attachment' in source) {
    const { index, messageId } = source.attachment;
    const items = findAttachments(
      deps.store,
      deps.store.resolveChat(chat),
      messageId,
    );
    const attachment = items.find(
      (item) => item.attachment.index === index,
    )?.attachment;
    if (!attachment)
      throw new ToolFailure('Attachment not found in this conversation');
    if (!attachment.fileId || !adapter.downloadAttachment)
      throw new ToolFailure(
        'The platform does not provide a download for this attachment',
      );
    if ((attachment.size ?? 0) > limit) throw error();
    const content = await adapter.downloadAttachment(attachment, signal, limit);
    if (content.bytes.byteLength > limit) throw error();
    return namedFile(
      content.bytes,
      attachment.name ?? 'attachment',
      content.mime ?? attachment.mime,
    );
  }
  const workdir = await deps.workdir(chat);
  const scope = deps.scope(workdir);
  return readWorkspaceMedia(scope, source.path, limit, signal, error);
}

const mediaTypes = new Map([
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'],
  ['.pdf', 'application/pdf'],
]);

function namedFile(bytes: Uint8Array, name: string, mime?: string): MediaFile {
  const extension = extname(name).toLowerCase();
  const isMp4 =
    bytes.length >= 12 &&
    Buffer.from(bytes.buffer, bytes.byteOffset + 4, 4).toString('ascii') ===
      'ftyp';
  return {
    bytes,
    name: basename(name).replace(/[\x00-\x1f\x7f]/g, '_') || 'attachment',
    mime: isMp4
      ? 'video/mp4'
      : mime && mime !== 'application/octet-stream'
        ? mime
        : mediaTypes.get(extension),
  };
}

function inside(root: string, path: string) {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep);
}

async function readWorkspaceMedia(
  scope: ExecScope,
  path: string,
  limit: number,
  signal: AbortSignal,
  limitError: () => ToolFailure,
) {
  const { workdir, denyRead } = scope;
  const target = resolve(workdir, path);
  const allowed = (root: string, candidate: string) =>
    candidate !== root &&
    inside(root, candidate) &&
    !denyRead.some((denied) => inside(denied, candidate)) &&
    !relative(root, candidate)
      .split(sep)
      .some((part) => part === '.env' || part === '.git');
  const unavailable = () =>
    new ToolFailure(
      'File is outside the accessible chat workspace or is unavailable',
    );
  if (
    path.includes('\0') ||
    /^[a-z][a-z\d+.-]*:\/\//i.test(path) ||
    !allowed(workdir, target)
  )
    throw unavailable();
  let file: FileHandle | undefined;
  try {
    signal.throwIfAborted();
    const root = await realpath(workdir);
    const real = await realpath(target);
    if (
      !allowed(root, real) ||
      real !== resolve(root, relative(workdir, target))
    )
      throw unavailable();
    file = await open(
      real,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    if (process.platform === 'linux') {
      // Verify the open inode after resolving the path to close the ancestor-symlink race.
      const opened = await realpath(`/proc/self/fd/${file.fd}`);
      if (opened !== real) throw unavailable();
    }
    const stats = await file.stat();
    if (!stats.isFile() || stats.nlink !== 1) throw unavailable();
    if (stats.size > limit) throw limitError();
    const bytes = Buffer.alloc(stats.size + 1);
    let size = 0;
    while (size < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(
        bytes,
        size,
        Math.min(64 * 1024, bytes.length - size),
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > stats.size)
      throw new ToolFailure('File changed while it was being read. Try again.');
    return namedFile(bytes.subarray(0, size), basename(target));
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ToolFailure) throw error;
    throw unavailable();
  } finally {
    await file?.close();
  }
}
