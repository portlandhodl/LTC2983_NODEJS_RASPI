/**
 * LTC2983 Web Server
 * Express + Socket.IO server for temperature monitoring and device configuration
 */

'use strict';

const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const path = require('path');

const { LTC2983, REG, SENSOR_TYPE_NAMES, FAULT_BITS } = require('./src/ltc2983-driver');
const TemperatureDB = require('./src/database');
const { ConfigManager } = require('./src/config-manager');

// ─── Check for simulation mode ────────────────────────────────────────────────
const SIMULATE = process.argv.includes('--simulate') || process.env.LTC2983_SIMULATE === '1';

// ─── Initialize components ────────────────────────────────────────────────────
const configManager = new ConfigManager();
const config = configManager.load();

// Force simulate mode if --simulate flag
if (SIMULATE) {
  config.device.simulate = true;
  console.log('[Server] Running in SIMULATION mode');
}

const db = new TemperatureDB();
db.init();

const MAX_CHART_POINTS = 100;  // Max data points per channel to send on initial load

let device = null;
let loggingInterval = null;
let loggingActive = false;

// ─── Express App ───────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new SocketIO(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Device Management ────────────────────────────────────────────────────────

async function initDevice() {
  try {
    if (device) {
      device.close();
    }

    device = new LTC2983({
      simulate: config.device.simulate,
      spiBus: config.device.spiBus,
      spiDevice: config.device.spiDevice,
      spiSpeed: config.device.spiSpeed,
      intPin: config.device.intPin,
      rstPin: config.device.rstPin,
      fahrenheit: config.global.fahrenheit,
      rejection: config.global.rejection,
    });

    await device.init();

    // Apply saved channel configurations
    for (const [chStr, chConfig] of Object.entries(config.channels)) {
      const ch = parseInt(chStr);
      if (ch >= 1 && ch <= 20) {
        device.configureChannel(ch, chConfig);
      }
    }

    // Apply conversion map
    if (config.conversionMap.length > 0) {
      device.setConversionMap(config.conversionMap);
    }

    console.log('[Server] Device initialized successfully');
    io.emit('deviceStatus', getDeviceStatus());
    return true;
  } catch (err) {
    console.error(`[Server] Device init error: ${err.message}`);
    io.emit('error', { message: `Device init failed: ${err.message}` });
    return false;
  }
}

function getDeviceStatus() {
  return {
    initialized: device?.initialized ?? false,
    simulate: config.device.simulate,
    converting: device?.converting ?? false,
    loggingActive,
    channelConfigs: device?.channelConfigs ?? {},
    ccMap: device?.ccMap ?? [],
    lastReadings: device?.lastReadings ?? {},
    fahrenheit: config.global.fahrenheit,
    rejection: config.global.rejection,
  };
}

// ─── Logging Daemon ────────────────────────────────────────────────────────────

function startLogging() {
  if (loggingActive) return;
  if (!device?.initialized) {
    console.warn('[Logging] Cannot start: device not initialized');
    return;
  }
  if (device.ccMap.length === 0) {
    console.warn('[Logging] Cannot start: no channels in conversion map');
    return;
  }

  loggingActive = true;
  const interval = config.logging.intervalMs || 1000;

  console.log(`[Logging] Started with ${interval}ms interval`);

  const doConversion = async () => {
    if (!loggingActive || !device?.initialized) {
      stopLogging();
      return;
    }

    try {
      const result = await device.performConversion();

      // Store in database
      db.storeConversionResults(result);

      // Emit to all connected clients
      io.emit('readings', result);

      // Check retention policy
      if (config.logging.retentionDays > 0) {
        const cutoff = Date.now() - (config.logging.retentionDays * 24 * 60 * 60 * 1000);
        // Only purge periodically (every 100 conversions or so)
        if (Math.random() < 0.01) {
          const purged = db.purgeOlderThan(cutoff);
          if (purged > 0) console.log(`[Logging] Purged ${purged} old readings`);
        }
      }
    } catch (err) {
      console.error(`[Logging] Conversion error: ${err.message}`);
      io.emit('error', { message: `Conversion error: ${err.message}` });
    }
  };

  loggingInterval = setInterval(doConversion, interval);
  // Do first conversion immediately
  doConversion();
  io.emit('loggingStatus', { active: true, intervalMs: interval });
}

function stopLogging() {
  if (loggingInterval) {
    clearInterval(loggingInterval);
    loggingInterval = null;
  }
  loggingActive = false;
  console.log('[Logging] Stopped');
  io.emit('loggingStatus', { active: false });
}

// ─── REST API Routes ───────────────────────────────────────────────────────────

// --- Device ---

app.get('/api/status', (req, res) => {
  res.json(getDeviceStatus());
});

app.post('/api/device/init', async (req, res) => {
  const success = await initDevice();
  res.json({ success, status: getDeviceStatus() });
});

app.get('/api/device/info', (req, res) => {
  res.json(device?.getDeviceInfo() ?? { initialized: false });
});

// --- Configuration ---

app.get('/api/config', (req, res) => {
  res.json(configManager.getAll());
});

app.put('/api/config/device', (req, res) => {
  const updated = configManager.updateDevice(req.body);
  res.json({ success: true, device: updated });
});

app.put('/api/config/global', async (req, res) => {
  const updated = configManager.updateGlobal(req.body);
  // Apply to device immediately if initialized
  if (device?.initialized) {
    device.fahrenheit = updated.fahrenheit;
    device.rejection = updated.rejection;
    device.setGlobalConfig();
  }
  res.json({ success: true, global: updated });
});

app.put('/api/config/logging', (req, res) => {
  const updated = configManager.updateLogging(req.body);
  // Restart logging if active and interval changed
  if (loggingActive) {
    stopLogging();
    startLogging();
  }
  res.json({ success: true, logging: updated });
});

app.post('/api/config/reset', (req, res) => {
  stopLogging();
  const newConfig = configManager.reset();
  res.json({ success: true, config: newConfig });
});

// --- Channel Configuration ---

app.get('/api/channels', (req, res) => {
  const channels = {};
  for (let i = 1; i <= 20; i++) {
    channels[i] = {
      channel: i,
      config: config.channels[i] || null,
      inConversionMap: config.conversionMap.includes(i),
      lastReading: device?.lastReadings[i] || null,
    };
  }
  res.json(channels);
});

app.get('/api/channels/:id', (req, res) => {
  const ch = parseInt(req.params.id);
  if (ch < 1 || ch > 20) {
    return res.status(400).json({ error: 'Channel must be 1-20' });
  }
  res.json({
    channel: ch,
    config: config.channels[ch] || null,
    inConversionMap: config.conversionMap.includes(ch),
    lastReading: device?.lastReadings[ch] || null,
  });
});

app.put('/api/channels/:id', (req, res) => {
  const ch = parseInt(req.params.id);
  if (ch < 1 || ch > 20) {
    return res.status(400).json({ error: 'Channel must be 1-20' });
  }

  try {
    const chConfig = req.body;
    configManager.setChannel(ch, chConfig);

    // Apply to device if initialized
    if (device?.initialized) {
      device.configureChannel(ch, chConfig);
    }

    res.json({ success: true, channel: ch, config: chConfig });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/channels/:id', (req, res) => {
  const ch = parseInt(req.params.id);
  if (ch < 1 || ch > 20) {
    return res.status(400).json({ error: 'Channel must be 1-20' });
  }

  configManager.removeChannel(ch);

  // Apply to device if initialized
  if (device?.initialized) {
    device.configureChannel(ch, { sensorType: 0 });
    device.setConversionMap(config.conversionMap);
  }

  res.json({ success: true, channel: ch });
});

// --- Conversion Map ---

app.get('/api/conversion-map', (req, res) => {
  res.json({ conversionMap: config.conversionMap });
});

app.put('/api/conversion-map', (req, res) => {
  const channels = req.body.channels || [];
  const updated = configManager.setConversionMap(channels);

  if (device?.initialized) {
    device.setConversionMap(updated);
  }

  res.json({ success: true, conversionMap: updated });
});

// --- Conversions ---

app.post('/api/convert', async (req, res) => {
  if (!device?.initialized) {
    return res.status(503).json({ error: 'Device not initialized' });
  }

  try {
    const result = await device.performConversion();
    // Store in DB
    db.storeConversionResults(result);
    io.emit('readings', result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/convert/:channel', async (req, res) => {
  if (!device?.initialized) {
    return res.status(503).json({ error: 'Device not initialized' });
  }

  const ch = parseInt(req.params.channel);
  if (ch < 1 || ch > 20) {
    return res.status(400).json({ error: 'Channel must be 1-20' });
  }

  try {
    const result = await device.convertSingleChannel(ch);
    db.insertReading(result);
    io.emit('singleReading', result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Logging Control ---

app.post('/api/logging/start', (req, res) => {
  if (!device?.initialized) {
    return res.status(503).json({ error: 'Device not initialized' });
  }
  startLogging();
  res.json({ success: true, active: loggingActive });
});

app.post('/api/logging/stop', (req, res) => {
  stopLogging();
  res.json({ success: true, active: loggingActive });
});

app.get('/api/logging/status', (req, res) => {
  res.json({
    active: loggingActive,
    intervalMs: config.logging.intervalMs,
    dbReadingCount: db.getReadingCount(),
    dbSize: db.getDbSize(),
    retentionDays: config.logging.retentionDays,
  });
});

// --- Data Queries ---

app.get('/api/readings/latest', (req, res) => {
  res.json(db.getLatestReadings());
});

app.get('/api/readings', (req, res) => {
  const options = {
    startTime: req.query.start ? parseInt(req.query.start) : undefined,
    endTime: req.query.end ? parseInt(req.query.end) : undefined,
    channels: req.query.channels ? req.query.channels.split(',').map(Number) : undefined,
    limit: req.query.limit ? parseInt(req.query.limit) : 1000,
    offset: req.query.offset ? parseInt(req.query.offset) : 0,
  };
  res.json(db.getReadings(options));
});

app.get('/api/readings/channel/:id', (req, res) => {
  const ch = parseInt(req.params.id);
  const options = {
    startTime: req.query.start ? parseInt(req.query.start) : undefined,
    endTime: req.query.end ? parseInt(req.query.end) : undefined,
    limit: req.query.limit ? parseInt(req.query.limit) : 1000,
    offset: req.query.offset ? parseInt(req.query.offset) : 0,
  };
  res.json(db.getChannelReadings(ch, options));
});

app.get('/api/readings/stats/:id', (req, res) => {
  const ch = parseInt(req.params.id);
  const startTime = req.query.start ? parseInt(req.query.start) : undefined;
  const endTime = req.query.end ? parseInt(req.query.end) : undefined;
  res.json(db.getChannelStats(ch, startTime, endTime));
});

app.get('/api/readings/export', (req, res) => {
  const options = {
    startTime: req.query.start ? parseInt(req.query.start) : undefined,
    endTime: req.query.end ? parseInt(req.query.end) : undefined,
    channels: req.query.channels ? req.query.channels.split(',').map(Number) : undefined,
  };
  const csv = db.exportCSV(options);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=ltc2983_readings_${Date.now()}.csv`);
  res.send(csv);
});

app.post('/api/readings/purge', (req, res) => {
  const { olderThanMs } = req.body;
  if (!olderThanMs) {
    return res.status(400).json({ error: 'olderThanMs required' });
  }
  const deleted = db.purgeOlderThan(olderThanMs);
  res.json({ success: true, deleted });
});

// --- Sensor Types Reference ---

app.get('/api/sensor-types', (req, res) => {
  res.json({
    sensorTypes: REG.SENSOR_TYPES,
    sensorTypeNames: SENSOR_TYPE_NAMES,
    faultBits: FAULT_BITS,
    rejectionModes: { '50/60': 'Both', '60': '60 Hz', '50': '50 Hz' },
    tcOcCurrents: REG.TC_OC_CURRENT,
    diodeCurrents: REG.DIODE_CURRENT,
    rtdCurrents: REG.RTD_CURRENT,
    rtdWires: REG.RTD_WIRES,
    rtdCurves: REG.RTD_CURVE,
    thermCurrents: REG.THERM_CURRENT,
    thermConfigs: REG.THERM_CONFIG,
  });
});

// --- Catch-all: serve index.html for SPA ---
// Express 5 requires named wildcard params instead of bare '*'
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Socket.IO ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  // Send current state
  socket.emit('deviceStatus', getDeviceStatus());
  socket.emit('loggingStatus', { active: loggingActive, intervalMs: config.logging.intervalMs });
  socket.emit('config', configManager.getAll());

  // Send recent historical readings so the client can pre-populate the chart
  // This ensures data survives power outages — it's loaded from SQLite on disk
  try {
    const recentReadings = db.getRecentReadings(MAX_CHART_POINTS);
    if (recentReadings.length > 0) {
      socket.emit('historicalReadings', recentReadings);
      console.log(`[Socket] Sent ${recentReadings.length} historical readings to ${socket.id}`);
    }
  } catch (err) {
    console.error(`[Socket] Error loading historical readings: ${err.message}`);
  }

  // Handle requests from client
  socket.on('requestConversion', async () => {
    if (!device?.initialized) {
      socket.emit('error', { message: 'Device not initialized' });
      return;
    }
    try {
      const result = await device.performConversion();
      db.storeConversionResults(result);
      io.emit('readings', result);
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('startLogging', () => {
    startLogging();
  });

  socket.on('stopLogging', () => {
    stopLogging();
  });

  socket.on('getStatus', () => {
    socket.emit('deviceStatus', getDeviceStatus());
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = config.server.port || 3000;

server.listen(PORT, async () => {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  LTC2983 Temperature Measurement System`);
  console.log(`  Web interface: http://localhost:${PORT}`);
  console.log(`  Mode: ${SIMULATE ? 'SIMULATION' : 'HARDWARE'}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Auto-initialize device
  await initDevice();

  // Auto-start logging if configured
  if (config.logging.enabled && device?.initialized) {
    startLogging();
  }
});

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────

function shutdown() {
  console.log('\n[Server] Shutting down...');
  stopLogging();
  if (device) device.close();
  db.close();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
