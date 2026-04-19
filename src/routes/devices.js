const router    = require('express').Router();
const auth      = require('../middleware/authMiddleware');
const { query } = require('../db');

// POST /api/devices/register — register a new device
router.post('/register', auth, async (req, res) => {
  try {
    const { name, device_type, os, mac_address } = req.body;

    if (!name || !device_type) {
      return res.status(400).json({ error: 'name and device_type required' });
    }

    const validTypes = ['PC', 'LAPTOP', 'PHONE'];
    if (!validTypes.includes(device_type)) {
      return res.status(400).json({ error: `device_type must be one of: ${validTypes.join(', ')}` });
    }

    const { rows } = await query(
      `INSERT INTO devices (user_id, name, device_type, os, mac_address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, device_token, name, device_type`,
      [req.user.userId, name, device_type, os || null, mac_address || null]
    );

    res.status(201).json({
      deviceId:    rows[0].id,
      deviceToken: rows[0].device_token,
      name:        rows[0].name,
      device_type: rows[0].device_type,
    });
  } catch (err) {
    console.error('[Devices] Register error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/devices — list all devices for current user
/**
 * @openapi
 * /api/devices:
 *   get:
 *     summary: List all registered devices
 *     tags: [Devices]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of devices
 *   post:
 *     summary: Register a new device
 *     tags: [Devices]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               device_type:
 *                 type: string
 *               os:
 *                 type: string
 *               mac_address:
 *                 type: string
 *     responses:
 *       201:
 *         description: Device registered successfully
 */
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, device_type, os, is_online, last_seen, mac_address, created_at
       FROM devices WHERE user_id = $1 ORDER BY name ASC`,
      [req.user.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[Devices] List error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/devices/:id — get single device + last 60 metrics
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows: [device] } = await query(
      `SELECT * FROM devices WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const { rows: metrics } = await query(
      `SELECT cpu_percent, memory_used_mb, memory_total_mb,
              disk_used_gb, disk_total_gb, battery_percent, recorded_at
       FROM metrics
       WHERE device_id = $1
       ORDER BY recorded_at DESC
       LIMIT 60`,
      [req.params.id]
    );

    res.json({ device, metrics: metrics.reverse() });
  } catch (err) {
    console.error('[Devices] Get error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/devices/:id/location — get last known location
router.get('/:id/location', auth, async (req, res) => {
  try {
    const { rows: [device] } = await query(
      `SELECT id FROM devices WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );
    if (!device) return res.status(403).json({ error: 'Forbidden' });

    const { rows } = await query(
      `SELECT latitude, longitude, accuracy_meters, recorded_at
       FROM locations WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
      [req.params.id]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error('[Devices] Location error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/devices/:id — remove device
router.delete('/:id', auth, async (req, res) => {
  try {
    const { rows } = await query(
      `DELETE FROM devices WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Device not found' });
    res.json({ message: 'Device deleted' });
  } catch (err) {
    console.error('[Devices] Delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
