const { query } = require('../db');

/**
 * Socket.io Agent Handler
 * Handles all agent <-> server communication.
 *
 * Events from agent:
 *   agent:register        — authenticate and join device room
 *   agent:metrics         — push CPU/RAM/Disk/Battery metrics
 *   agent:location        — push GPS location (mobile only)
 *   agent:command_result  — report command execution result
 *
 * Events emitted to dashboard:
 *   device:online         — device came online
 *   device:offline        — device went offline
 *   metrics:update        — new metrics data
 *   location:update       — new location
 *   command:result        — command executed result
 */
module.exports = (io) => {
  io.on('connection', (socket) => {
    console.log(`[Socket] New connection: ${socket.id}`);

    // ---- AGENT REGISTRATION ----
    socket.on('agent:register', async ({ deviceId, deviceToken }) => {
      try {
        if (!deviceId || !deviceToken) {
          return socket.disconnect();
        }

        const { rows: [device] } = await query(
          `SELECT id, name FROM devices WHERE id = $1 AND device_token = $2`,
          [deviceId, deviceToken]
        );

        if (!device) {
          console.warn(`[Socket] Invalid device credentials: ${deviceId}`);
          return socket.disconnect();
        }

        // Join device-specific room
        socket.join(`device:${deviceId}`);
        socket.deviceId = deviceId;

        await query(
          `UPDATE devices SET is_online = TRUE, last_seen = NOW() WHERE id = $1`,
          [deviceId]
        );

        socket.emit('agent:registered');
        io.emit('device:online', { deviceId, name: device.name });
        console.log(`[Socket] Device registered: ${device.name} (${deviceId})`);
      } catch (err) {
        console.error('[Socket] Register error:', err.message);
      }
    });

    // ---- METRICS ----
    socket.on('agent:metrics', async (data) => {
      try {
        const {
          deviceId,
          cpu_percent,
          memory_used_mb,
          memory_total_mb,
          disk_used_gb,
          disk_total_gb,
          battery_percent,
        } = data;

        await query(
          `INSERT INTO metrics
             (device_id, cpu_percent, memory_used_mb, memory_total_mb,
              disk_used_gb, disk_total_gb, battery_percent)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            deviceId,
            cpu_percent,
            memory_used_mb,
            memory_total_mb,
            disk_used_gb,
            disk_total_gb,
            battery_percent ?? null,
          ]
        );

        await query(
          `UPDATE devices SET last_seen = NOW() WHERE id = $1`,
          [deviceId]
        );

        // Broadcast to all dashboard clients
        io.emit('metrics:update', { ...data, recorded_at: new Date().toISOString() });
      } catch (err) {
        console.error('[Socket] Metrics error:', err.message);
      }
    });

    // ---- LOCATION ----
    socket.on('agent:location', async ({ deviceId, latitude, longitude, accuracy_meters }) => {
      try {
        await query(
          `INSERT INTO locations (device_id, latitude, longitude, accuracy_meters)
           VALUES ($1, $2, $3, $4)`,
          [deviceId, latitude, longitude, accuracy_meters]
        );

        io.emit('location:update', { deviceId, latitude, longitude, accuracy_meters });
      } catch (err) {
        console.error('[Socket] Location error:', err.message);
      }
    });

    // ---- COMMAND RESULT ----
    socket.on('agent:command_result', async ({ commandId, status, result }) => {
      try {
        await query(
          `UPDATE commands
           SET status = $1, result = $2, executed_at = NOW()
           WHERE id = $3`,
          [status, JSON.stringify(result), commandId]
        );

        io.emit('command:result', { commandId, status, result });
      } catch (err) {
        console.error('[Socket] Command result error:', err.message);
      }
    });

    // ---- DISCONNECT ----
    socket.on('disconnect', async () => {
      if (socket.deviceId) {
        try {
          await query(
            `UPDATE devices SET is_online = FALSE WHERE id = $1`,
            [socket.deviceId]
          );
          io.emit('device:offline', { deviceId: socket.deviceId });
          console.log(`[Socket] Device offline: ${socket.deviceId}`);
        } catch (err) {
          console.error('[Socket] Disconnect update error:', err.message);
        }
      } else {
        console.log(`[Socket] Client disconnected: ${socket.id}`);
      }
    });
  });
};
