const router = require('express').Router();
const qrcode = require('qrcode');
const auth = require('../middleware/authMiddleware');
const { query } = require('../db');

const TRACKER_OFFLINE_TIMEOUT_MS = 180 * 1000; // 3 minutes

function pickInput(req, keys) {
  for (const key of keys) {
    if (req.body && req.body[key] !== undefined && req.body[key] !== null && req.body[key] !== '') {
      return req.body[key];
    }
    if (req.query && req.query[key] !== undefined && req.query[key] !== null && req.query[key] !== '') {
      return req.query[key];
    }
  }
  return undefined;
}

function parseTimestamp(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return new Date();
  }
  const num = Number(raw);
  if (!Number.isNaN(num) && String(raw).trim() !== '') {
    // Handle seconds vs milliseconds
    const ms = num > 1e12 ? num : num * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const parsed = new Date(String(raw));
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function parseBool(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  if (typeof val === 'boolean') return val;
  const s = String(val).toLowerCase().trim();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return fallback;
}

function resolveEndpointUrl(req, overrideServerUrl) {
  if (overrideServerUrl && typeof overrideServerUrl === 'string') {
    const cleaned = overrideServerUrl.trim().replace(/\/+$/, '');
    if (/^https?:\/\/.+/i.test(cleaned)) {
      return cleaned.endsWith('/api/tracking/ping') ? cleaned : `${cleaned}/api/tracking/ping`;
    }
  }
  if (process.env.PUBLIC_SERVER_URL) {
    return `${process.env.PUBLIC_SERVER_URL.replace(/\/+$/, '')}/api/tracking/ping`;
  }
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}/api/tracking/ping`;
}

function parseSetupOptions(queryParams) {
  const allowedAccuracies = ['highest', 'high', 'medium', 'low'];
  const rawAcc = String(queryParams.accuracy || 'high').toLowerCase();
  const accuracy = allowedAccuracies.includes(rawAcc) ? rawAcc : 'high';
  const distance = Math.max(0, parseInt(queryParams.distance ?? '30', 10) || 0);
  const interval = Math.max(5, parseInt(queryParams.interval ?? '60', 10) || 60);
  const heartbeat = Math.max(0, parseInt(queryParams.heartbeat ?? '60', 10) || 0);
  const angle = Math.max(0, parseInt(queryParams.angle ?? '0', 10) || 0);
  const buffer = parseBool(queryParams.buffer, true);
  const stopDetection = parseBool(queryParams.stop_detection, true);
  const wakelock = parseBool(queryParams.wakelock, false);

  return {
    accuracy,
    distance,
    interval,
    heartbeat,
    angle,
    buffer,
    stopDetection,
    wakelock,
  };
}

async function buildSetupConfig(device, endpointUrl, opts, size = 260) {
  const trackerId = (device.tracker_device_id || device.id || '').trim();
  if (!trackerId) return null;

  const params = new URLSearchParams({
    id: trackerId,
    accuracy: opts.accuracy,
    distance: String(opts.distance),
    interval: String(opts.interval),
    heartbeat: String(opts.heartbeat),
    buffer: opts.buffer ? 'true' : 'false',
    stop_detection: opts.stopDetection ? 'true' : 'false',
    wakelock: opts.wakelock ? 'true' : 'false',
  });
  if (opts.angle > 0) {
    params.set('angle', String(opts.angle));
  }

  const qrUrl = `${endpointUrl}?${params.toString()}`;

  const deepLinkParams = new URLSearchParams({ url: endpointUrl });
  for (const [k, v] of params.entries()) {
    deepLinkParams.set(k, v);
  }
  const deepLink = `org.traccar.client://config?${deepLinkParams.toString()}`;

  const qrSvg = await qrcode.toString(qrUrl, {
    type: 'svg',
    width: size,
    margin: 2,
    color: {
      dark: '#09090b',
      light: '#ffffff',
    },
  });

  return {
    device_id: device.id,
    device_name: device.name,
    tracker_device_id: trackerId,
    endpoint_url: endpointUrl,
    qr_url: qrUrl,
    deep_link: deepLink,
    qr_svg: qrSvg,
    accuracy: opts.accuracy,
    distance: opts.distance,
    interval: opts.interval,
    heartbeat: opts.heartbeat,
    angle: opts.angle,
    buffer: opts.buffer,
    stop_detection: opts.stopDetection,
    wakelock: opts.wakelock,
  };
}

async function getTrackerStatusForDevice(device) {
  const { rows: locRows } = await query(
    `SELECT latitude, longitude, accuracy_meters, battery_level, speed, recorded_at
     FROM locations WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
    [device.id]
  );
  const latestLocation = locRows[0] || null;
  const now = Date.now();
  const lastPingMs = device.tracker_last_ping_at ? new Date(device.tracker_last_ping_at).getTime() : 0;
  const lastLocMs = latestLocation?.recorded_at ? new Date(latestLocation.recorded_at).getTime() : 0;
  const latestSignalMs = Math.max(lastPingMs, lastLocMs);
  const isConnected = latestSignalMs > 0 && now - latestSignalMs <= TRACKER_OFFLINE_TIMEOUT_MS;

  return {
    has_device_id: Boolean(device.tracker_device_id || device.id),
    tracker_device_id: device.tracker_device_id || device.id,
    is_connected: isConnected,
    last_ping_at: device.tracker_last_ping_at || latestLocation?.recorded_at || null,
    tracker_battery_level: device.tracker_battery_level ?? latestLocation?.battery_level ?? null,
    latest_location: latestLocation,
  };
}

/**
 * Public endpoint for Traccar Client (Android & iOS).
 * Supports both OsmAnd query/form parameters and modern Flutter Traccar Client JSON payloads.
 */
async function receivePing(req, res) {
  try {
    let locationObj = req.body?.location;
    if (Array.isArray(locationObj)) {
      locationObj = locationObj[locationObj.length - 1] || {};
    }
    const coords = locationObj && typeof locationObj === 'object' && typeof locationObj.coords === 'object'
      ? locationObj.coords
      : {};
    const batteryObj = locationObj && typeof locationObj === 'object' && typeof locationObj.battery === 'object'
      ? locationObj.battery
      : {};

    const rawDeviceId = pickInput(req, ['device_id', 'id', 'deviceid']);
    const rawLat = pickInput(req, ['lat']) ?? coords.latitude;
    const rawLng = pickInput(req, ['lon', 'lng']) ?? coords.longitude;

    if (!rawDeviceId || rawLat === undefined || rawLng === undefined) {
      return res.status(422).json({
        ok: false,
        message: 'Parameter id, lat, dan lon/lng wajib dikirim.',
      });
    }

    const latitude = Number(rawLat);
    const longitude = Number(rawLng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(422).json({
        ok: false,
        message: 'Koordinat lat/lon tidak valid.',
      });
    }

    const trackerKey = String(rawDeviceId).trim();
    const { rows: deviceRows } = await query(
      `SELECT id, user_id, name, tracker_device_id, tracker_battery_level
       FROM devices
       WHERE LOWER(tracker_device_id) = LOWER($1)
          OR id::text = $1
          OR LOWER(REPLACE(COALESCE(tracker_device_id, ''), 'dms-', '')) = LOWER(REPLACE($1, 'dms-', ''))
       LIMIT 1`,
      [trackerKey]
    );

    const device = deviceRows[0];
    if (!device) {
      return res.status(404).json({
        ok: false,
        message: 'ID perangkat tidak terdaftar.',
      });
    }

    const rawTimestamp = pickInput(req, ['timestamp']) ?? locationObj?.timestamp;
    const recordedAt = parseTimestamp(rawTimestamp);

    const rawAccuracy = pickInput(req, ['accuracy']) ?? coords.accuracy;
    const accuracyMeters = rawAccuracy !== undefined && Number.isFinite(Number(rawAccuracy))
      ? Number(rawAccuracy)
      : null;

    const rawSpeed = pickInput(req, ['speed']) ?? coords.speed;
    const speed = rawSpeed !== undefined && Number.isFinite(Number(rawSpeed)) && Number(rawSpeed) >= 0
      ? Number(rawSpeed)
      : null;

    let batteryLevel = null;
    const rawBatt = pickInput(req, ['batt', 'battery', 'bat']);
    if (rawBatt !== undefined && rawBatt !== null && rawBatt !== '') {
      const b = Number(rawBatt);
      if (Number.isFinite(b)) {
        if (b > 0 && b <= 1) {
          batteryLevel = Math.round(b * 1000) / 10;
        } else {
          batteryLevel = Math.round(b * 10) / 10;
        }
      }
    } else if (batteryObj.level !== undefined && Number.isFinite(Number(batteryObj.level))) {
      const b = Number(batteryObj.level);
      batteryLevel = (b > 0 && b <= 1) ? Math.round(b * 1000) / 10 : Math.round(b * 10) / 10;
    }

    await query(
      `UPDATE devices
       SET is_online = TRUE,
           tracker_last_ping_at = NOW(),
           last_seen = NOW(),
           tracker_battery_level = COALESCE($2, tracker_battery_level)
       WHERE id = $1`,
      [device.id, batteryLevel]
    );

    const { rows: insertedRows } = await query(
      `INSERT INTO locations (device_id, latitude, longitude, accuracy_meters, battery_level, speed, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [device.id, latitude, longitude, accuracyMeters, batteryLevel, speed, recordedAt]
    );

    if (batteryLevel !== null) {
      const roundedBat = Math.round(batteryLevel);
      await query(
        `INSERT INTO metrics (device_id, battery_percent, recorded_at)
         VALUES ($1, $2, $3)`,
        [device.id, roundedBat, recordedAt]
      );
    }

    const io = req.app.get('io');
    if (io) {
      io.emit('device:online', { deviceId: device.id, name: device.name });
      io.emit('location:update', {
        deviceId: device.id,
        latitude,
        longitude,
        accuracy_meters: accuracyMeters,
        battery_level: batteryLevel,
        speed,
        recorded_at: recordedAt.toISOString(),
        source: 'traccar',
      });
      if (batteryLevel !== null) {
        io.emit('metrics:update', {
          deviceId: device.id,
          cpu_percent: null,
          memory_used_mb: null,
          memory_total_mb: null,
          disk_used_gb: null,
          disk_total_gb: null,
          battery_percent: Math.round(batteryLevel),
          recorded_at: recordedAt.toISOString(),
          source: 'traccar',
        });
      }
    }

    console.log(`[Tracking] Ping OK for ${device.name} (${device.id}): lat=${latitude}, lon=${longitude}, batt=${batteryLevel ?? 'N/A'}%`);

    return res.json({
      ok: true,
      recorded: true,
      ping_id: insertedRows[0]?.id,
      device_id: device.id,
    });
  } catch (err) {
    console.error('[Tracking] Ping error:', err.message);
    return res.status(500).json({ ok: false, message: 'Internal server error' });
  }
}

router.get('/ping', receivePing);
router.post('/ping', receivePing);

// GET /api/tracking/setup/:deviceId — get QR config & status for a device
router.get('/setup/:deviceId', auth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, device_type, os, tracker_device_id, tracker_last_ping_at
       FROM devices
       WHERE id = $1 AND user_id = $2`,
      [req.params.deviceId, req.user.userId]
    );
    const device = rows[0];
    if (!device) return res.status(404).json({ error: 'Device not found' });

    // Ensure device has a clean tracker_device_id
    if (!device.tracker_device_id) {
      const generatedId = `DMS-${device.id.substring(0, 8).toUpperCase()}`;
      await query(
        `UPDATE devices SET tracker_device_id = $1 WHERE id = $2 AND tracker_device_id IS NULL`,
        [generatedId, device.id]
      );
      device.tracker_device_id = generatedId;
    }

    const endpointUrl = resolveEndpointUrl(req, req.query.server_url);
    const opts = parseSetupOptions(req.query);
    const setup = await buildSetupConfig(device, endpointUrl, opts, 260);
    const status = await getTrackerStatusForDevice(device);

    return res.json({ setup, status });
  } catch (err) {
    console.error('[Tracking] Setup error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tracking/status/:deviceId — live connection status for Traccar Client
router.get('/status/:deviceId', auth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, tracker_device_id, tracker_last_ping_at
       FROM devices
       WHERE id = $1 AND user_id = $2`,
      [req.params.deviceId, req.user.userId]
    );
    const device = rows[0];
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const status = await getTrackerStatusForDevice(device);
    return res.json(status);
  } catch (err) {
    console.error('[Tracking] Status error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tracking/qr/:deviceId/download — download QR code as SVG
router.get('/qr/:deviceId/download', auth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, tracker_device_id
       FROM devices
       WHERE id = $1 AND user_id = $2`,
      [req.params.deviceId, req.user.userId]
    );
    const device = rows[0];
    if (!device) return res.status(404).json({ error: 'Device not found' });

    const endpointUrl = resolveEndpointUrl(req, req.query.server_url);
    const opts = parseSetupOptions(req.query);
    const setup = await buildSetupConfig(device, endpointUrl, opts, 360);
    if (!setup) return res.status(404).json({ error: 'Tracker ID not configured' });

    const safeId = setup.tracker_device_id.replace(/[^A-Za-z0-9_-]+/g, '-') || 'device';
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="qr-traccar-${safeId}.svg"`);
    return res.send(setup.qr_svg);
  } catch (err) {
    console.error('[Tracking] QR download error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/tracking/device-id/:deviceId — customize tracker_device_id
router.patch('/device-id/:deviceId', auth, async (req, res) => {
  try {
    const raw = String(req.body?.tracker_device_id || '').trim();
    if (!raw || !/^[A-Za-z0-9_-]{3,64}$/.test(raw)) {
      return res.status(400).json({
        error: 'Tracker ID must be 3-64 characters using letters, numbers, "-" or "_".',
      });
    }

    const { rows } = await query(
      `UPDATE devices
       SET tracker_device_id = $1
       WHERE id = $2 AND user_id = $3
       RETURNING id, name, tracker_device_id`,
      [raw, req.params.deviceId, req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Device not found' });
    return res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Tracker ID is already used by another device.' });
    }
    console.error('[Tracking] Update tracker ID error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
