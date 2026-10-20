-- 097 — Returns: the PT's reference (owner, 2026-10-20). Each PT document carries a reference on its lines (reference_no);
--   the returns page shows it and searches it. Filled by lv-dashboard (pts_sync reads up to 20 PTs a run; the page asks for
--   the missing ones with pts_refs). null = not read yet, '' = the PT has no reference.
-- Additive only: one column.
alter table public.pts add column if not exists refs text;
