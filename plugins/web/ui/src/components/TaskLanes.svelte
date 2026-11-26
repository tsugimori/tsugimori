<script lang="ts">
  import type { AdminTask } from '@tsugimori/plugin-sdk';

  import type { Locale } from '../lib/i18n.ts';

  import { statusStyle } from '../lib/display.ts';
  import { i18n } from '../lib/i18n.ts';
  import { callAnchor, taskLanes, toolStatus } from '../lib/timeline.ts';

  let {
    task,
    start,
    end,
    locale,
  }: { end: number; locale: Locale; start: number; task: AdminTask } = $props();
  const m = $derived(i18n(locale));
  const lanes = $derived(taskLanes(task, start, end));
</script>

<div class="task-lanes">
  <span>{m.modelLane}</span>
  <div class="lane-track model-lane">
    {#each lanes.model as { left, width } (left)}
      <span class="lane-bar" style:left={left + '%'} style:width={width + '%'}
      ></span>
    {/each}
  </div>
  <span>{m.toolLane}</span>
  <div class="lane-track tool-lane">
    {#each lanes.tools as { tool, left, width } (tool.seq)}
      {@const status = statusStyle(toolStatus(tool))}
      <a
        href={'#' + encodeURIComponent(callAnchor(task.id, tool.seq))}
        class="lane-bar {status[0]}"
        style:left={left + '%'}
        style:width={width + '%'}
        title={tool.name + ' · ' + m[status[1]]}
        aria-label={tool.name + ' · ' + m[status[1]]}
      ></a>
    {/each}
  </div>
</div>
