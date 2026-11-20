require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host:                    process.env.DB_HOST,
  port:                    parseInt(process.env.DB_PORT),
  database:                process.env.DB_NAME,
  user:                    process.env.DB_USER,
  password:                process.env.DB_PASSWORD,
  max:                     parseInt(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis:       parseInt(process.env.DB_POOL_IDLE_TIMEOUT) || 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT) || 2000,
});

pool.on('error', (err) => console.error('DB pool error:', err));
pool.on('connect', () => console.log('[DB] New client connected to pool'));

const query = (text, params) => pool.query(text, params);

// Auto-migration for activities & Traccar tracking columns
(async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS activities (
        id BIGSERIAL PRIMARY KEY,
        device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        package_name TEXT NOT NULL,
        app_name TEXT NOT NULL,
        activity TEXT NOT NULL,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_activities_device_time ON activities (device_id, recorded_at DESC);

      ALTER TABLE devices
        ADD COLUMN IF NOT EXISTS tracker_device_id TEXT UNIQUE,
        ADD COLUMN IF NOT EXISTS tracker_last_ping_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS tracker_battery_level REAL;

      UPDATE devices
      SET tracker_device_id = 'DMS-' || UPPER(SUBSTRING(id::text FROM 1 FOR 8))
      WHERE tracker_device_id IS NULL;

      ALTER TABLE locations
        ADD COLUMN IF NOT EXISTS battery_level REAL,
        ADD COLUMN IF NOT EXISTS speed REAL;
    `);
    console.log('[DB] Auto-migration complete for activities & Traccar tracking');
  } catch (err) {
    console.error('[DB] Auto-migration error:', err.message);
  }
})();

const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { query, withTransaction, pool };
