CREATE TABLE IF NOT EXISTS activities (
  id              BIGSERIAL PRIMARY KEY,
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  package_name    TEXT NOT NULL,
  app_name        TEXT NOT NULL,
  activity        TEXT NOT NULL,
  recorded_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activities_device_time ON activities (device_id, recorded_at DESC);
