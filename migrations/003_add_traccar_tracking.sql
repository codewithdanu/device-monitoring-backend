-- Migration 003: Traccar Client GPS tracking support
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS tracker_device_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS tracker_last_ping_at TIMESTAMPTZ;

UPDATE devices
SET tracker_device_id = 'DMS-' || UPPER(SUBSTRING(id::text FROM 1 FOR 8))
WHERE tracker_device_id IS NULL;

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS battery_level REAL,
  ADD COLUMN IF NOT EXISTS speed REAL;
