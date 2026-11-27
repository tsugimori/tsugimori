import type { InboundAttachment } from '@tsugimori/plugin-sdk';

import { attachmentBytes } from '@tsugimori/plugin-sdk';

import type { teamsSession } from './auth.ts';
import type { Data } from './wire.ts';

import { attribute, plainText } from './text.ts';
import { HttpError, object, readJson, request, string } from './wire.ts';

export const imageMaxBytes = 5 * 1024 ** 2;
export const fileMaxBytes = 15 * 1024 ** 2;
export const asmObjects = 'https://api.asm.skype.com/v1/objects/';
export const imageSchema = 'http://schema.skype.com/AMSImage';

type Reference =
  | { id: string; kind: 'asm' }
  | { kind: 'share'; url: string }
  | { drive: string; item: string; kind: 'drive' };

function https(value: unknown, hosts: RegExp) {
  const raw = string(value);
  if (!raw || raw.length > 8192 || !URL.canParse(raw)) return;
  const url = new URL(raw);
  if (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    hosts.test(url.hostname)
  )
    return url;
}

export function asmId(value: unknown) {
  const id = string(value);
  if (id && /^[a-z0-9_-][a-z0-9._-]{0,199}$/iu.test(id)) return id;
}

function asmReference(value: unknown) {
  const raw = string(value);
  const url = https(raw, /(?:^|\.)asm\.skype\.com$/u);
  return asmId(
    url
      ? /^\/v1\/objects\/([^/]+)(?:\/views\/(?:imgo|original))?\/?$/u.exec(
          url.pathname,
        )?.[1]
      : raw,
  );
}

function trustedShare(value: unknown) {
  return https(
    value,
    /(?:^|\.)(?:1drv\.ms|onedrive\.live\.com|sharepoint\.com|microsoftpersonalcontent\.com)$/u,
  );
}

function graphId(value: unknown) {
  const id = string(value);
  if (id && /^[a-z0-9_-][a-z0-9!._-]{0,255}$/iu.test(id)) return id;
}

function list(value: unknown): unknown[] {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function positiveSize(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  const size = Number(value);
  if (Number.isSafeInteger(size) && size > 0) return size;
}

function attachmentName(value: string | undefined, fallback: string) {
  return value?.trim().slice(0, 200) || fallback;
}

function imageMime(value: string | undefined) {
  return value && /^image\/(?:jpeg|png|gif|webp)$/u.test(value)
    ? value
    : undefined;
}

export function inboundMedia(
  raw: Data,
  content: string,
  properties: Data,
  type: string,
) {
  const attachments: InboundAttachment[] = [];
  const seen = new Set<string>();
  function add(
    reference: Reference,
    attachment: Omit<InboundAttachment, 'fileId' | 'index'>,
  ) {
    const fileId = JSON.stringify(reference);
    const key = `${attachment.kind}:${fileId}`;
    if (attachments.length >= 20 || seen.has(key)) return;
    seen.add(key);
    attachments.push({ ...attachment, fileId, index: attachments.length });
  }

  const references = list(
    raw.amsreferences ?? properties.amsreferences,
  ).flatMap((value) => {
    const record = object(value);
    const id = asmReference(record?.id ?? record?.url ?? value);
    return id ? [id] : [];
  });
  let imageIndex = 0;
  const text = content
    .replace(/<img\b[^>]*>/giu, (tag) => {
      const source = attribute(tag, 'src');
      const sourceId = asmReference(source);
      if (
        attribute(tag, 'itemtype')?.toLowerCase() !==
          imageSchema.toLowerCase() &&
        !(sourceId && source?.includes('/views/imgo'))
      )
        return tag;
      const fallback = references[imageIndex++];
      const id = source
        ? sourceId
        : (asmReference(attribute(tag, 'itemid')) ?? fallback);
      if (id)
        add(
          { kind: 'asm', id },
          {
            kind: 'image',
            name: attachmentName(attribute(tag, 'alt'), 'image'),
            mime: imageMime(
              `image/${attribute(tag, 'itemscope')?.toLowerCase()}`,
            ),
            width: positiveSize(attribute(tag, 'width')),
            height: positiveSize(attribute(tag, 'height')),
          },
        );
      return '';
    })
    .replace(
      /(<URIObject\b[^>]*>)([\s\S]*?)<\/URIObject\s*>/giu,
      (full, tag: string, body: string) => {
        const type = attribute(tag, 'type')?.toLowerCase();
        const uri = attribute(tag, 'uri');
        if (type === 'picture.1') {
          const id = asmReference(uri);
          if (id) add({ kind: 'asm', id }, { kind: 'image', name: 'image' });
          return '';
        }
        if (type !== 'file.1') return full;
        const nameTag = /<OriginalName\b[^>]*>/iu.exec(body)?.[0];
        const sizeTag = /<FileSize\b[^>]*>/iu.exec(body)?.[0];
        const title = /<Title\b[^>]*>([\s\S]*?)<\/Title\s*>/iu.exec(body)?.[1];
        const name = attachmentName(
          (nameTag && attribute(nameTag, 'v')) || (title && plainText(title)),
          'attachment',
        );
        const size = positiveSize(sizeTag && attribute(sizeTag, 'v'));
        const id = asmReference(uri);
        const share = trustedShare(uri)?.href;
        if (id) add({ kind: 'asm', id }, { kind: 'file', name, size });
        else if (share)
          add({ kind: 'share', url: share }, { kind: 'file', name, size });
        return '';
      },
    );

  if (
    !imageIndex &&
    ['RichText/Media_Picture', 'RichText/Html', 'RichText'].includes(type)
  ) {
    for (const id of references)
      add({ kind: 'asm', id }, { kind: 'image', name: 'image' });
  } else if (type === 'RichText/Media_GenericFile' && !attachments.length) {
    for (const id of references)
      add({ kind: 'asm', id }, { kind: 'file', name: 'attachment' });
  }

  for (const value of list(properties.files)) {
    const file = object(value);
    const info = object(file?.fileInfo);
    const url = trustedShare(info?.shareUrl ?? file?.shareUrl)?.href;
    const drive = graphId(
      info?.driveId ??
        /\/personal\/([^/?#]+)(?:\/|$)/u.exec(
          trustedShare(info?.siteUrl)?.pathname ?? '',
        )?.[1],
    );
    const item = graphId(info?.itemId);
    const name = attachmentName(
      string(file?.fileName ?? file?.title),
      'attachment',
    );
    const size = positiveSize(file?.fileSize ?? info?.size);
    if (url) add({ kind: 'share', url }, { kind: 'file', name, size });
    else if (drive && item)
      add({ kind: 'drive', drive, item }, { kind: 'file', name, size });
  }
  return { attachments, text };
}

function downloadReference(fileId: string | undefined): Reference {
  let data: Data | undefined;
  try {
    data = object(JSON.parse(fileId ?? ''));
  } catch {
    throw new Error('Invalid Teams attachment reference');
  }
  if (data?.kind === 'asm') {
    const id = asmId(data.id);
    if (id) return { kind: 'asm', id };
  }
  if (data?.kind === 'share') {
    const url = trustedShare(data.url)?.href;
    if (url) return { kind: 'share', url };
  }
  if (data?.kind === 'drive') {
    const drive = graphId(data.drive);
    const item = graphId(data.item);
    if (drive && item) return { kind: 'drive', drive, item };
  }
  throw new Error('Invalid Teams attachment reference');
}

type Auth = ReturnType<typeof teamsSession>;

export async function asmRequest(
  fetch: typeof globalThis.fetch,
  auth: Auth,
  path: string,
  init: RequestInit,
  signal: AbortSignal,
) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const { token } = await auth.get();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `skype_token ${token}`);
    headers.set('x-ms-client-version', '1415/1.0.0.2018090100');
    const response = await request(
      fetch,
      asmObjects + path,
      { ...init, headers },
      signal,
    );
    if (response.ok) return response;
    await response.body?.cancel();
    if (response.status !== 401 || attempt)
      throw new HttpError(response.status);
    auth.invalidate(token);
  }
}

async function graphMetadata(
  fetch: typeof globalThis.fetch,
  auth: Auth,
  reference: Exclude<Reference, { kind: 'asm' }>,
  signal: AbortSignal,
) {
  const path =
    reference.kind === 'share'
      ? `shares/u!${Buffer.from(reference.url).toString('base64url')}/driveItem`
      : `drives/${encodeURIComponent(reference.drive)}/items/${encodeURIComponent(reference.item)}`;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const { token } = await auth.getGraph();
    const response = await request(
      fetch,
      `https://graph.microsoft.com/v1.0/${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Prefer: 'redeemSharingLinkIfNecessary',
        },
      },
      signal,
    );
    if (response.ok) return readJson(response);
    await response.body?.cancel();
    if (response.status !== 401 || attempt)
      throw new HttpError(response.status);
    auth.invalidateGraph(token);
  }
}

export async function downloadMedia(
  fetch: typeof globalThis.fetch,
  auth: Auth,
  attachment: InboundAttachment,
  signal: AbortSignal,
  maxBytes?: number,
) {
  const image = attachment.kind === 'image';
  if (!image && attachment.kind !== 'file')
    throw new Error('Unsupported Teams attachment kind');
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
  )
    throw new Error('Invalid attachment download limit');
  const limit = Math.min(
    image ? imageMaxBytes : fileMaxBytes,
    maxBytes ?? Infinity,
  );
  const tooLarge = 'Teams attachment exceeds the download size limit';
  if ((attachment.size ?? 0) > limit) throw new Error(tooLarge);
  const reference = downloadReference(attachment.fileId);
  let response;
  if (reference.kind === 'asm') {
    response = await asmRequest(
      fetch,
      auth,
      `${reference.id}/views/${image ? 'imgo' : 'original'}`,
      {},
      signal,
    );
  } else {
    if (image) throw new Error('Invalid Teams image attachment reference');
    const metadata = await graphMetadata(fetch, auth, reference, signal);
    if ((positiveSize(metadata.size) ?? 0) > limit) throw new Error(tooLarge);
    const url = https(
      metadata['@microsoft.graph.downloadUrl'],
      /(?:^|\.)(?:microsoftpersonalcontent\.com|1drv\.com|livefilestore\.com|onedrive\.com|onedrive\.live\.com|sharepoint\.com)$/u,
    );
    if (!url) throw new Error('Untrusted Teams attachment download host');
    // The signed URL carries its own authorization.
    response = await request(fetch, url, { credentials: 'omit' }, signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status);
    }
  }
  const mime = response.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  if (image && !imageMime(mime)) {
    await response.body?.cancel();
    throw new Error('Unsupported Teams image response type');
  }
  const bytes = await attachmentBytes(response, limit, tooLarge);
  signal.throwIfAborted();
  return { bytes, mime };
}
