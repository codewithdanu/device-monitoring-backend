const router    = require('express').Router();
const auth      = require('../middleware/authMiddleware');
const { query } = require('../db');

// POST /api/commands/:deviceId — send a command to a device
/**
 * @openapi
 * /api/commands/{deviceId}:
 *   post:
 *     summary: Issue a command to a device
 *     tags: [Commands]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               command_type:
 *                 type: string
 *               command_params:
 *                 type: object
 *     responses:
 *       200:
 *         description: Command accepted and queued
 */
router.post('/:deviceId', auth, async (req, res) => {
  try {
    const { command_type, command_params = {} } = req.body;

    if (!command_type) {
      return res.status(400).json({ error: 'command_type required' });
    }

    // Verify device belongs to this user
    const { rows: [device] } = await query(
      `SELECT id, is_online FROM devices WHERE id = $1 AND user_id = $2`,
      [req.params.deviceId, req.user.userId]
    );
    if (!device) return res.status(403).json({ error: 'Forbidden' });

    // Insert command record
    const { rows: [cmd] } = await query(
      `INSERT INTO commands (device_id, command_type, command_params)
       VALUES ($1, $2, $3) RETURNING id, created_at`,
      [req.params.deviceId, command_type, JSON.stringify(command_params)]
    );

    // Emit command to device via Socket.io
    const io = req.app.get('io');
    io.to(`device:${req.params.deviceId}`).emit('command', {
      commandId:      cmd.id,
      command_type,
      command_params,
    });

    res.json({
      commandId:  cmd.id,
      status:     'PENDING',
      created_at: cmd.created_at,
      device_online: device.is_online,
    });
  } catch (err) {
    console.error('[Commands] Send error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/commands/:deviceId/history — get command history
router.get('/:deviceId/history', auth, async (req, res) => {
  try {
    // Verify device belongs to this user
    const { rows: [device] } = await query(
      `SELECT id FROM devices WHERE id = $1 AND user_id = $2`,
      [req.params.deviceId, req.user.userId]
    );
    if (!device) return res.status(403).json({ error: 'Forbidden' });

    const { rows } = await query(
      `SELECT id, command_type, command_params, status, result, created_at, executed_at
       FROM commands
       WHERE device_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.params.deviceId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[Commands] History error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
