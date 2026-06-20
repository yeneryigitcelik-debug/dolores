-- ============================================================
-- dolores :: OPT-IN aggressive memory decay
--
-- This file is NOT applied by default. It is only activated when
-- DOLORES_DECAY_MODE=aggressive.
--
-- Schedule via: SELECT cron.schedule('memory-decay', '0 4 * * *', $cmd$<sql>$cmd$);
-- Remove via:   SELECT cron.unschedule('memory-decay');
--
-- Deletes memories that are:
--   • importance < 3 (low-value)
--   • not accessed in 90+ days
--
-- Workspace owners opt in by setting DOLORES_DECAY_MODE=aggressive and calling
-- the enableAggressiveDecay() helper (or executing this SQL directly).
-- ============================================================

SELECT cron.schedule(
  'memory-decay',
  '0 4 * * *',
  $$
    DELETE FROM memories
     WHERE importance < 3
       AND last_accessed < now() - INTERVAL '90 days'
  $$
);
