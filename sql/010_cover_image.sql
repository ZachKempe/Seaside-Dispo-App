-- Lets a deal carry a hero photo URL that gets embedded at the top of
-- marketing emails (buyers currently see a blank header).
alter table deal_acquisition add column if not exists cover_image_url text default '';
