const jwt = require('jsonwebtoken');

/**
 * Auth middleware — verifies JWT Bearer token.
 * Attaches decoded payload to req.user.
 */
module.exports = (req, res, next) => {
  const authHeader = req.headers.authorization;
  let token = authHeader?.split(' ')[1] || req.query.token;

  // AGGRESSIVE FALLBACK: Regex parsing from raw URL strings
  // This bypasses any issues with Express query parsing
  if (!token) {
    const tokenRegex = /[?&]token=([^&]+)/;
    const match = req.originalUrl.match(tokenRegex) || req.url.match(tokenRegex);
    if (match && match[1]) {
      token = match[1];
      console.log('[Auth Info] Token extracted via Regex from URL');
    }
  }

  // DEBUG: Specific logging for download attempts
  if (req.path.includes('/download/')) {
    console.log('[Auth Debug] Download Request Detail:', {
      path: req.path,
      tokenFound: !!token,
      method: req.method,
      rawUrl: req.url,
      originalUrl: req.originalUrl
    });
  }

  // Trim whitespace
  if (token && typeof token === 'string') {
    token = token.trim();
  }

  if (!token) {
    if (req.path.includes('/download/')) {
       console.warn(`[Auth Warning] No token provided for: ${req.originalUrl}`);
    }
    return res.status(401).json({ error: 'DEBUG_TOKEN_MISSING_V4' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    if (req.path.includes('/download/')) {
       console.error(`[Auth Error] Token verification failed for ${req.originalUrl}:`, err.message);
    }
    res.status(403).json({ error: 'Invalid or expired token' });
  }
};
