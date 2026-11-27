import type { AdapterContext, OutboundMessage } from '@tsugimori/plugin-sdk';

import { SendFailure } from '@tsugimori/plugin-sdk';
import { randomInt } from 'node:crypto';

import type { teamsSession } from './auth.ts';
import type { Data } from './wire.ts';

import { author, quoteFreeText } from './inbound.ts';
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

function messagePath(chat: string) {
  if (!chatKind(chat)) throw new Error('Invalid Teams conversation ID');
  return `${conversationPath}${encodeURIComponent(chat)}/messages`;
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
  auth: ReturnType<typeof teamsSession>,
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
    if (!messageId(id)) throw new Error('Invalid Teams message ID');
    const url = origin + chatService + messagePath(chat) + '/' + id;
    const raw = await readJson(await call(url, signal));
    const returnedChat = raw.conversationid ?? raw.conversationId;
    if (
      messageId(raw.id) !== id ||
      (returnedChat !== undefined && returnedChat !== chat)
    )
      throw new Error('Teams returned a different message');
    return raw;
  }

  return {
    page,
    async send(
      message: OutboundMessage,
      signal: AbortSignal,
      getUser?: AdapterContext['getUser'],
    ) {
      const { chatId, replyTo } = message;
      const url = origin + chatService + messagePath(chatId);
      const { account, displayName } = await auth.get();
      const rendered = renderText(message, getUser);
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
              contenttype: 'text',
              imdisplayname: displayName,
              messagetype: 'RichText/Html',
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
      const { account } = await auth.get();
      const original = await getMessage(chat, id, signal);
      if (author(original) !== account)
        throw new Error('Teams can only delete its own messages');
      if (object(original.properties)?.deletetime) return;
      try {
        const response = await call(
          origin +
            chatService +
            messagePath(chat) +
            `/${id}?behavior=softDelete`,
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
  };
}

function unknownDelivery() {
  return new SendFailure(
    { deliveryUnknown: true, parts: [] },
    new Error('Teams could not verify message delivery'),
  );
}
