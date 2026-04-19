const { query } = require('./db');

async function migrate() {
    console.log('🚀 Starting 2FA migration...');
    try {
        await query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS two_factor_secret TEXT,
            ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS recovery_codes JSONB DEFAULT '[]'::jsonb;
        `);
        console.log('✅ Migration successful: Added 2FA columns and recovery_codes to users table.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    }
}

migrate();
