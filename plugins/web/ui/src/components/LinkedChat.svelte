<script lang="ts">
  import type { AdminChat, ChatRef } from '@tsugimori/plugin-sdk';

  import { chatHref, chatTitle, platformLabel } from '../lib/display.ts';

  let { ref, chat }: { chat?: AdminChat; ref: ChatRef } = $props();
</script>

<span class="tag">{platformLabel(chat?.platform ?? ref.adapterId)}</span>
<a href={chatHref(chat ?? ref)}>{chat ? chatTitle(chat) : ref.chatId}</a>
