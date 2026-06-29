-- Add an idempotency key so Slack's retried deliveries can't double-post.
-- Existing rows keep slack_key = NULL (allowed by the partial unique index).
alter table posts add column if not exists slack_key text;
create unique index if not exists posts_slack_key_uniq on posts (slack_key) where slack_key is not null;
