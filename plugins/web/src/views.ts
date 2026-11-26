import type {
  AdminApprovals,
  AdminChat,
  AdminConversation,
  AdminTrace,
  ChatRef,
} from '@tsugimori/plugin-sdk';

function escape(value: unknown) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );
}

function link(path: string, query: Record<string, string>, text: string) {
  return `<a href="${escape(path + '?' + new URLSearchParams(query))}">${escape(text)}</a>`;
}

function chatLink(chat: ChatRef, title?: string | null) {
  return link(
    '/chat',
    { adapter: chat.adapterId, id: chat.chatId },
    title || chat.chatId,
  );
}

function table(columns: string[], rows: string[][]) {
  if (!rows.length) return '<p>No entries.</p>';
  return `<div class="scroll"><table><thead><tr>${columns.map((value) => `<th scope="col">${escape(value)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => '<tr>' + row.map((cell) => `<td>${cell}</td>`).join('') + '</tr>').join('')}</tbody></table></div>`;
}

function date(value: number | null) {
  return value === null ? '' : new Date(value).toISOString();
}

export function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Tsugimori</title>
<style>
:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif;--line:color-mix(in srgb,CanvasText 20%,transparent)}
body{max-width:78rem;margin:2rem auto;padding:0 1rem}nav{display:flex;gap:1rem;padding-bottom:1rem;border-bottom:1px solid var(--line)}
.scroll{overflow:auto}table{border-collapse:collapse;width:100%}td,th{text-align:left;vertical-align:top;padding:.5rem .75rem;border-bottom:1px solid var(--line)}
th{white-space:nowrap}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;min-width:12rem}a{color:LinkText}
</style></head><body><nav aria-label="Administration"><a href="/">Chats</a><a href="/approvals">Approvals and grants</a></nav><main><h1>${escape(title)}</h1>${body}</main></body></html>`;
}

export function chatsView(chats: readonly AdminChat[]) {
  return table(
    ['Chat', 'Adapter', 'Kind', 'Allowlisted'],
    chats.map((chat) => [
      chatLink(chat, chat.title),
      escape(chat.adapterId),
      escape(chat.kind),
      chat.allowlisted ? 'Yes' : '',
    ]),
  );
}

export function conversationView({ chat, messages, tasks }: AdminConversation) {
  const before = messages.at(-1)?.seq;
  return (
    `<h2>Message log</h2>` +
    table(
      ['Sequence', 'Direction', 'Native user ID', 'Message'],
      messages.map((message) => [
        escape(message.seq),
        escape(message.direction),
        escape(message.userId),
        message.deleted
          ? '<em>Deleted</em>'
          : `<pre>${escape(message.text)}</pre>`,
      ]),
    ) +
    (messages.length === 100 && before !== undefined
      ? `<p>${link('/chat', { adapter: chat.adapterId, id: chat.chatId, before: String(before) }, 'Older messages')}</p>`
      : '') +
    '<h2>Tasks</h2>' +
    table(
      ['Started', 'Task', 'Agent', 'Model', 'Status'],
      tasks.map((task) => [
        escape(date(task.startedAt ?? task.createdAt)),
        link('/trace', { task: task.id }, task.id),
        escape(task.agentId),
        escape(task.model),
        escape(task.status),
      ]),
    )
  );
}

export function traceView({ task, spans }: AdminTrace) {
  return (
    `<p>${chatLink(task)} · ${escape(task.status)}</p>` +
    table(
      ['Started', 'Stage', 'Elapsed (ms)', 'Status', 'Attributes'],
      spans.map((span) => [
        escape(date(span.startedAt)),
        escape(span.name),
        escape(span.durationMs.toFixed(2)),
        escape(span.status),
        `<pre>${escape(JSON.stringify(span.attrs))}</pre>`,
      ]),
    )
  );
}

export function approvalsView({ approvals, grants }: AdminApprovals) {
  return (
    '<h2>Approvals</h2>' +
    table(
      [
        'Chat',
        'Action',
        'Resource',
        'Requester',
        'Status',
        'Failure reason',
        'Decided by',
        'Decided at',
      ],
      approvals.map((approval) => [
        chatLink(approval),
        escape(approval.action),
        escape(JSON.stringify(approval.resource)),
        escape(approval.requester),
        escape(approval.status),
        escape(approval.failureReason),
        escape(approval.decidedBy),
        escape(date(approval.decidedAt)),
      ]),
    ) +
    '<h2>Grants</h2>' +
    table(
      [
        'Chat',
        'Action',
        'Scope',
        'Mode',
        'Granted by',
        'Granted to',
        'Created',
        'Revoked',
      ],
      grants.map((grant) => [
        chatLink(grant),
        escape(grant.action),
        escape(JSON.stringify(grant.scope)),
        escape(grant.mode),
        escape(grant.grantedBy),
        escape(grant.grantedTo),
        escape(date(grant.createdAt)),
        escape(date(grant.revokedAt)),
      ]),
    )
  );
}
