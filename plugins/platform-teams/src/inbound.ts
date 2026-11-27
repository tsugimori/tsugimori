import type { PlatformInboundEvent, ReplyTarget } from '@tsugimori/plugin-sdk';

import type { Data } from './wire.ts';

import { inboundMedia } from './attachments.ts';
import { attribute, plainText, replySchema } from './text.ts';
import { chatKind, messageId, mri, object, string } from './wire.ts';

export type Change = 'NewMessage' | 'MessageUpdate' | 'MessageRemoved';

function linkId(value: unknown, segment: string) {
  const part = string(value)?.split(`/${segment}/`)[1]?.split(/[/?#]/u)[0];
  if (!part) return;
  try {
    return decodeURIComponent(part);
  } catch {
    // Malformed resource links cannot identify a chat or user.
  }
}

export function author(raw: Data) {
  return (
    mri(raw.fromId) ??
    mri(raw.from) ??
    mri(linkId(raw.from, 'contacts')) ??
    mri(linkId(raw.fromId, 'contacts'))
  );
}

function propertyList(value: unknown): Data[] {
  let list = value;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  return Array.isArray(list)
    ? list.flatMap((item: unknown) => {
        const record = object(item);
        return record ? [record] : [];
      })
    : [];
}

export function nativeQuote(html: string) {
  for (const [quote, tag, body] of html.matchAll(
    /(<blockquote\b[^>]*>)([\s\S]*?)<\/blockquote\s*>/giu,
  )) {
    if (
      tag &&
      attribute(tag, 'itemtype')?.toLowerCase() === replySchema.toLowerCase()
    )
      return { quote, tag, body: body ?? '' };
  }
}

export function quoteFreeText(content: string) {
  const quote = nativeQuote(content);
  return plainText(quote ? content.replace(quote.quote, '') : content);
}

function replyTarget(
  quote: ReturnType<typeof nativeQuote>,
  properties: Data,
): ReplyTarget | undefined {
  const metadata = propertyList(properties.qtdMsgs)[0];
  const id =
    messageId(metadata?.messageId) ??
    messageId(quote && attribute(quote.tag, 'itemid'));
  if (!id) return;
  const strong = /(<strong\b[^>]*>)([\s\S]*?)<\/strong\s*>/iu.exec(
    quote?.body ?? '',
  );
  const userId =
    mri(metadata?.sender) ?? mri(strong?.[1] && attribute(strong[1], 'itemid'));
  const preview = /(<p\b[^>]*>)([\s\S]*?)<\/p\s*>/giu;
  const text = [...(quote?.body ?? '').matchAll(preview)].find(
    ([, tag]) => tag && attribute(tag, 'itemprop') === 'preview',
  )?.[2];
  return {
    id,
    ...(userId && {
      sender: { id: userId, name: strong?.[2] && plainText(strong[2]) },
    }),
    ...(text && { text: plainText(text) }),
  };
}

export function arrival(raw: Data) {
  const millis = Date.parse(
    string(raw.originalarrivaltime) ?? string(raw.composetime) ?? '',
  );
  if (Number.isFinite(millis)) return millis;
  const id = Number(messageId(raw.id));
  return Number.isSafeInteger(id) && id >= Date.UTC(2000, 0, 1) && id <= 8.64e15
    ? id
    : undefined;
}

export function normalizeMessage(
  raw: Data,
  change: Change,
  account: string,
  expectedChat?: string,
): PlatformInboundEvent | undefined {
  const nativeChat =
    string(raw.conversationid ?? raw.conversationId) ??
    linkId(raw.conversationLink ?? raw.resourceLink, 'conversations');
  const chatId = nativeChat ?? expectedChat;
  if (!chatId || (expectedChat && chatId !== expectedChat)) return;
  const kind = chatKind(chatId);
  if (!kind) return;

  const userId = author(raw);
  if (userId === account) return;
  const properties = object(raw.properties) ?? {};
  const type = string(raw.messagetype);
  const deleted = change === 'MessageRemoved' || Boolean(properties.deletetime);
  const content = string(raw.content) ?? '';
  if (type?.startsWith('Control/') || type?.startsWith('ThreadActivity/'))
    return;
  const id = messageId(raw.id);
  if (!id) return;
  if (deleted) return { type: 'delete', chatId, messageId: id };
  if (
    !userId ||
    (type !== 'Text' &&
      type !== 'RichText/Html' &&
      type !== 'RichText' &&
      type !== 'RichText/Media_Picture' &&
      type !== 'RichText/Media_GenericFile')
  )
    return;

  const quote = type === 'Text' ? undefined : nativeQuote(content);
  const replyTo = replyTarget(quote, properties);
  const media = inboundMedia(
    raw,
    type === 'Text' ? '' : quote ? content.replace(quote.quote, '') : content,
    properties,
    type,
  );
  const text = type === 'Text' ? content : plainText(media.text);
  if (!text.trim() && !media.attachments.length) return;
  const userDisplay = string(raw.imdisplayname) ?? userId;
  return {
    type: 'message',
    chatId,
    chatKind: kind,
    messageId: id,
    at: arrival(raw),
    ...(media.attachments.length && { attachments: media.attachments }),
    userId,
    userDisplay,
    botMessage: false,
    sender: { id: userId, name: userDisplay },
    text,
    edited: change === 'MessageUpdate',
    mentionsBot: propertyList(properties.mentions).some(
      (item) => item.mri === account,
    ),
    replyTo,
    repliesToBot: replyTo?.sender?.id === account,
  };
}

export function notification(body: Data) {
  const change = body.resourceType;
  const resource = object(body.resource);
  if (
    resource &&
    (change === 'NewMessage' ||
      change === 'MessageUpdate' ||
      change === 'MessageRemoved')
  )
    return { change, resource } as const;
}
