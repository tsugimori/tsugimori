import type { Config } from '@tsugimori/config';
import type { RemovalTarget } from '@tsugimori/storage';

import type { RemovalPlan } from './removal.ts';

function list(items: readonly string[]) {
  return items.length ? items.join(', ') : '—';
}

export function removalMessages(locale: Config['locale']) {
  if (locale === 'zh-TW') {
    return {
      activeSetup: (id: string) =>
        `${id} 正在進行引導設定。請先在設定對話執行 /cancel。`,
      backupStage: '建立備份',
      busy: '已有移除作業正在進行。',
      cancelled: '已取消移除。',
      changed: '移除清單已變更，請重新執行移除指令以確認。',
      cleared: (file: string) => `已清除 ${file} 的代理預設`,
      configStage: '已更新設定檔',
      crossFilesystem: '要移入備份的目錄與備份目錄必須位於同一檔案系統。',
      dbStage: '已更新資料庫',
      defaultAgent: (id: string, alternatives: string[]) =>
        `${id} 是工作區的預設代理。` +
        (alternatives.length
          ? `請先將 defaultAgent 設為其他代理，再執行移除。可選代理（${alternatives.length}）：${list(alternatives)}。`
          : '請先新增並指定另一個預設代理。'),
      detachStage: '已解除掛載並停止相關執行中的工作',
      envStage: '已移除 .env 變數',
      failed: (step: string, backup: string | undefined, done: string[]) =>
        [
          `移除作業在「${step}」階段停止。`,
          backup && `備份：${backup}`,
          `已完成（${done.length}）：`,
          ...done.map((item) => `- ${item}`),
        ]
          .filter(Boolean)
          .join('\n'),
      finished: (
        { category, id }: RemovalTarget,
        backup: string,
        done: string[],
      ) =>
        [
          `已移除 ${category === 'agent' ? '代理' : '平台'} ${id}。`,
          `備份：${backup}`,
          ...done.map((item) => `- ${item}`),
        ].join('\n'),
      moved: (path: string, destination: string) =>
        `已移動 ${path} 至備份中的 ${destination}`,
      ownPlatform: '無法從這個平台移除它自己。請從另一個平台或 CLI 執行。',
      prompt:
        '請回覆這則訊息 yes 以刪除，其他回覆會取消。10 分鐘後逾時，也可傳送 /cancel。',
      recheck: '重新檢查移除清單',
      saved: (file: string) => `已備份 ${file}`,
      unavailable: '無法產生或完成移除作業。請查看工作區與服務狀態。',
      unknown: (category: string, id: string, ids: string[]) =>
        `找不到${category === 'agent' ? '代理' : '平台'} ${id}。已設定（${ids.length}）：${list(ids)}。`,
      usage: '用法：/remove <platform|agent> <id>',
    };
  }
  return {
    activeSetup: (id: string) =>
      `Guided setup is active for ${id}. Use /cancel in the setup conversation first.`,
    backupStage: 'Create backup',
    busy: 'A removal is already in progress.',
    cancelled: 'Removal cancelled.',
    changed:
      'The removal plan changed. Run the removal command again to review it.',
    cleared: (file: string) => `Cleared agent defaults in ${file}`,
    configStage: 'Updated the configuration',
    crossFilesystem:
      'Directories moved to backup must share the backup filesystem.',
    dbStage: 'Updated SQLite rows',
    defaultAgent: (id: string, alternatives: string[]) =>
      `${id} is the workspace default agent. ` +
      (alternatives.length
        ? `Set defaultAgent to another agent first. Choices (${alternatives.length}) · ${list(alternatives)}.`
        : 'Add another agent and set it as the default first.'),
    detachStage: 'Detached the instance and stopped affected live work',
    envStage: 'Removed .env variables',
    failed: (step: string, backup: string | undefined, done: string[]) =>
      [
        `Removal stopped at “${step}”.`,
        backup && `Backup · ${backup}`,
        `Completed (${done.length})`,
        ...done.map((item) => `- ${item}`),
      ]
        .filter(Boolean)
        .join('\n'),
    finished: (
      { category, id }: RemovalTarget,
      backup: string,
      done: string[],
    ) =>
      [
        `Removed ${category} ${id}.`,
        `Backup · ${backup}`,
        ...done.map((item) => `- ${item}`),
      ].join('\n'),
    moved: (path: string, destination: string) =>
      `Moved ${path} to ${destination} in the backup`,
    ownPlatform: 'Use another platform or the CLI to remove this platform.',
    prompt:
      'Reply yes to this message to delete. Any other reply cancels. This prompt expires in 10 minutes. You can also send /cancel.',
    recheck: 'Recheck the removal plan',
    saved: (file: string) => `Backed up ${file}`,
    unavailable:
      'Unable to plan or complete removal. Check the workspace and gateway status.',
    unknown: (category: string, id: string, ids: string[]) =>
      `Unknown ${category} ${id}. Configured IDs (${ids.length}) · ${list(ids)}.`,
    usage: 'Usage: /remove <platform|agent> <id>',
  };
}

export function formatRemovalPlan(plan: RemovalPlan, chat = false) {
  const {
    category,
    chatDefaults,
    directories,
    env,
    id,
    keptDirectories,
    kind,
    locale,
    ownerMapping,
    processEnv,
    rows,
  } = plan;
  const zh = locale === 'zh-TW';
  const scopes = (refs: typeof rows.routes) =>
    refs.map((ref) => `${ref.adapterId}/${ref.chatId}`).sort();
  const row = (label: string, items: readonly string[]) =>
    `${label} (${items.length}) · ${list(items)}`;
  const lines = [
    zh ? '移除清單' : 'Removal plan',
    `${zh ? '設定項目' : 'Config entry'} (1) · ${category}s[] ${id} (${kind})`,
    row(zh ? '移除 .env 變數' : 'Remove .env variables', env),
    row(
      zh
        ? '僅存在程序環境（不受管理，保留原狀）'
        : 'Process environment only (not managed, left as is)',
      processEnv,
    ),
    row(
      zh ? '移入備份的目錄' : 'Directories moved to backup',
      directories.filter(({ exists }) => exists).map(({ path }) => path),
    ),
    ...(directories.some(({ exists }) => !exists)
      ? [
          row(
            zh ? '目前不存在的目錄' : 'Absent directories',
            directories.filter(({ exists }) => !exists).map(({ path }) => path),
          ),
        ]
      : []),
    ...(keptDirectories.length
      ? [row(zh ? '保留共用目錄' : 'Keep shared directories', keptDirectories)]
      : []),
  ];
  if (category === 'platform') {
    lines.push(
      row(zh ? '刪除對話' : 'Delete chats', rows.chats),
      row(
        zh ? '移除擁有者設定' : 'Remove owner mapping',
        ownerMapping ? [`owner.${id}`] : [],
      ),
    );
  } else {
    lines.push(
      zh ? '工作區預設代理：否' : 'Workspace default agent · no',
      row(
        zh
          ? '清除對話的代理、模型、推理與快速模式覆寫'
          : 'Clear chat agent, model, thinking and fast overrides',
        scopes(rows.routes),
      ),
      row(
        zh ? '清除資料庫中的對話代理預設' : 'Clear stored chat defaults',
        scopes(rows.workspaceSettings),
      ),
      row(
        zh ? '清除 agents.json 內的代理預設' : 'Clear agents.json defaults',
        chatDefaults,
      ),
    );
  }
  lines.push(
    `${zh ? '資料庫筆數' : 'SQLite rows'} · ${Object.entries(rows.counts)
      .map(([name, count]) => `${name}=${count}`)
      .join(', ')}`,
    row(zh ? '取消進行中的任務' : 'Cancel active tasks', rows.tasks),
    row(zh ? '取消排程' : 'Cancel schedules', rows.schedules),
  );
  if (chat) lines.push('', removalMessages(locale).prompt);
  return lines.join('\n');
}
