const router    = require('express').Router();
const auth      = require('../middleware/authMiddleware');
const { query } = require('../db');

// GET /api/metrics/:deviceId?hours=1 — get time-series metrics
/**
 * @openapi
 * /api/metrics/{deviceId}:
 *   get:
 *     summary: Retrieve history metrics for a device
 *     tags: [Metrics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/:deviceId', auth, async (req, res) => {
  try {
    // Verify device ownership
    const { rows: [device] } = await query(
      `SELECT id FROM devices WHERE id = $1 AND user_id = $2`,
      [req.params.deviceId, req.user.userId]
    );
    if (!device) return res.status(403).json({ error: 'Forbidden' });

    const hours = Math.min(parseInt(req.query.hours || '1'), 24); // cap at 24h
    const { rows } = await query(
      `SELECT cpu_percent, memory_used_mb, memory_total_mb,
              disk_used_gb, disk_total_gb, battery_percent, recorded_at
       FROM metrics
       WHERE device_id = $1
         AND recorded_at > NOW() - ($2 || ' hours')::INTERVAL
       ORDER BY recorded_at ASC`,
      [req.params.deviceId, hours]
    );

    res.json(rows);
  } catch (err) {
    console.error('[Metrics] Get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
