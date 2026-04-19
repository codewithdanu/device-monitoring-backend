require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { swaggerUi, specs } = require('./swagger');
const authRoutes = require('./routes/auth');
const path       = require('path');
const fs         = require('fs');
const helmet     = require('helmet');
const compression = require('compression');

const app        = express();

// Startup: Reset all devices to offline
const { query } = require('./db');
query('UPDATE devices SET is_online = FALSE').catch(err => console.error('[Startup] DB reset failed:', err));

app.use(helmet({
  contentSecurityPolicy: false, // Set to false if using Swagger/Dashboard on same domain
}));
app.use(compression());

// DIAGNOSTIC LOGGER: Capture all download attempts at entry
app.use((req, res, next) => {
  if (req.url.includes('/download/')) {
    console.log('[Global Debug] REQ Incoming:', {
      method: req.method,
      url: req.url,
      originalUrl: req.originalUrl,
      query: req.query,
      timestamp: new Date().toISOString()
    });
  }
  next();
});

const httpServer = http.createServer(app);

// CORS Configuration
const corsOrigin = process.env.CORS_ORIGIN || '*';
const allowedOrigins = corsOrigin === '*' ? '*' : corsOrigin.split(',');

// Socket.io with CORS
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
  allowEIO3: true,
});

// Ensure uploads directory exists and is writable
const uploadPath = process.env.UPLOAD_PATH 
  ? path.resolve(process.env.UPLOAD_PATH)
  : path.resolve(__dirname, '../uploads');

if (!fs.existsSync(uploadPath)) {
  try {
    fs.mkdirSync(uploadPath, { recursive: true });
    console.log(`[Startup] Created uploads directory at: ${uploadPath}`);
  } catch (err) {
    console.error(`[Startup ERROR] Could not create uploads directory: ${err.message}`);
  }
}

// Check for write permissions specifically (fixes EACCES issues)
try {
  const stats = fs.statSync(uploadPath);
  console.log(`[Startup] Uploads directory info: UID=${stats.uid}, GID=${stats.gid}, Mode=${stats.mode.toString(8)}`);
  console.log(`[Startup] Process info: UID=${process.getuid()}, GID=${process.getgid()}`);
  
  fs.accessSync(uploadPath, fs.constants.W_OK);
  console.log(`[Startup] Uploads directory is writable: ${uploadPath}`);
} catch (err) {
  console.error('****************************************************************');
  console.error('[Startup CRITICAL] UPLOADS DIRECTORY IS NOT WRITABLE!');
  console.error(`Path: ${uploadPath}`);
  console.error(`Error: ${err.message}`);
  console.error('Current Process: UID=' + process.getuid() + ', GID=' + process.getgid());
  console.error('To fix host permissions, run this on your VPS:');
  console.error(`sudo chown -R ${process.getuid()}:${process.getgid()} ./uploads`);
  console.error('sudo chmod -R 775 ./uploads');
  console.error('****************************************************************');
}

// Middleware
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));

app.use('/uploads', express.static(path.resolve(uploadPath)));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// API Routes
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/devices',  require('./routes/devices'));
app.use('/api/commands', require('./routes/commands'));
app.use('/api/files',    require('./routes/files'));
app.use('/api/metrics',  require('./routes/metrics'));

app.set('io', io);
require('./socket/agentHandler')(io);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.stack);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal Server Error',
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () =>
  console.log(`[Server] Running on port ${PORT}`)
);

module.exports = { io };
