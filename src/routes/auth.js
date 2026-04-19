const router  = require('express').Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const { query } = require('../db');
const { authLimiter } = require('../middleware/rateLimiter');
const authMiddleware = require('../middleware/authMiddleware');

// Helper to generate recovery codes
function generateRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < 8; i++) {
    codes.push(Math.random().toString(36).substring(2, 10).toUpperCase());
  }
  return codes;
}

// POST /api/auth/register
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await query(
      `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at`,
      [username, hash]
    );

    res.status(201).json({ message: 'User created', user: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Username already exists' });
    }
    console.error('[Auth] Register error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const { rows } = await query(
      `SELECT * FROM users WHERE username = $1`,
      [username]
    );
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if 2FA is enabled
    if (user.two_factor_enabled) {
      const tempToken = jwt.sign(
        { userId: user.id, awaiting2FA: true },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({ twoFactorRequired: true, tempToken });
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, userId: user.id, username: user.username });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login/2fa — verify 2FA code during login
router.post('/login/2fa', authLimiter, async (req, res) => {
  try {
    const { code, tempToken } = req.body;
    if (!code || !tempToken) {
      return res.status(400).json({ error: 'Code and tempToken required' });
    }

    const decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
    if (!decoded.awaiting2FA) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { rows } = await query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    const user = rows[0];

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify code or recovery code
    const isValid = authenticator.verify({ token: code, secret: user.two_factor_secret });
    const isRecovery = user.recovery_codes.includes(code);

    if (!isValid && !isRecovery) {
      return res.status(401).json({ error: 'Invalid authentication code' });
    }

    // If recovery code used, remove it
    if (isRecovery) {
      const remainingCodes = user.recovery_codes.filter(c => c !== code);
      await query('UPDATE users SET recovery_codes = $1 WHERE id = $2', [JSON.stringify(remainingCodes), user.id]);
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, userId: user.id, username: user.username });
  } catch (err) {
    res.status(401).json({ error: 'Session expired or invalid' });
  }
});

// POST /api/auth/password/update — change password
router.post('/password/update', authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];

    const valid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect current password' });

    const newHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.userId]);

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2FA Management (Protected)
router.post('/2fa/setup', authMiddleware, async (req, res) => {
  try {
    const secret = authenticator.generateSecret();
    const username = req.user.username || 'User';
    const otpauth = authenticator.keyuri(username, 'DeviceControl', secret);
    const qrImage = await qrcode.toDataURL(otpauth);
    
    // Temporarily store secret (un-verified)
    await query('UPDATE users SET two_factor_secret = $1 WHERE id = $2', [secret, req.user.userId]);
    
    res.json({ secret, qrImage });
  } catch (err) {
    console.error('2FA Setup Error:', err);
    res.status(500).json({ 
      error: 'Failed to generate setup',
      message: err.message,
      stack: err.stack
    });
  }
});

router.post('/2fa/verify', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    const { rows } = await query('SELECT two_factor_secret FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];

    const isValid = authenticator.verify({ token: code, secret: user.two_factor_secret });
    if (!isValid) return res.status(400).json({ error: 'Invalid verification code' });

    const recoveryCodes = generateRecoveryCodes();
    await query(
      'UPDATE users SET two_factor_enabled = TRUE, recovery_codes = $1 WHERE id = $2', 
      [JSON.stringify(recoveryCodes), req.user.userId]
    );

    res.json({ message: '2FA enabled successfully', recoveryCodes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to verify code' });
  }
});

router.post('/2fa/disable', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    const { rows } = await query('SELECT two_factor_secret, two_factor_enabled FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];

    if (!user.two_factor_enabled) return res.status(400).json({ error: '2FA not enabled' });

    const isValid = authenticator.verify({ token: code, secret: user.two_factor_secret });
    if (!isValid) return res.status(400).json({ error: 'Invalid verification code' });

    await query(
      'UPDATE users SET two_factor_enabled = FALSE, two_factor_secret = NULL, recovery_codes = $1::jsonb WHERE id = $2', 
      [null, req.user.userId]
    );

    res.json({ message: '2FA disabled successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disable 2FA' });
  }
});

// GET /api/auth/me — verify token + return user info
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, username, created_at, two_factor_enabled FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
