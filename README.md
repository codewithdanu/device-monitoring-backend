# Backend — Device Monitoring System

Express + PostgreSQL + Socket.io backend server.

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Setup environment
```bash
cp .env.example .env
# Edit .env with your database credentials
```

### 3. Setup PostgreSQL
```bash
# Ubuntu/Debian
sudo apt install postgresql postgresql-contrib -y
sudo -u postgres psql <<EOF
CREATE USER deviceadmin WITH PASSWORD 'yourpassword';
CREATE DATABASE devicedb OWNER deviceadmin;
GRANT ALL PRIVILEGES ON DATABASE devicedb TO deviceadmin;
EOF

# Run migration
psql -U deviceadmin -d devicedb -f migrations/001_init.sql
```

### 4. Run server
```bash
# Development (with --watch)
npm run dev

# Production
npm start

# Production with PM2
npm install -g pm2
pm2 start src/index.js --name device-server
pm2 save && pm2 startup
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | — | Register user |
| POST | `/api/auth/login` | — | Login, get JWT |
| GET | `/api/auth/me` | JWT | Get current user |
| GET | `/api/devices` | JWT | List devices |
| POST | `/api/devices/register` | JWT | Register device |
| GET | `/api/devices/:id` | JWT | Get device + metrics |
| GET | `/api/devices/:id/location` | JWT | Get last location |
| DELETE | `/api/devices/:id` | JWT | Delete device |
| POST | `/api/commands/:deviceId` | JWT | Send command |
| GET | `/api/commands/:deviceId/history` | JWT | Command history |
| POST | `/api/files/upload` | — | Agent file upload |
| GET | `/api/files/:deviceId` | JWT | List files |
| GET | `/api/files/download/:fileId` | JWT | Download file |
| DELETE | `/api/files/:fileId` | JWT | Delete file |
| GET | `/api/metrics/:deviceId` | JWT | Get time-series metrics |

## Socket.io Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `agent:register` | Agent → Server | Authenticate agent |
| `agent:metrics` | Agent → Server | Push metrics |
| `agent:location` | Agent → Server | Push GPS location |
| `agent:command_result` | Agent → Server | Report command result |
| `command` | Server → Agent | Send command to device |
| `metrics:update` | Server → Dashboard | Broadcast new metrics |
| `location:update` | Server → Dashboard | Broadcast new location |
| `device:online` | Server → Dashboard | Device connected |
| `device:offline` | Server → Dashboard | Device disconnected |
| `command:result` | Server → Dashboard | Command result |

## Metrics Cleanup (Production)
```bash
# Add to crontab (runs daily at 2 AM)
0 2 * * * psql -U deviceadmin -d devicedb -c "DELETE FROM metrics WHERE recorded_at < NOW() - INTERVAL '7 days';"
0 2 * * * psql -U deviceadmin -d devicedb -c "DELETE FROM locations WHERE recorded_at < NOW() - INTERVAL '30 days';"
```
