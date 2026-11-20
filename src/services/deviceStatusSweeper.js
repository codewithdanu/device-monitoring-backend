const { query } = require('../db');

const TRACKER_OFFLINE_TIMEOUT_MS = 180 * 1000; // 3 minutes

/**
 * Periodically sweeps registered devices to verify if they are still online.
 * A device remains online if:
 * 1. It has an active WebSocket connection in Socket.io room `device:${deviceId}`
 * 2. OR it received a Traccar ping within the last 3 minutes.
 * Otherwise, it is marked offline and broadcasts `device:offline`.
 */
function startDeviceStatusSweeper(io) {
  if (!io) return null;

  const intervalId = setInterval(async () => {
    try {
      const { rows: devices } = await query(
        `SELECT id, name, is_online, tracker_last_ping_at
         FROM devices
         WHERE is_online = TRUE`
      );

      if (!devices || devices.length === 0) return;

      const now = Date.now();
      for (const dev of devices) {
        // 1. Check if WebSocket room has any active sockets
        const socketRoom = io.sockets.adapter.rooms.get(`device:${dev.id}`);
        const hasActiveSocket = Boolean(socketRoom && socketRoom.size > 0);

        if (hasActiveSocket) {
          continue; // Device has an active streaming agent
        }

        // 2. Check if Traccar ping is recent
        const pingTime = dev.tracker_last_ping_at ? new Date(dev.tracker_last_ping_at).getTime() : 0;
        const hasRecentTracker = pingTime > 0 && (now - pingTime <= TRACKER_OFFLINE_TIMEOUT_MS);

        if (!hasRecentTracker) {
          await query(
            `UPDATE devices SET is_online = FALSE WHERE id = $1`,
            [dev.id]
          );
          io.emit('device:offline', { deviceId: dev.id });
          console.log(`[StatusSweeper] Device marked offline: ${dev.name} (${dev.id})`);
        }
      }
    } catch (err) {
      console.error('[StatusSweeper] Sweep error:', err.message);
    }
  }, 30 * 1000); // Sweep every 30 seconds

  return intervalId;
}

module.exports = { startDeviceStatusSweeper, TRACKER_OFFLINE_TIMEOUT_MS };
