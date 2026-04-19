const { query } = require('./db');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

async function seed() {
  console.log('🌱 Starting database seeding...');

  try {
    // 1. Clear existing data (optional, but good for clean seed)
    // await query('TRUNCATE users, devices, metrics, locations, commands, shared_files CASCADE');

    // 2. Create Admin User
    const passwordHash = await bcrypt.hash('admin123', 10);
    const userResult = await query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id',
      ['admin', passwordHash]
    );
    const userId = userResult.rows[0].id;
    console.log(`✅ User 'admin' created/updated (ID: ${userId})`);

    // 3. Create Sample Devices (Idempotent)
    const devices = [
      { name: 'Workstation-X', type: 'PC', os: 'Windows 11 Pro', mac: '00:15:5D:01:22:A1' },
      { name: 'MacBook-Pro-Danu', type: 'LAPTOP', os: 'macOS Sonoma', mac: '3C:06:30:4F:11:0B' },
      { name: 'Danu-Pixel-8', type: 'PHONE', os: 'Android 14', mac: null }
    ];

    for (const d of devices) {
      const existing = await query('SELECT id FROM devices WHERE user_id = $1 AND name = $2', [userId, d.name]);
      
      if (existing.rows.length > 0) {
        console.log(`ℹ️ Device '${d.name}' already exists, skipping...`);
        continue;
      }

      const res = await query(
        'INSERT INTO devices (user_id, name, device_type, os, mac_address, is_online, last_seen) VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL \'2 minutes\') RETURNING id',
        [userId, d.name, d.type, d.os, d.mac, false]
      );
      const deviceId = res.rows[0].id;
      console.log(`✅ Device '${d.name}' registered`);

      // 4. Create Sample Metrics (Only for new PC)
      if (d.name === 'Workstation-X') {
        for (let i = 0; i < 20; i++) {
            const time = new Date(Date.now() - (i * 5 * 60 * 1000));
            await query(
                'INSERT INTO metrics (device_id, cpu_percent, memory_used_mb, memory_total_mb, disk_used_gb, disk_total_gb, recorded_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [deviceId, (10 + Math.random() * 40).toFixed(2), Math.floor(4096 + (Math.random() * 2048)), 16384, 256, 1024, time]
            );
        }
        console.log('✅ Telemetry metrics seeded for Workstation-X');
      }

      // 5. Create Sample Locations (Only for new Phone)
      if (d.name === 'Danu-Pixel-8') {
        const baseLat = -6.2088;
        const baseLng = 106.8456;
        for (let i = 0; i < 10; i++) {
            const time = new Date(Date.now() - (i * 15 * 60 * 1000));
            await query(
                'INSERT INTO locations (device_id, latitude, longitude, accuracy_meters, recorded_at) VALUES ($1, $2, $3, $4, $5)',
                [deviceId, baseLat + (Math.random() * 0.01), baseLng + (Math.random() * 0.01), 10 + Math.random() * 20, time]
            );
        }
        console.log('✅ GPS location history seeded for Danu-Pixel-8');
      }

      // 6. Create Sample Commands
      await query(
          "INSERT INTO commands (device_id, command_type, status, result, created_at, executed_at) VALUES ($1, $2, $3, $4, NOW(), NOW())",
          [deviceId, d.type === 'PC' ? 'LOCK_SCREEN' : 'RING_ALARM', 'EXECUTED', JSON.stringify({ success: true })]
      );
    }

    console.log('\n🌟 Seeding completed successfully!');
    process.exit(0);

  } catch (err) {
    console.error('❌ Seeding failed:', err.message);
    process.exit(1);
  }
}

seed();
