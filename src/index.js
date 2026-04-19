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

// Production Middlewares
app.use(helmet({
  contentSecurityPolicy: false, // Set to false if using Swagger/Dashboard on same domain
}));
app.use(compression());
const httpServer = http.createServer(app);

// Socket.io with CORS
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
});

// Ensure uploads directory exists
const uploadPath = process.env.UPLOAD_PATH || './uploads';
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

// Middleware
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

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

// Socket.io agent handler
require('./socket/agentHandler')(io);

// Make io accessible to routes
app.set('io', io);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () =>
  console.log(`[Server] Running on port ${PORT}`)
);

module.exports = { io };
