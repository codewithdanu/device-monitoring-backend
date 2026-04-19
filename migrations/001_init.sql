-- Device Monitoring System — Initial Migration
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  device_type  TEXT CHECK (device_type IN ('PC','LAPTOP','PHONE')),
  os           TEXT,
  mac_address  TEXT,
  device_token UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
  is_online    BOOLEAN DEFAULT FALSE,
  last_seen    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- High-frequency time-series — optimized with index
CREATE TABLE IF NOT EXISTS metrics (
  id               BIGSERIAL PRIMARY KEY,
  device_id        UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  cpu_percent      NUMERIC(5,2),
  memory_used_mb   INTEGER,
  memory_total_mb  INTEGER,
  disk_used_gb     NUMERIC(10,2),
  disk_total_gb    NUMERIC(10,2),
  battery_percent  SMALLINT,
  recorded_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_metrics_device_time ON metrics (device_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS commands (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id      UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command_type   TEXT NOT NULL,
  command_params JSONB DEFAULT '{}',
  status         TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING','EXECUTED','FAILED')),
  result         JSONB,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  executed_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS locations (
  id              BIGSERIAL PRIMARY KEY,
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  latitude        DOUBLE PRECISION NOT NULL,
  longitude       DOUBLE PRECISION NOT NULL,
  accuracy_meters REAL,
  recorded_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_locations_device_time ON locations (device_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS shared_files (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id     UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  file_size     BIGINT,
  mime_type     TEXT,
  uploaded_at   TIMESTAMPTZ DEFAULT NOW()
);
