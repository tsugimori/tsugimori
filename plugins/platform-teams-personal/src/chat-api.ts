import type { AdapterContext, OutboundMessage } from '@tsugimori/plugin-sdk';

import { SendFailure, ToolFailure } from '@tsugimori/plugin-sdk';
import { randomInt } from 'node:crypto';

import type { teamsPersonalSession } from './auth.ts';
import type { Uploaded } from './upload.ts';
import type { Data } from './wire.ts';

import { author, nativeQuote, quoteFreeText } from './inbound.ts';
import { escapeHtml, renderText, replySchema } from './text.ts';
import {
  chatKind,
  HttpError,
  messageId,
  object,
  readJson,
  request,
  string,
} from './wire.ts';

const origin = 'https://teams.live.com';
const conversationPath = '/v1/users/ME/conversations/';
const chatService = '/api/chatsvc/consumer';
const reactionKeys = new Map([
  ['👍', 'like'],
  ['❤', 'heart'],
  ['😆', 'laugh'],
  ['😮', 'surprised'],
  ['😢', 'sad'],
  ['😠', 'angry'],
  ['👎', 'no'],
  ['🙌', 'handsinair'],
  ['🔥', 'fire'],
  ['✋', 'highfive'],
  ['👊', 'fistbump'],
  ['✔', '2714_heavycheckmark'],
  ['👀', '1f440_eyes'],
]);

function messagePath(chat: string) {
  if (!chatKind(chat)) throw new Error('Invalid Teams conversation ID');
  return `${conversationPath}${encodeURIComponent(chat)}/messages`;
}

function messageUrl(chat: string, id?: string) {
  if (id !== undefined && !messageId(id))
    throw new Error('Invalid Teams message ID');
  return origin + chatService + messagePath(chat) + (id ? '/' + id : '');
}

function historyUrl(chat: string, next?: string) {
  const path = messagePath(chat);
  const base = origin + chatService + path;
  const url = new URL(
    next ?? '?startTime=0&pageSize=100&view=msnp24Equivalent',
    base,
  );
  const endpointPath = url.pathname.startsWith(chatService)
    ? url.pathname.slice(chatService.length)
    : url.pathname;
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !['teams.live.com', 'msgapi.teams.live.com'].includes(url.hostname) ||
    decodeURIComponent(endpointPath) !== decodeURIComponent(path)
  )
    throw new Error('Invalid Teams history page URL');
  return url;
}

function confirmedId(raw: Data) {
  return messageId(raw.OriginalArrivalTime) ?? messageId(raw.id);
}

export function chatApi(
  fetch: typeof globalThis.fetch,
  auth: ReturnType<typeof teamsPersonalSession>,
) {
  async function call(
    url: URL | string,
    signal: AbortSignal,
    method = 'GET',
    data?: Data,
  ) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const { token } = await auth.get();
      const response = await request(
        fetch,
        url,
        {
          method,
          headers: {
            Authentication: `skypetoken=${token}`,
            'Content-Type': 'application/json',
            'ms-ic3-product': 'tfl',
            'ms-ic3-additional-product': 'Sfl',
            'X-MS-Client-Consumer-Type': 'teams4life',
            BehaviorOverride: 'redirectAs404',
          },
          body: data && JSON.stringify(data),
        },
        signal,
      );
      if (response.ok) return response;
      await response.body?.cancel();
      if (response.status !== 401 || attempt > 0)
        throw new HttpError(response.status);
      // The server rejected authorization before executing this request.
      auth.invalidate(token);
    }
  }

  async function page(
    chat: string,
    next: string | undefined,
    signal: AbortSignal,
  ) {
    const url = historyUrl(chat, next);
    const data = await readJson(await call(url, signal));
    if (!Array.isArray(data.messages))
      throw new Error('Teams history returned no message list');
    const messages = data.messages.flatMap((value) => {
      const raw = object(value);
      if (!raw) return [];
      const returnedChat = raw.conversationid ?? raw.conversationId;
      if (returnedChat !== undefined && returnedChat !== chat)
        throw new Error('Teams history returned a different conversation');
      return [raw];
    });
    const backwardLink = string(object(data._metadata)?.backwardLink);
    return { messages, next: backwardLink && new URL(backwardLink, url).href };
  }

  async function getMessage(chat: string, id: string, signal: AbortSignal) {
    const raw = await readJson(await call(messageUrl(chat, id), signal));
    const returnedChat = raw.conversationid ?? raw.conversationId;
    if (
      messageId(raw.id) !== id ||
      (returnedChat !== undefined && returnedChat !== chat)
    )
      throw new Error('Teams returned a different message');
    return raw;
  }

  async function ownMessage(chat: string, id: string, signal: AbortSignal) {
    const { account } = await auth.get();
    const raw = await getMessage(chat, id, signal);
    if (author(raw) !== account)
      throw new Error('Teams can only modify its own messages');
    return raw;
  }

  return {
    page,
    async send(
      message: OutboundMessage,
      signal: AbortSignal,
      getUser?: AdapterContext['getUser'],
      media?: {
        kind: 'image' | 'file';
        upload(): Promise<readonly Uploaded[]>;
      },
    ) {
      const { chatId, replyTo } = message;
      const url = messageUrl(chatId);
      const { account, displayName } = await auth.get();
      const rendered = renderText(message, getUser, Boolean(media));
      if (replyTo) {
        const original = await getMessage(chatId, replyTo, signal);
        const sender = author(original);
        if (!sender) throw new Error('Teams reply target has no author');
        const label = escapeHtml(string(original.imdisplayname) ?? sender);
        const preview = escapeHtml(
          quoteFreeText(string(original.content) ?? '').slice(0, 150),
        );
        rendered.content =
          `<blockquote itemscope="" itemtype="${replySchema}" itemid="${replyTo}">` +
          `<strong itemprop="mri" itemid="${escapeHtml(sender)}">${label}</strong>` +
          `<span itemprop="time" itemid="${replyTo}"></span><p itemprop="preview">${preview}</p></blockquote>` +
          rendered.content;
        rendered.properties.qtdMsgs = JSON.stringify([
          { messageId: replyTo, sender, time: Number(replyTo) },
        ]);
      }
      let uploads: readonly Uploaded[] | undefined;
      if (media) {
        try {
          uploads = await media.upload();
        } catch (error) {
          signal.throwIfAborted();
          throw new SendFailure({ deliveryUnknown: false, parts: [] }, error);
        }
        rendered.content += uploads.map(({ html }) => html).join('');
      }
      const clientmessageid = String(
        BigInt(Date.now()) * 1_000_000n + BigInt(randomInt(1_000_000)),
      );
      let id: string | undefined;
      try {
        id = confirmedId(
          await readJson(
            await call(url, signal, 'POST', {
              ...rendered,
              clientmessageid,
              contenttype: media?.kind === 'image' ? 'Text' : 'text',
              imdisplayname: displayName,
              messagetype:
                media?.kind === 'file'
                  ? 'RichText/Media_GenericFile'
                  : 'RichText/Html',
              ...(uploads && { amsreferences: uploads.map(({ id }) => id) }),
            }),
            true,
          ),
        );
      } catch (error) {
        if (
          error instanceof HttpError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 409, 425, 429].includes(error.status)
        )
          throw new SendFailure({ deliveryUnknown: false, parts: [] }, error);
        // A timeout, response error or missing receipt can follow a committed write.
      }
      if (id) return { messageId: id };
      try {
        let next: string | undefined;
        for (let index = 0; index < 3; index++) {
          const history = await page(chatId, next, signal);
          id = messageId(
            history.messages.find(
              (raw) =>
                String(raw.clientmessageid) === clientmessageid &&
                author(raw) === account,
            )?.id,
          );
          if (id) return { messageId: id };
          if (!history.next) break;
          next = history.next;
        }
      } catch {
        throw unknownDelivery();
      }
      // Absence in a bounded history read does not establish that the write failed.
      throw unknownDelivery();
    },

    async deleteOwn(chat: string, id: string, signal: AbortSignal) {
      const original = await ownMessage(chat, id, signal);
      if (object(original.properties)?.deletetime) return;
      try {
        const response = await call(
          messageUrl(chat, id) + '?behavior=softDelete',
          signal,
          'DELETE',
        );
        await response.body?.cancel();
        return;
      } catch {
        // Reconcile an uncertain deletion by reading the target again.
      }
      try {
        const observed = await getMessage(chat, id, signal);
        if (object(observed.properties)?.deletetime) return;
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return;
        throw error;
      }
      throw new Error('Teams deletion could not be verified');
    },

    async editOwn(
      id: string,
      message: OutboundMessage,
      signal: AbortSignal,
      getUser?: AdapterContext['getUser'],
    ) {
      const chat = message.chatId;
      const original = await ownMessage(chat, id, signal);
      const originalProperties = object(original.properties);
      const content = string(original.content) ?? '';
      if (
        originalProperties?.deletetime ||
        !['Text', 'RichText/Html', 'RichText'].includes(
          String(original.messagetype),
        ) ||
        /<(?:img|URIObject)\b/iu.test(content) ||
        (Array.isArray(original.amsreferences) && original.amsreferences.length)
      )
        throw new Error('Teams can only edit active text messages');
      const rendered = renderText(message, getUser);
      rendered.content = (nativeQuote(content)?.quote ?? '') + rendered.content;
      if (originalProperties?.qtdMsgs !== undefined)
        Object.assign(rendered.properties, {
          qtdMsgs: originalProperties.qtdMsgs,
        });
      const { displayName } = await auth.get();
      try {
        const response = await call(messageUrl(chat, id), signal, 'PUT', {
          ...rendered,
          id,
          type: 'Message',
          conversationid: chat,
          messagetype: 'RichText/Html',
          contenttype: 'text',
          imdisplayname: string(original.imdisplayname) ?? displayName,
        });
        await response.body?.cancel();
        return;
      } catch {
        signal.throwIfAborted();
        // Reconcile an uncertain edit by reading the target again.
      }
      if ((await getMessage(chat, id, signal)).content !== rendered.content)
        throw new Error('Teams edit could not be verified');
    },

    async react(chat: string, id: string, emoji: string, signal: AbortSignal) {
      const key = reactionKeys.get(
        emoji.trim().replace(/[\uFE0E\uFE0F]/gu, ''),
      );
      if (!key) throw new ToolFailure('This emoji is unsupported by Teams');
      const response = await call(
        messageUrl(chat, id) + '/properties?name=emotions',
        signal,
        'PUT',
        { emotions: { key, value: Date.now() } },
      );
      await response.body?.cancel();
    },

    async typing(chat: string, signal: AbortSignal) {
      const response = await call(messageUrl(chat), signal, 'POST', {
        content: '',
        contenttype: 'Application/Message',
        messagetype: 'Control/Typing',
      });
      await response.body?.cancel();
    },
  };
}

function unknownDelivery() {
  return new SendFailure(
    { deliveryUnknown: true, parts: [] },
    new Error('Teams could not verify message delivery'),
  );
}
