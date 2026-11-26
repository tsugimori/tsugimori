import type { ChatRef, TaskRefs } from '@tsugimori/plugin-sdk';
import type { ActiveTaskRefs } from '@tsugimori/storage';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';

import { sql } from 'drizzle-orm';

import { decodeRecord } from './record-codec.ts';

export function recordUsage(db: NodeSQLiteDatabase) {
  return db.get<{ bytes: number; oldestFullTaskAt: number | null }>(sql`
    SELECT
      coalesce((SELECT sum(bytes) FROM task_records), 0)
      + coalesce((SELECT sum(length(cast(data AS blob))) FROM task_events), 0)
      + coalesce((SELECT sum(length(cast(content AS blob))) FROM context_blobs), 0)
      + coalesce((SELECT sum(coalesce(length(raw_z), length(cast(raw AS blob)))) FROM messages), 0)
      + coalesce((SELECT sum(length(cast(text AS blob))) FROM chat_summary_versions), 0) AS bytes,
      (SELECT min(created_at) FROM task_records WHERE pruned = 0) AS oldestFullTaskAt
  `)!;
}

export function pruneRecords(
  db: NodeSQLiteDatabase,
  maxBytes: number,
  active: readonly ActiveTaskRefs[] = [],
) {
  return db.transaction(
    (tx) => {
      const initial = recordUsage(db).bytes;
      const target = Math.floor(maxBytes * 0.9);
      let bytes = initial;
      let tasks = 0;
      if (initial <= maxBytes) return { bytes: 0, tasks };
      const activeIds = JSON.stringify(active.map(({ taskId }) => taskId));
      while (bytes > target) {
        const batch = tx.all<{ bytes: number; id: string }>(sql`
        SELECT t.id,
          coalesce(length(cast(r.input AS blob)), 0)
          + coalesce(length(cast(r.output AS blob)), 0)
          + coalesce((SELECT sum(length(cast(e.data AS blob))) FROM task_events e WHERE e.task_id = t.id), 0) AS bytes
        FROM tasks t LEFT JOIN task_records r ON r.task_id = t.id
        WHERE t.status NOT IN ('queued', 'running', 'sending')
          AND t.id NOT IN (SELECT value FROM json_each(${activeIds}))
          AND ((r.pruned = 0 AND (r.input IS NOT NULL OR r.output IS NOT NULL))
            OR EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id))
        ORDER BY t.created_at, t.id LIMIT 100
      `);
        if (!batch.length) break;
        for (const row of batch) {
          tx.run(sql`DELETE FROM task_events WHERE task_id = ${row.id}`);
          tx.run(sql`
          UPDATE task_records SET bytes = bytes - coalesce(length(cast(input AS blob)), 0)
            - coalesce(length(cast(output AS blob)), 0), input = NULL, output = NULL, pruned = 1
          WHERE task_id = ${row.id}
        `);
          tx.run(
            sql`UPDATE tool_calls SET args = NULL, result = NULL WHERE task_id = ${row.id}`,
          );
          bytes -= row.bytes;
          tasks++;
          if (bytes <= target) break;
        }
      }
      while (bytes > target) {
        const batch = tx.all<{ bytes: number; seq: number }>(sql`
        SELECT seq, coalesce(length(raw_z), length(cast(raw AS blob))) AS bytes FROM messages
        WHERE raw_z IS NOT NULL OR raw IS NOT NULL ORDER BY seq LIMIT 100
      `);
        if (!batch.length) break;
        for (const row of batch) {
          tx.run(
            sql`UPDATE messages SET raw = NULL, raw_z = NULL WHERE seq = ${row.seq}`,
          );
          bytes -= row.bytes;
          if (bytes <= target) break;
        }
      }
      if (bytes > target) {
        const blobs = new Set<string>();
        const summaries = new Set<string>();
        const preserve = (
          { adapterId, chatId }: ChatRef,
          refs: Pick<TaskRefs, 'workspace' | 'summary'>,
        ) => {
          for (const file of refs.workspace?.files ?? [])
            if (file.blob) blobs.add(file.sha256);
          if (refs.summary)
            summaries.add(
              JSON.stringify([
                adapterId,
                refs.summary.chatId ?? chatId,
                refs.summary.revision,
              ]),
            );
        };
        for (const task of active) preserve(task, task.refs);
        for (const row of tx.all<ChatRef & { refs: string | Uint8Array }>(sql`
          SELECT r.refs, t.adapter_id AS adapterId, t.chat_id AS chatId FROM task_records r
          JOIN tasks t ON t.id = r.task_id
        `))
          preserve(row, decodeRecord<TaskRefs>(row.refs));
        const unused = tx.all<{
          adapter: string | null;
          bytes: number;
          chat: string | null;
          hash: string | null;
          revision: number | null;
        }>(sql`
        SELECT sha256 AS hash, NULL AS adapter, NULL AS chat, NULL AS revision,
          length(cast(content AS blob)) AS bytes, created_at FROM context_blobs
        UNION ALL
        SELECT NULL, v.adapter_id, v.chat_id, v.revision,
          length(cast(v.text AS blob)), v.created_at FROM chat_summary_versions v
        WHERE NOT EXISTS (SELECT 1 FROM chat_summaries c
          WHERE c.adapter_id = v.adapter_id AND c.chat_id = v.chat_id AND c.revision = v.revision)
        ORDER BY created_at, hash, adapter, chat, revision
      `);
        for (const row of unused) {
          if (row.hash !== null) {
            if (blobs.has(row.hash)) continue;
            tx.run(sql`DELETE FROM context_blobs WHERE sha256 = ${row.hash}`);
          } else {
            if (
              summaries.has(
                JSON.stringify([row.adapter, row.chat, row.revision]),
              )
            )
              continue;
            tx.run(sql`DELETE FROM chat_summary_versions WHERE adapter_id = ${row.adapter}
            AND chat_id = ${row.chat} AND revision = ${row.revision}`);
          }
          bytes -= row.bytes;
          if (bytes <= target) break;
        }
      }
      return { bytes: initial - bytes, tasks };
    },
    { behavior: 'immediate' },
  );
}
