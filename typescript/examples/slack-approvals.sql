CREATE SCHEMA IF NOT EXISTS slack_recipe;

CREATE TABLE IF NOT EXISTS slack_recipe.approval (
  task_id uuid NOT NULL,
  wait_name text NOT NULL,
  wait_created_at timestamptz NOT NULL,
  attempt integer NOT NULL,
  reference text NOT NULL UNIQUE,
  team_id text NOT NULL,
  app_id text NOT NULL,
  channel_id text NOT NULL,
  authorized_users text[] NOT NULL CHECK (cardinality(authorized_users) > 0),
  message_ts text NOT NULL,
  expires_at timestamptz NOT NULL,
  decision text CHECK (decision IN ('approve', 'reject')),
  decision_key uuid UNIQUE,
  actor text,
  accepted_at timestamptz,
  settlement text,
  settled_at timestamptz,
  PRIMARY KEY (task_id, wait_name, wait_created_at, attempt),
  CHECK ((decision IS NULL AND decision_key IS NULL AND actor IS NULL AND accepted_at IS NULL)
      OR (decision IS NOT NULL AND decision_key IS NOT NULL AND actor IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK ((settlement IS NULL) = (settled_at IS NULL))
);

CREATE INDEX IF NOT EXISTS approval_inbox ON slack_recipe.approval (accepted_at)
  WHERE decision IS NOT NULL AND settlement IS NULL;
