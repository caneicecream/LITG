/**
 * Versioned schema migrations, applied in order by `runMigrations` (npm run db:migrate).
 * Never edit a migration that has been applied: add a new one. Checksums of
 * applied migrations are verified on every run.
 */
export interface Migration {
  version: string;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: "001",
    name: "initial schema: prices, append-only observations, trips, conversations",
    sql: `
CREATE TABLE price_entries (
  id          text PRIMARY KEY,
  kind        text NOT NULL,
  data        jsonb NOT NULL,                 -- current state of the entry (history lives in price_observations)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz                     -- soft delete: observations are never removed
);

CREATE TABLE price_observations (
  id              text PRIMARY KEY,
  entry_id        text NOT NULL REFERENCES price_entries(id),
  kind            text NOT NULL,
  content_hash    text NOT NULL,
  observed_on     date NOT NULL,              -- when the price was seen at the source
  recorded_at     timestamptz NOT NULL,       -- when it entered this system
  origin          text NOT NULL CHECK (origin IN ('entry', 'recheck', 'import', 'adapter')),
  status          text NOT NULL,
  source          text NOT NULL,
  source_url      text,
  notes           text,
  value           bigint,                     -- cents (or points for point charts)
  value_unit      text,
  fingerprint     text,                       -- equivalent-configuration key (stay quotes)
  series_key      text,                       -- fingerprint + tax treatment
  comparable_total_cents bigint,
  resort_id       text,
  room_type_id    text,
  check_in        date,
  check_out       date,
  adults          int,
  children        int,
  booking_method  text,
  ticket_option   text,
  ticket_days     int,
  dining          text,
  tax_included    boolean,
  tax_cents       bigint,
  terms           jsonb,
  assumptions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  snapshot        jsonb NOT NULL,             -- the full entry exactly as observed
  UNIQUE (entry_id, content_hash)
);
CREATE INDEX price_observations_series ON price_observations (series_key, observed_on);
CREATE INDEX price_observations_entry ON price_observations (entry_id, recorded_at);
CREATE INDEX price_observations_recorded ON price_observations (recorded_at);

-- Historical observations are append-only: they can never be changed or removed.
CREATE FUNCTION forbid_observation_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'price_observations is append-only (attempted %)', TG_OP;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER price_observations_append_only
  BEFORE UPDATE OR DELETE ON price_observations
  FOR EACH ROW EXECUTE FUNCTION forbid_observation_changes();

CREATE TABLE trips (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  request     jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE trip_runs (
  id          bigserial PRIMARY KEY,
  trip_id     text NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  run_at      timestamptz NOT NULL,
  snapshot    jsonb NOT NULL,
  UNIQUE (trip_id, run_at)
);

CREATE TABLE conversations (
  id          text PRIMARY KEY,
  title       text NOT NULL,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
`,
  },
  {
    version: "002",
    name: "monitoring: monitors, checks, notifications, settings",
    sql: `
CREATE TABLE monitors (
  id             text PRIMARY KEY,
  trip_id        text NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
  enabled        boolean NOT NULL DEFAULT true,
  settings       jsonb NOT NULL,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  last_check_at  timestamptz,
  next_check_at  timestamptz
);
CREATE INDEX monitors_due ON monitors (enabled, next_check_at);

CREATE TABLE monitor_checks (
  id          text PRIMARY KEY,
  monitor_id  text NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  checked_at  timestamptz NOT NULL,
  trigger     text NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  data        jsonb NOT NULL,
  events      jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX monitor_checks_by_monitor ON monitor_checks (monitor_id, checked_at DESC);

CREATE TABLE notifications (
  id          text PRIMARY KEY,
  monitor_id  text REFERENCES monitors(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key  text NOT NULL UNIQUE,
  read_at     timestamptz,
  delivery    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX notifications_recent ON notifications (created_at DESC);

CREATE TABLE app_settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);
`,
  },
];
