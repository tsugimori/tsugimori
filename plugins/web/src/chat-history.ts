import type { AdminConversation, AdminWorkspace } from '@tsugimori/plugin-sdk';

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function historyLink(path: string, before?: number) {
  const query = new URLSearchParams({ view: 'history' });
  if (before !== undefined) query.set('before', String(before));
  return escapeHtml(path + '?' + query + '#newest');
}

export function addHistoryLink(index: string, path: string, before?: number) {
  return index.replace(
    '</body>',
    () =>
      `<noscript><p class="wrap"><a href="${historyLink(path, before)}">View chat history · 查看聊天紀錄</a></p></noscript></body>`,
  );
}

export function chatHistory(
  index: string,
  path: string,
  data: AdminConversation,
  { locale, timezone }: AdminWorkspace,
) {
  const zh = locale === 'zh-TW';
  const title = escapeHtml(data.chat.title || data.chat.chatId);
  const stylesheet = (
    index.match(/<link\b[^>]*\brel="stylesheet"[^>]*>/g) ?? []
  ).join('');
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    dateStyle: 'short',
    timeStyle: 'short',
  });
  const messages = [...data.messages]
    .sort((a, b) => a.seq - b.seq)
    .map((message) => {
      const out = message.direction === 'outbound';
      const sender = out ? 'bot' : message.displayName || message.userId || '—';
      const text = message.deleted
        ? zh
          ? '［訊息已刪除］'
          : '[Deleted message]'
        : message.text || (zh ? '［附件］' : '[Attachment]');
      const stamp =
        message.recordedAt === null ? '' : time.format(message.recordedAt);
      return `<li id="m-${message.seq}" class="msg${out ? ' out' : ''}">
<div class="who"><b>${escapeHtml(sender)}</b> <span class="meta">${escapeHtml(stamp)}</span></div>
<div class="bubble">${escapeHtml(text)}</div></li>`;
    })
    .join('');
  const older =
    data.older === undefined
      ? zh
        ? '已到最早的訊息'
        : 'Beginning of the conversation'
      : `<a class="btn" href="${historyLink(path, data.older)}">${zh ? '載入更早的訊息' : 'Load older messages'}</a>`;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · tsugimori</title>${stylesheet}</head>
<body><div class="chat-shell"><header class="top"><div class="wrap"><a href="/">tsugimori</a></div></header>
<main class="wrap"><section class="chat-column chat-history"><div class="chat-head">
<h1 class="ellipsis">${title}</h1><a class="btn" href="${historyLink(path)}">${zh ? '↓ 最新' : '↓ Latest'}</a>
</div><div class="timeline-scroll chat-pane" role="region" aria-label="${zh ? '訊息' : 'Messages'}" tabindex="0">
<div class="timeline-content"><p class="paging meta">${older}</p>
<ol class="timeline">${messages}</ol><span id="newest"></span></div></div></section></main></div></body></html>`;
}
