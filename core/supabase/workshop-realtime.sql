-- Realtime for the workshop worker: it subscribes to workshop_tasks UPDATEs
-- (status -> pending picks up a task; status -> cancelled kills the run).
-- replica identity full so UPDATE payloads carry the row. Safe to rerun.
alter table workshop_tasks replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'workshop_tasks'
  ) then
    alter publication supabase_realtime add table workshop_tasks;
  end if;
end $$;
