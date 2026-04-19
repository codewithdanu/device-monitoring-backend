const router    = require('express').Router();
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const auth      = require('../middleware/authMiddleware');
const { query } = require('../db');

const uploadPath = process.env.UPLOAD_PATH 
  ? path.resolve(process.env.UPLOAD_PATH)
  : path.resolve(__dirname, '../../uploads');

// Multer disk storage — files saved with timestamp prefix
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._/]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

// POST /api/files/upload — agent or dashboard uploads a file
// We use a custom auth check to allow both agents (via deviceToken) and users (via JWT)
router.post('/upload', async (req, res, next) => {
  // If Authorization header is present, it's likely from the dashboard
  if (req.headers.authorization) {
    return auth(req, res, next);
  }
  next(); // Proceed to upload handler for agents
}, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { deviceId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId required' });
    }

    // If authenticated via dashboard, verify device ownership
    if (req.user) {
      const { rows: [device] } = await query(
        'SELECT id FROM devices WHERE id = $1 AND user_id = $2',
        [deviceId, req.user.userId]
      );
      if (!device) return res.status(403).json({ error: 'Forbidden: Device does not belong to you' });
    }

    const { originalname, filename, size, mimetype } = req.file;
    const { rows: [file] } = await query(
      `INSERT INTO shared_files (device_id, original_name, stored_name, file_size, mime_type)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, uploaded_at`,
      [deviceId, originalname, filename, size, mimetype]
    );

    res.status(201).json({
      fileId:      file.id,
      fileName:    originalname,
      uploaded_at: file.uploaded_at,
    });
  } catch (err) {
    console.error('[Files] Upload error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/files/:deviceId — list files for a device
/**
 * @openapi
 * /api/files/{deviceId}:
 *   get:
 *     summary: List files on a specific device
 *     tags: [Files]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema:
 *           type: string
 *   post:
 *     summary: Request/Upload a file from a device
 *     tags: [Files]
 *     security:
 *       - bearerAuth: []
 */
router.get('/:deviceId', auth, async (req, res) => {
  try {
    // Verify device ownership
    const { rows: [device] } = await query(
      `SELECT id FROM devices WHERE id = $1 AND user_id = $2`,
      [req.params.deviceId, req.user.userId]
    );
    if (!device) return res.status(403).json({ error: 'Forbidden' });

    const { rows } = await query(
      `SELECT id, original_name, stored_name, file_size, mime_type, uploaded_at
       FROM shared_files
       WHERE device_id = $1
       ORDER BY uploaded_at DESC`,
      [req.params.deviceId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[Files] List error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/files/download/:fileId — download a file (attachment)
router.get('/download/:fileId', auth, async (req, res) => {
  try {
    const { rows: [file] } = await query(
      `SELECT sf.*, d.user_id FROM shared_files sf
       JOIN devices d ON d.id = sf.device_id
       WHERE sf.id = $1`,
      [req.params.fileId]
    );

    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.user_id !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });

    const filePath = path.join(uploadPath, file.stored_name);
    
    if (!fs.existsSync(filePath)) {
      console.warn(`[Files] Download failed: File not found on disk at ${filePath}`);
      return res.status(404).json({ error: 'Physical file not found on server disk.' });
    }

    res.download(filePath, file.original_name, (err) => {
      if (err) {
        console.error('[Files] Error during res.download:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download stream failed' });
        }
      }
    });
  } catch (err) {
    console.error('[Files] Download error:', err.stack);
    res.status(500).json({ error: 'Internal server error during download' });
  }
});

// GET /api/files/view/:fileId — view a file (inline)
router.get('/view/:fileId', auth, async (req, res) => {
  try {
    const { rows: [file] } = await query(
      `SELECT sf.*, d.user_id FROM shared_files sf
       JOIN devices d ON d.id = sf.device_id
       WHERE sf.id = $1`,
      [req.params.fileId]
    );

    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.user_id !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });

    const filePath = path.join(uploadPath, file.stored_name);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    // sendFile sends it inline, allowing previews
    res.sendFile(filePath, (err) => {
      if (err) {
        console.error('[Files] Error during res.sendFile:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream file preview' });
        }
      }
    });
  } catch (err) {
    console.error('[Files] View error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/files/:fileId — delete a file
router.delete('/:fileId', auth, async (req, res) => {
  try {
    // Verify ownership via join
    const { rows: [file] } = await query(
      `SELECT sf.stored_name, d.user_id FROM shared_files sf
       JOIN devices d ON d.id = sf.device_id
       WHERE sf.id = $1`,
      [req.params.fileId]
    );

    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.user_id !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });

    await query(`DELETE FROM shared_files WHERE id = $1`, [req.params.fileId]);

    const filePath = path.join(uploadPath, file.stored_name);
    fs.unlink(filePath, (err) => {
      if (err) console.warn('[Files] Could not delete file from disk:', err.message);
    });

    res.json({ message: 'File deleted' });
  } catch (err) {
    console.error('[Files] Delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
