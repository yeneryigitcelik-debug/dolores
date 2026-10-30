-- ============================================================
-- dolores :: OPT-IN aggressive memory decay
--
-- This file is NOT applied by default. It is only activated when
-- DOLORES_DECAY_MODE=aggressive.
--
-- Schedule via: SELECT cron.schedule('memory-decay', '0 4 * * *', $cmd$<sql>$cmd$);
-- Remove via:   SELECT cron.unschedule('memory-decay');
--               (or the disableAggressiveDecay() helper, which is a no-op when
--                the job does not exist)
--
-- Deletes memories that are:
--   • importance < 3 (low-value)
--   • not accessed in 90+ days
--   • NOT referenced by another memory's superseded_by. Deleting a referenced
--     row would fire ON DELETE SET NULL and make the predecessor falsely active.
--
-- Workspace owners opt in by setting DOLORES_DECAY_MODE=aggressive and calling
-- the enableAggressiveDecay() helper (or executing this SQL directly).
-- ============================================================

SELECT cron.schedule(
  'memory-decay',
  '0 4 * * *',
  $$
    DELETE FROM memories m
     WHERE m.importance < 3
       AND m.last_accessed < now() - INTERVAL '90 days'
       AND NOT EXISTS (
         SELECT 1 FROM memories predecessor
          WHERE predecessor.superseded_by = m.id
       )
  $$
);
