import type { Config } from '@tsugimori/config';

const messages = {
  en: {
    environment: 'Environment checks failed:',
    pairing: {
      success: 'Owner paired.',
      invalid: 'Pairing code is invalid or expired.',
    },
    addUsage: 'Usage: /add <agent|platform> <kind> [--id <id>]',
    loginUsage: 'Usage: /login <agentId>',
    allowlisted: 'Chat allowlisted.',
    removedFromAllowlist: 'Chat removed from the allowlist.',
    agentUnavailable: 'That agent is not attached.',
    noAgent: 'No agent is attached.',
    agentSet: (id: string) => `Agent set to ${id}.`,
    modelUsage: 'Usage: /model <name>',
    modelSet: (name: string) => `Model set to ${name}.`,
    compactUsage: 'Usage: /compact',
    compactUnsupported: 'This agent does not support session compaction.',
    compactNoSession: 'There is no active agent session in this chat.',
    compactSkipped:
      'The agent did not compact the session. It may need more conversation history.',
    compactFailed: 'The agent could not compact the session.',
    compactSuccess: 'Agent session compacted.',
    noPreviews: 'No open previews.',
    preview: (id: string, url: string, port: number, expires: string) =>
      `${id} · ${url} · port ${port} · expires ${expires}`,
    previewCloseUsage: 'Usage: /preview close <id>',
    previewClosed: 'Preview closed.',
    previewMissing: 'No open preview with that ID.',
    platformUnavailable: (id: string) =>
      `${id} has been unable to start for five minutes. The gateway will keep retrying.`,
    platformRecovered: (id: string) => `${id} is running again.`,
    delayed: (due: string) => `[Delayed schedule, originally due ${due}]`,
    setup: {
      replyPrivately:
        'Reply directly to the current private setup prompt to submit credentials.',
      useDirectMessage:
        'Submit setup credentials only in the bot’s direct message.',
      changedOwner: 'The platform or its owner changed during setup.',
      alreadyRunning:
        'A guided setup is already running. Finish the current prompts first.',
      sendingPrivately:
        'I’ll send the credential prompt in a direct message. Continue there for that step.',
      reply: 'Reply directly to this message.',
      expired: 'The setup prompt expired. Rerun the command to continue.',
      disabled: (id: string) =>
        `${id} signed in. It is disabled in the workspace configuration.`,
      attached: (id: string) => `${id} is attached.`,
      saved: (id: string) => `Setup saved for ${id}, but it has not attached.`,
      checkStatus: 'Check /status for the latest state.',
      failed:
        'Setup could not complete. Check the workspace and rerun the command to resume.',
      invalidId: 'Use a valid plugin instance ID.',
      agentMissing: 'No configured agent has that ID.',
      noSteps: (login: boolean, category: string, kind: string) =>
        `No ${login ? 'login step' : 'guided setup'} is registered for ${category} ${kind}.`,
      pendingId:
        'That ID belongs to a pending setup for a different plugin kind. Use a different ID.',
      configuredId:
        'That plugin ID is already configured. Choose a different ID.',
      busy: 'Another setup is in progress. Retry once it has finished.',
      leaseExpired: 'The setup lease expired. Rerun the setup command.',
      changedAgent: 'The configured agent changed during sign-in.',
      missingCheck: (id: string) => `The plugin did not report check ${id}.`,
      changedConfig: 'The configuration changed during setup.',
      testFailed:
        'The test turn failed. Check the agent login, model access, and connectivity, then rerun setup.',
    },
  },
  'zh-TW': {
    environment: '環境檢查有問題：',
    pairing: { success: '已完成主人配對。', invalid: '配對碼無效或已過期。' },
    addUsage: '用法：/add <agent|platform> <kind> [--id <id>]',
    loginUsage: '用法：/login <agentId>',
    allowlisted: '已將此聊天室加入允許清單。',
    removedFromAllowlist: '已將此聊天室移出允許清單。',
    agentUnavailable: '該代理程式尚未接上。',
    noAgent: '目前沒有接上的代理程式。',
    agentSet: (id: string) => `已切換到代理程式 ${id}。`,
    modelUsage: '用法：/model <name>',
    modelSet: (name: string) => `已切換到模型 ${name}。`,
    compactUsage: '用法：/compact',
    compactUnsupported: '此代理程式不支援壓縮工作階段。',
    compactNoSession: '此聊天室目前沒有使用中的代理程式工作階段。',
    compactSkipped: '代理程式未壓縮工作階段，可能需要更多對話紀錄。',
    compactFailed: '代理程式無法壓縮工作階段。',
    compactSuccess: '已壓縮代理程式的工作階段。',
    noPreviews: '目前沒有開啟的預覽。',
    preview: (id: string, url: string, port: number, expires: string) =>
      `${id} · ${url} · 連接埠 ${port} · 到期時間 ${expires}`,
    previewCloseUsage: '用法：/preview close <id>',
    previewClosed: '已關閉預覽。',
    previewMissing: '找不到此識別碼對應的開啟中預覽。',
    platformUnavailable: (id: string) =>
      `${id} 已有五分鐘無法啟動，閘道器將繼續重試。`,
    platformRecovered: (id: string) => `${id} 已恢復運作。`,
    delayed: (due: string) => `［排程延遲，原定時間 ${due}］`,
    setup: {
      replyPrivately: '請直接回覆目前的私訊設定提示以提交憑證。',
      useDirectMessage: '請在機器人的私訊中提交設定憑證。',
      changedOwner: '設定期間，平台或主人身分已變更。',
      alreadyRunning: '已有設定流程進行中。請先完成目前的步驟。',
      sendingPrivately: '憑證輸入提示將透過私訊傳送。請在私訊完成這個步驟。',
      reply: '請直接回覆這則訊息。',
      expired: '設定提示已過期。請重新執行指令繼續。',
      disabled: (id: string) =>
        `${id} 已登入。此項目在工作區設定中處於停用狀態。`,
      attached: (id: string) => `${id} 已接上。`,
      saved: (id: string) => `${id} 的設定已儲存，目前尚未接上。`,
      checkStatus: '請執行 /status 查看最新狀態。',
      failed: '無法完成設定。請檢查工作區後重新執行指令繼續。',
      invalidId: '請使用有效的插件實例識別碼。',
      agentMissing: '找不到使用此識別碼的代理程式。',
      noSteps: (login: boolean, category: string, kind: string) =>
        `${category === 'agent' ? '代理程式' : '平台'} ${kind} 沒有提供${login ? '登入步驟' : '引導設定'}。`,
      pendingId:
        '此識別碼已由另一種類型的插件用於進行中的設定。請使用不同的識別碼。',
      configuredId: '此插件識別碼已在設定中使用。請選擇不同的識別碼。',
      busy: '另一個設定流程正在進行。請等它完成後再試。',
      leaseExpired: '設定工作已逾時。請重新執行設定指令。',
      changedAgent: '登入期間，代理程式的設定已變更。',
      missingCheck: (id: string) => `插件未回報檢查項目 ${id}。`,
      changedConfig: '設定流程進行期間，工作區設定已變更。',
      testFailed:
        '測試回合失敗。請檢查代理程式的登入狀態、模型存取權限和連線後重新執行設定。',
    },
  },
};

export function systemMessages(locale: Config['locale']) {
  return messages[locale];
}
