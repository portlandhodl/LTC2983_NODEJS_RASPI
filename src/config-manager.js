/**
 * Configuration Manager
 * Persists LTC2983 channel configuration and app settings to JSON
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  // Device settings
  device: {
    spiBus: 0,
    spiDevice: 1,
    spiSpeed: 1000000,
    intPin: 35,
    rstPin: 37,
    simulate: false,
  },

  // Global config
  global: {
    fahrenheit: false,
    rejection: '50/60',  // '50/60', '60', '50'
  },

  // Channel configurations (keyed by channel number 1-20)
  channels: {},

  // Conversion map - which channels to include in consecutive conversion
  conversionMap: [],

  // Logging settings
  logging: {
    enabled: false,
    intervalMs: 1000,     // Polling interval in ms
    maxDbSizeMB: 500,     // Max database size
    retentionDays: 30,    // Auto-purge after N days (0 = never)
  },

  // Web server
  server: {
    port: 3000,
  },
};

class ConfigManager {
  constructor(configPath) {
    this.configPath = configPath || path.join(__dirname, '..', 'data', 'config.json');
    this.config = null;
  }

  /** Load config from disk or create default */
  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const loaded = JSON.parse(raw);
        // Deep merge with defaults to handle new fields
        this.config = this._deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), loaded);
        console.log(`[Config] Loaded from ${this.configPath}`);
      } else {
        this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        console.log('[Config] Using default configuration');
        this.save();
      }
    } catch (err) {
      console.error(`[Config] Error loading config: ${err.message}, using defaults`);
      this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
    return this.config;
  }

  /** Save current config to disk */
  save() {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
      console.log(`[Config] Saved to ${this.configPath}`);
    } catch (err) {
      console.error(`[Config] Error saving config: ${err.message}`);
    }
  }

  /** Get the full config */
  getAll() {
    return this.config;
  }

  /** Get a section of config */
  get(section) {
    return this.config[section];
  }

  /** Update device settings */
  updateDevice(deviceSettings) {
    this.config.device = { ...this.config.device, ...deviceSettings };
    this.save();
    return this.config.device;
  }

  /** Update global settings */
  updateGlobal(globalSettings) {
    this.config.global = { ...this.config.global, ...globalSettings };
    this.save();
    return this.config.global;
  }

  /** Set channel configuration */
  setChannel(channel, channelConfig) {
    if (channel < 1 || channel > 20) {
      throw new Error(`Invalid channel: ${channel}`);
    }
    this.config.channels[channel] = channelConfig;
    this.save();
    return channelConfig;
  }

  /** Remove channel configuration (set to unassigned) */
  removeChannel(channel) {
    delete this.config.channels[channel];
    // Also remove from conversion map
    this.config.conversionMap = this.config.conversionMap.filter(ch => ch !== channel);
    this.save();
  }

  /** Set the conversion map */
  setConversionMap(channels) {
    this.config.conversionMap = channels.filter(ch => ch >= 1 && ch <= 20);
    this.save();
    return this.config.conversionMap;
  }

  /** Update logging settings */
  updateLogging(loggingSettings) {
    this.config.logging = { ...this.config.logging, ...loggingSettings };
    this.save();
    return this.config.logging;
  }

  /** Update server settings */
  updateServer(serverSettings) {
    this.config.server = { ...this.config.server, ...serverSettings };
    this.save();
    return this.config.server;
  }

  /** Reset to defaults */
  reset() {
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.save();
    return this.config;
  }

  /** Deep merge helper */
  _deepMerge(target, source) {
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key]) target[key] = {};
        this._deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  }
}

module.exports = { ConfigManager, DEFAULT_CONFIG };
