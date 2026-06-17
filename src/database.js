/**
 * SQLite Database Layer for Temperature Logging
 * Uses better-sqlite3 for synchronous, fast SQLite access
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

class TemperatureDB {
  constructor(dbPath) {
    this.dbPath = dbPath || path.join(__dirname, '..', 'data', 'temperature.db');
    this.db = null;
  }

  /** Open/create the database and set up tables */
  init() {
    // Ensure data directory exists
    const dir = path.dirname(this.dbPath);
    const fs = require('fs');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        channel INTEGER NOT NULL,
        sensor_type INTEGER NOT NULL,
        sensor_type_name TEXT,
        temperature REAL,
        valid INTEGER NOT NULL DEFAULT 0,
        errors TEXT,
        raw_word INTEGER,
        unit TEXT DEFAULT '°C'
      );

      CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON readings(timestamp);
      CREATE INDEX IF NOT EXISTS idx_readings_channel ON readings(channel);
      CREATE INDEX IF NOT EXISTS idx_readings_channel_timestamp ON readings(channel, timestamp);
    `);

    // Prepare statements for performance
    this._insertReading = this.db.prepare(`
      INSERT INTO readings (timestamp, channel, sensor_type, sensor_type_name, temperature, valid, errors, raw_word, unit)
      VALUES (@timestamp, @channel, @sensorType, @sensorTypeName, @temperature, @valid, @errors, @rawWord, @unit)
    `);

    this._insertMany = this.db.transaction((readings) => {
      for (const r of readings) {
        this._insertReading.run(r);
      }
    });

    console.log(`[DB] Database initialized at ${this.dbPath}`);
    return this;
  }

  /** Insert a single reading */
  insertReading(reading) {
    return this._insertReading.run({
      timestamp: reading.timestamp,
      channel: reading.channel,
      sensorType: reading.sensorType,
      sensorTypeName: reading.sensorTypeName || null,
      temperature: reading.temperature,
      valid: reading.valid ? 1 : 0,
      errors: reading.errors?.length ? JSON.stringify(reading.errors) : null,
      rawWord: reading.rawWord,
      unit: reading.unit || '°C',
    });
  }

  /** Insert multiple readings in a transaction */
  insertReadings(readings) {
    const rows = readings.map(r => ({
      timestamp: r.timestamp,
      channel: r.channel,
      sensorType: r.sensorType,
      sensorTypeName: r.sensorTypeName || null,
      temperature: r.temperature,
      valid: r.valid ? 1 : 0,
      errors: r.errors?.length ? JSON.stringify(r.errors) : null,
      rawWord: r.rawWord,
      unit: r.unit || '°C',
    }));
    this._insertMany(rows);
  }

  /** Store a full conversion result set */
  storeConversionResults(conversionResult) {
    const readings = Object.values(conversionResult.readings).map(r => ({
      ...r,
      timestamp: conversionResult.timestamp,
    }));
    this.insertReadings(readings);
  }

  /** Get latest readings for all channels */
  getLatestReadings() {
    return this.db.prepare(`
      SELECT r.* FROM readings r
      INNER JOIN (
        SELECT channel, MAX(timestamp) as max_ts
        FROM readings
        GROUP BY channel
      ) latest ON r.channel = latest.channel AND r.timestamp = latest.max_ts
      ORDER BY r.channel
    `).all();
  }

  /** Get readings for a specific channel with time range */
  getChannelReadings(channel, options = {}) {
    const { startTime, endTime, limit = 1000, offset = 0 } = options;
    let sql = 'SELECT * FROM readings WHERE channel = ?';
    const params = [channel];

    if (startTime) {
      sql += ' AND timestamp >= ?';
      params.push(startTime);
    }
    if (endTime) {
      sql += ' AND timestamp <= ?';
      params.push(endTime);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params);
  }

  /** Get readings for all channels within a time range */
  getReadings(options = {}) {
    const { startTime, endTime, channels, limit = 5000, offset = 0 } = options;
    let sql = 'SELECT * FROM readings WHERE 1=1';
    const params = [];

    if (startTime) {
      sql += ' AND timestamp >= ?';
      params.push(startTime);
    }
    if (endTime) {
      sql += ' AND timestamp <= ?';
      params.push(endTime);
    }
    if (channels && channels.length > 0) {
      sql += ` AND channel IN (${channels.map(() => '?').join(',')})`;
      params.push(...channels);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params);
  }

  /** Get summary statistics for a channel */
  getChannelStats(channel, startTime, endTime) {
    let sql = `
      SELECT
        channel,
        COUNT(*) as count,
        MIN(temperature) as min_temp,
        MAX(temperature) as max_temp,
        AVG(temperature) as avg_temp,
        MIN(timestamp) as first_reading,
        MAX(timestamp) as last_reading
      FROM readings
      WHERE channel = ? AND valid = 1
    `;
    const params = [channel];

    if (startTime) {
      sql += ' AND timestamp >= ?';
      params.push(startTime);
    }
    if (endTime) {
      sql += ' AND timestamp <= ?';
      params.push(endTime);
    }

    return this.db.prepare(sql).get(...params);
  }

  /** Get total reading count */
  getReadingCount() {
    return this.db.prepare('SELECT COUNT(*) as count FROM readings').get().count;
  }

  /** Get database file size */
  getDbSize() {
    const fs = require('fs');
    try {
      const stats = fs.statSync(this.dbPath);
      return stats.size;
    } catch {
      return 0;
    }
  }

  /** Purge old data */
  purgeOlderThan(timestampMs) {
    const result = this.db.prepare('DELETE FROM readings WHERE timestamp < ?').run(timestampMs);
    this.db.exec('VACUUM');
    return result.changes;
  }

  /** Export readings as CSV string */
  exportCSV(options = {}) {
    const readings = this.getReadings({ ...options, limit: 100000 });
    const header = 'id,timestamp,datetime,channel,sensor_type,sensor_type_name,temperature,valid,errors,unit\n';
    const rows = readings.map(r =>
      `${r.id},${r.timestamp},${new Date(r.timestamp).toISOString()},${r.channel},${r.sensor_type},"${r.sensor_type_name || ''}",${r.temperature ?? ''},${r.valid},"${r.errors || ''}","${r.unit}"`
    ).join('\n');
    return header + rows;
  }

  /** Close the database */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('[DB] Database closed');
    }
  }
}

module.exports = TemperatureDB;
