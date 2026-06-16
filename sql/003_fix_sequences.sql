-- Advance the auto-increment counters past the migrated explicit IDs so new
-- inserts (from sync-buyers, the dashboard, etc.) don't collide with existing rows.
select setval(pg_get_serial_sequence('buyers', 'id'), (select coalesce(max(id), 1) from buyers));
select setval(pg_get_serial_sequence('facebook_posts', 'id'), (select coalesce(max(id), 1) from facebook_posts));
select setval(pg_get_serial_sequence('buyer_activity', 'id'), (select coalesce(max(id), 1) from buyer_activity));
