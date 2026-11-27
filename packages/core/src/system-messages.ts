import type { Config } from '@tsugimori/config';

import { pairingCodeHours } from '@tsugimori/auth';

const messages = {
  en: {
    environment: 'Environment checks failed:',
    pairing: {
      success: 'Owner paired.',
      invalid: 'Pairing code is invalid or expired.',
      useNew: 'Usage: /pair new <adapterId>',
      directOnly: 'Use /pair new in a direct message.',
      unknown: (id: string) => `Unknown adapter: ${id}.`,
      platformOnly: (id: string) =>
        `${id} is an agent. Pairing requires a platform adapter.`,
      owned: (id: string) => `${id} already has an owner.`,
      code: (id: string, code: string, link?: string) =>
        `Send this exact line in a direct message to the new bot (${id}) within ${pairingCodeHours} hours:\n\`/pair ${code}\`${link ? `\n${link}` : ''}`,
      sentPrivately: 'I sent the pairing code in a direct message.',
      sendFailed: (id: string) =>
        `I couldn’t deliver the pairing code privately. Use /pair new ${id} in a direct message to try again.`,
      retryWhenRunning: (id: string) =>
        `Once the platform is running, use /pair new ${id} in a direct message to get a pairing code if it still has no owner.`,
    },
    webhook: {
      states: {
        unconfigured: 'Unconfigured',
        checking: 'Checking',
        ok: 'OK',
        failed: 'Failed',
      },
      heading: 'Webhook',
      setup: 'Set up',
      setupWebhook: 'Set up webhook',
      check: 'Check again',
      providers: 'Choose a webhook ingress provider.',
      manual: 'Enter a URL manually',
      askUrl: 'Enter the public HTTPS base URL that forwards to the gateway.',
      invalidUrl:
        'Enter a valid HTTPS base URL without credentials, a query, or a fragment.',
      missingProvider: (id: string) => `Webhook provider ${id} is unavailable.`,
      unreachable: (error: string) =>
        `The gateway is unreachable from the public URL: ${error}`,
      wrongTarget: (status: number) =>
        `The public URL responded, but it did not reach this tsugimori gateway (HTTP ${status}). Check the tunnel or reverse proxy route.`,
      suffix: ' (needs webhook)',
      blocked: (kind: string, state: string) =>
        `${kind} needs a publicly reachable webhook. Webhook is currently ${state}. Set up webhook ingress first.`,
      failed: (reason: string) => `check failed: ${reason}`,
      verify: 'Verify the public webhook route',
      saved: 'Webhook ingress is configured and the public check passed.',
      checked: (age: string) => `Checked ${age}`,
      use: 'Use /webhook, /webhook setup, or /webhook check.',
      changed:
        'Webhook settings changed during setup. Run /webhook setup again.',
      occupied:
        'The webhook listener is already in use. Run /webhook check in the running gateway.',
    },
    addUsage:
      'Usage: /add <agent|platform> <kind> [--id <id>]. Omit --id to choose a name during setup.',
    loginUsage: 'Usage: /login <agentId>',
    allowlisted: 'Chat allowlisted.',
    removedFromAllowlist: 'Chat removed from the allowlist.',
    agentUnavailable: 'That agent is not attached.',
    noAgent: 'No agent is attached.',
    agentSet: (id: string) => `Agent set to ${id}.`,
    settingLabels: {
      agent: 'Agent',
      model: 'Model',
      thinking: 'Effort',
      serviceTier: 'Fast',
    },
    choices: {
      answer: (label: string) => `Selected: ${label}`,
      help: 'Available commands',
      cancelled: 'Selection cancelled.',
      expired: 'Selection expired.',
      failed: 'The selection could not be completed.',
      unavailable: 'This selection is unavailable.',
      values: (values: string) => `Choices: ${values}`,
      addKind: (category: string) => `Choose a plugin for /add ${category}.`,
      noPlugins: (category: string) => `No ${category} plugins are installed.`,
      page: (page: number, total: number) => `Page ${page} of ${total}`,
      previous: 'Previous',
      next: 'Next',
    },
    settingSources: {
      chat: 'this chat',
      agent: 'agent config',
      default: 'default',
    },
    settingCurrent: (label: string, value: string, source: string) =>
      `${label}: ${value} (${source})`,
    settingSet: (label: string, value: string) => `${label} set to ${value}.`,
    settingCleared: (label: string) => `${label} override cleared.`,
    agentOverridesCleared: (labels: string) =>
      `Cleared overrides unsupported by this agent: ${labels}.`,
    thinkingUsage: (levels: string) => `Usage: /thinking <${levels}|default>`,
    thinkingUnsupported:
      'This agent does not support reasoning effort overrides.',
    fastUsage: 'Usage: /fast <on|off|default>',
    fastUnsupported: 'This agent does not support fast mode.',
    fastOn: 'on',
    fastOff: 'off',
    unset: 'default',
    compactUsage: 'Usage: /compact',
    compactUnsupported: 'This agent does not support session compaction.',
    compactNoSession: 'There is no active agent session in this chat.',
    compactSkipped:
      'The agent did not compact the session. It may need more conversation history.',
    compactFailed: 'The agent could not compact the session.',
    compactSuccess: 'Agent session compacted.',
    contextUsage: 'Usage: /context',
    stopUsage: 'Usage: /stop',
    stopIdle: 'No task is running in this chat.',
    stopped: (queued: number) => `Stopped the running task. ${queued} queued.`,
    newBusy: (command: string) =>
      `This chat has pending work. Try /${command} when it finishes.`,
    incognitoOn:
      "Incognito on. Reply to an earlier ordinary message to bring its thread into this conversation. After `/incognito off` or `/new`, I won't see what was said in this window.",
    incognitoEnabled: 'Incognito on.',
    incognitoOff: 'Incognito off.',
    newSuccess:
      'Started a new conversation. Your next message will use a new session.',
    btwUsage: 'Usage: /btw <message>',
    askUsage: 'Usage: /ask <message>',
    btwFresh: 'Answering in a fresh session without conversation history.',
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
      plan: 'Setup plan',
      nameTitle: 'Name the instance',
      nameQuestion:
        'Instance name (used in paths and credential names where applicable)',
      lineNameQuestion:
        'Instance name (used in the LINE webhook path and credential variable suffixes)',
      askName: (suggested: string) =>
        `Enter the instance name, or reply default or - to use ${suggested}.`,
      completeCancelled: (id: string) =>
        `Setup for ${id} is saved. The optional final step was cancelled.`,
      completeFailed: (id: string) =>
        `Setup for ${id} is saved. The optional final step could not complete.`,
      automatic: 'Runs automatically',
      unspecified: 'Prompt details are not declared',
      private: ' (DM)',
      hiddenInput: ' (hidden input)',
      savesAfter: (step: number, text: string) => `Step ${step}: ${text}`,
      savesConfig: 'workspace configuration after all steps and checks pass',
      disablesAgent: 'the agent is disabled in tsugimori.json before sign-in',
      saving: (details: string[]) => `Saves: ${details.join(' · ')}.`,
      canCancel: 'Send /cancel at any time to cancel setup.',
      progress: (step: number, total: number) => `(${step}/${total})`,
      stepMessage: (progress: string, text: string) => `${progress} ${text}`,
      question: (
        step: string,
        question: number,
        total: number,
        text: string,
        maximum = false,
      ) =>
        `${step} · Question ${question} of ${maximum ? 'up to ' : ''}${total}: ${text}`,
      directMessage: 'this direct message',
      origin: (name: string) => `Setup started in ${name}.`,
      idle: 'No setup is in progress.',
      cancelled: (credentials: string[], disabledId?: string) => {
        const saved = [
          ...(credentials.length
            ? [`credentials (${credentials.join(', ')})`]
            : []),
          ...(disabledId
            ? [`tsugimori.json (${disabledId} disabled for sign-in)`]
            : []),
        ];
        return saved.length
          ? `Setup cancelled. Already saved: ${saved.join(' and ')}.${credentials.length ? ' Rerun setup to overwrite credentials.' : ''}`
          : 'Setup cancelled. No credentials or configuration were saved in this run.';
      },
      replyPrivately:
        'Reply directly to the current private setup prompt to submit credentials.',
      useDirectMessage:
        'Submit setup credentials only in the bot’s direct message.',
      changedOwner: 'The platform or its owner changed during setup.',
      alreadyRunning:
        'A guided setup is already running. Finish it or send /cancel in that chat.',
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
    pairing: {
      success: '已完成主人配對。',
      invalid: '配對碼無效或已過期。',
      useNew: '用法：/pair new <adapterId>',
      directOnly: '請在私訊中使用 /pair new。',
      unknown: (id: string) => `找不到平台轉接器 ${id}。`,
      platformOnly: (id: string) =>
        `${id} 是代理程式。只有平台轉接器可以配對。`,
      owned: (id: string) => `${id} 已有主人。`,
      code: (id: string, code: string, link?: string) =>
        `請在 ${pairingCodeHours} 小時內私訊新的機器人（${id}），傳送以下這一行：\n\`/pair ${code}\`${link ? `\n${link}` : ''}`,
      sentPrivately: '配對碼已透過私訊傳送。',
      sendFailed: (id: string) =>
        `配對碼無法透過私訊送達。請在私訊中使用 /pair new ${id} 重試。`,
      retryWhenRunning: (id: string) =>
        `平台開始運作後，如果還沒有主人，請在私訊中使用 /pair new ${id} 取得配對碼。`,
    },
    webhook: {
      states: {
        unconfigured: '未設定',
        checking: '檢查中',
        ok: '正常',
        failed: '檢查失敗',
      },
      heading: 'Webhook',
      setup: '設定',
      setupWebhook: '設定 webhook',
      check: '重新檢查',
      providers: '選擇 Webhook 入口服務。',
      manual: '手動填網址',
      askUrl: '請輸入會轉送到閘道器的公開 HTTPS 基底網址。',
      invalidUrl: '請輸入不含憑證、查詢參數或片段的有效 HTTPS 基底網址。',
      missingProvider: (id: string) => `無法使用 Webhook 入口服務 ${id}。`,
      unreachable: (error: string) => `從公開網址連不到 gateway：${error}`,
      wrongTarget: (status: number) =>
        `公開網址有回應，但不是這個 tsugimori（HTTP ${status}）。請檢查 tunnel 或反向代理的路由`,
      suffix: '（需先設定 webhook）',
      blocked: (kind: string, state: string) =>
        `${kind} 需要可以從外部連進來的 webhook，目前 webhook ${state}。請先完成 webhook 設定。`,
      failed: (reason: string) => `檢查失敗：${reason}`,
      verify: '驗證公開的 Webhook 路由',
      saved: 'Webhook 已設定，公開路由驗證通過。',
      checked: (age: string) => `${age}檢查`,
      use: '請使用 /webhook、/webhook setup 或 /webhook check。',
      changed: '設定期間 Webhook 設定已變更，請重新執行 /webhook setup。',
      occupied:
        'Webhook 監聽位址已使用。請在執行中的閘道器使用 /webhook check。',
    },
    addUsage:
      '用法：/add <agent|platform> <kind> [--id <id>]。省略 --id 可在設定時選擇名稱。',
    loginUsage: '用法：/login <agentId>',
    allowlisted: '已將此聊天室加入允許清單。',
    removedFromAllowlist: '已將此聊天室移出允許清單。',
    agentUnavailable: '該代理程式尚未接上。',
    noAgent: '目前沒有接上的代理程式。',
    agentSet: (id: string) => `已切換到代理程式 ${id}。`,
    settingLabels: {
      agent: '代理程式',
      model: '模型',
      thinking: '推理',
      serviceTier: '快速',
    },
    choices: {
      answer: (label: string) => `已選擇：${label}`,
      help: '可用指令',
      cancelled: '已取消選擇。',
      expired: '選擇已過期。',
      failed: '無法完成此選擇。',
      unavailable: '此選項目前無法使用。',
      values: (values: string) => `選項：${values}`,
      addKind: (category: string) => `請選擇 /add ${category} 的插件。`,
      noPlugins: (category: string) => `沒有已安裝的 ${category} 插件。`,
      page: (page: number, total: number) => `第 ${page} 頁，共 ${total} 頁`,
      previous: '上一頁',
      next: '下一頁',
    },
    settingSources: { chat: '此聊天室', agent: 'agent 設定', default: '預設' },
    settingCurrent: (label: string, value: string, source: string) =>
      `${label}：${value}（${source}）`,
    settingSet: (label: string, value: string) => `已將${label}設為 ${value}。`,
    settingCleared: (label: string) => `已清除本聊天室的${label}覆寫。`,
    agentOverridesCleared: (labels: string) =>
      `已清除此代理程式不支援的覆寫：${labels}。`,
    thinkingUsage: (levels: string) => `用法：/thinking <${levels}|default>`,
    thinkingUnsupported: '此代理程式不支援設定推理強度。',
    fastUsage: '用法：/fast <on|off|default>',
    fastUnsupported: '此代理程式不支援快速模式。',
    fastOn: '開',
    fastOff: '關',
    unset: '預設',
    compactUsage: '用法：/compact',
    compactUnsupported: '此代理程式不支援壓縮工作階段。',
    compactNoSession: '此聊天室目前沒有使用中的代理程式工作階段。',
    compactSkipped: '代理程式未壓縮工作階段，可能需要更多對話紀錄。',
    compactFailed: '代理程式無法壓縮工作階段。',
    compactSuccess: '已壓縮代理程式的工作階段。',
    contextUsage: '用法：/context',
    stopUsage: '用法：/stop',
    stopIdle: '此聊天室目前沒有執行中的任務。',
    stopped: (queued: number) =>
      `已停止目前的任務。還有 ${queued} 個任務在佇列中。`,
    newBusy: (command: string) =>
      `此聊天室還有任務未完成，請等任務結束後再使用 /${command}。`,
    incognitoOn:
      '無痕模式已開啟。回覆先前的非無痕訊息，即可將該回覆串帶入這次對話。使用 `/incognito off` 或 `/new` 後，我就看不到這段無痕對話。',
    incognitoEnabled: '無痕模式已開啟。',
    incognitoOff: '無痕模式已關閉。',
    newSuccess: '已開始新對話，下一則訊息會用新的 session。',
    btwUsage: '用法：/btw <訊息>',
    askUsage: '用法：/ask <訊息>',
    btwFresh: '將在不含對話紀錄的新工作階段回答。',
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
      plan: '設定流程',
      nameTitle: '命名實例',
      nameQuestion: '實例名稱（用於相關路徑和憑證名稱）',
      lineNameQuestion: '實例名稱（用於 LINE Webhook 路徑和憑證環境變數後綴）',
      askName: (suggested: string) =>
        `請輸入實例名稱，或回覆 default 或 - 使用 ${suggested}。`,
      completeCancelled: (id: string) =>
        `${id} 的設定已儲存，已取消最後的選用步驟。`,
      completeFailed: (id: string) =>
        `${id} 的設定已儲存，無法完成最後的選用步驟。`,
      automatic: '自動執行',
      unspecified: '未提供提示說明',
      private: '（私訊）',
      hiddenInput: '（隱藏輸入）',
      savesAfter: (step: number, text: string) => `第 ${step} 步${text}`,
      savesConfig: '所有步驟及檢查通過後儲存工作區設定',
      disablesAgent: '登入前先在 tsugimori.json 停用代理程式',
      saving: (details: string[]) => `儲存時機：${details.join('；')}。`,
      canCancel: '隨時可以傳 /cancel 取消',
      progress: (step: number, total: number) => `（${step}/${total}）`,
      stepMessage: (progress: string, text: string) => `${progress}${text}`,
      question: (
        step: string,
        question: number,
        total: number,
        text: string,
        maximum = false,
      ) =>
        `${step} · 第 ${question} 題，${maximum ? '最多' : '共'} ${total} 題：${text}`,
      directMessage: '這個私訊',
      origin: (name: string) => `設定來自「${name}」。`,
      idle: '目前沒有進行中的設定',
      cancelled: (credentials: string[], disabledId?: string) => {
        const saved = [
          ...(credentials.length ? [`憑證（${credentials.join('、')}）`] : []),
          ...(disabledId ? [`tsugimori.json（登入前停用 ${disabledId}）`] : []),
        ];
        return saved.length
          ? `已取消設定，本次已儲存${saved.join('、')}。${credentials.length ? '重新執行設定可覆寫憑證。' : ''}`
          : '已取消設定，本次未儲存憑證或設定。';
      },
      replyPrivately: '請直接回覆目前的私訊設定提示以提交憑證。',
      useDirectMessage: '請在機器人的私訊中提交設定憑證。',
      changedOwner: '設定期間，平台或主人身分已變更。',
      alreadyRunning:
        '已有設定流程進行中。請完成設定，或在原聊天室傳 /cancel。',
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
