/**
 * LTC2983 SPI Driver - Modern Node.js Implementation
 * Supports real SPI hardware (spi-device + onoff) and simulation mode
 *
 * Original: Reese Russell 7/31/17
 * Updated: 2026 - Modern ES6+, proper async, simulation support
 */

'use strict';

// ─── LTC2983 Register Map Constants ────────────────────────────────────────────
const REG = {
  // SPI Commands
  WRITE: 0x02,
  READ:  0x03,

  // Base Addresses
  COMMAND_STATUS:   0x000,
  CHANNEL_MAP_BASE: 0x200,  // Channel assignment: 0x200–0x24F (4 bytes per channel, 20 channels)
  RESULTS_BASE:     0x010,  // Conversion results: 0x010–0x05F
  GLOBAL_CONFIG:    0x0F0,
  MUX_CONFIG:       0x0F4,  // Multi-channel conversion map (consecutive conversion map)

  // Sensor Type Codes (bits 31:27 of channel assignment word)
  SENSOR_TYPES: {
    UNASSIGNED:        0b00000,
    TYPE_J:            0b00001,
    TYPE_K:            0b00010,
    TYPE_E:            0b00011,
    TYPE_N:            0b00100,
    TYPE_R:            0b00101,
    TYPE_S:            0b00110,
    TYPE_T:            0b01000,
    TYPE_B:            0b00111,
    TYPE_CUSTOM_TC:    0b01001,
    RTD_PT_10:         0b01010,
    RTD_PT_50:         0b01011,
    RTD_PT_100:        0b01100,
    RTD_PT_200:        0b01101,
    RTD_PT_500:        0b01110,
    RTD_PT_1000:       0b01111,
    RTD_1000_CUSTOM:   0b10000,
    THERMISTOR_44004:  0b10001,
    THERMISTOR_44005:  0b10010,
    THERMISTOR_44007:  0b10011,
    THERMISTOR_44006:  0b10100,
    THERMISTOR_44008:  0b10101,
    THERMISTOR_CUSTOM: 0b10110,
    SENSE_RESISTOR:    0b11101,
    DIODE:             0b11100,
    DIRECT_ADC:        0b11110,
  },

  // Rejection Modes
  REJECTION: {
    FIFTY_SIXTY: 0b00,
    SIXTY_HZ:    0b01,
    FIFTY_HZ:    0b10,
  },

  // Thermocouple OC current
  TC_OC_CURRENT: {
    EXTERNAL: 0b00,
    UA_10:    0b00,
    UA_100:   0b01,
    UA_500:   0b10,
    UA_1000:  0b11,
  },

  // Diode excitation current
  DIODE_CURRENT: {
    UA_10: 0b00,
    UA_20: 0b01,
    UA_40: 0b10,
    UA_80: 0b11,
  },
};

// Human-readable sensor type names
const SENSOR_TYPE_NAMES = {
  [REG.SENSOR_TYPES.UNASSIGNED]:        'Unassigned',
  [REG.SENSOR_TYPES.TYPE_J]:            'Type J Thermocouple',
  [REG.SENSOR_TYPES.TYPE_K]:            'Type K Thermocouple',
  [REG.SENSOR_TYPES.TYPE_E]:            'Type E Thermocouple',
  [REG.SENSOR_TYPES.TYPE_N]:            'Type N Thermocouple',
  [REG.SENSOR_TYPES.TYPE_R]:            'Type R Thermocouple',
  [REG.SENSOR_TYPES.TYPE_S]:            'Type S Thermocouple',
  [REG.SENSOR_TYPES.TYPE_T]:            'Type T Thermocouple',
  [REG.SENSOR_TYPES.TYPE_B]:            'Type B Thermocouple',
  [REG.SENSOR_TYPES.TYPE_CUSTOM_TC]:    'Custom Thermocouple',
  [REG.SENSOR_TYPES.RTD_PT_10]:         'RTD PT-10',
  [REG.SENSOR_TYPES.RTD_PT_50]:         'RTD PT-50',
  [REG.SENSOR_TYPES.RTD_PT_100]:        'RTD PT-100',
  [REG.SENSOR_TYPES.RTD_PT_200]:        'RTD PT-200',
  [REG.SENSOR_TYPES.RTD_PT_500]:        'RTD PT-500',
  [REG.SENSOR_TYPES.RTD_PT_1000]:       'RTD PT-1000',
  [REG.SENSOR_TYPES.RTD_1000_CUSTOM]:   'RTD Custom',
  [REG.SENSOR_TYPES.THERMISTOR_44004]:  'Thermistor 44004/44033',
  [REG.SENSOR_TYPES.THERMISTOR_44005]:  'Thermistor 44005/44030',
  [REG.SENSOR_TYPES.THERMISTOR_44007]:  'Thermistor 44007/44034',
  [REG.SENSOR_TYPES.THERMISTOR_44006]:  'Thermistor 44006/44031',
  [REG.SENSOR_TYPES.THERMISTOR_44008]:  'Thermistor 44008/44032',
  [REG.SENSOR_TYPES.THERMISTOR_CUSTOM]: 'Thermistor Custom',
  [REG.SENSOR_TYPES.SENSE_RESISTOR]:    'Sense Resistor',
  [REG.SENSOR_TYPES.DIODE]:             'Diode',
  [REG.SENSOR_TYPES.DIRECT_ADC]:        'Direct ADC',
};

// ─── Utility Functions ─────────────────────────────────────────────────────────

/** Generate a 32-bit mask: shift data left by lsbBitPosition */
function maskGen32(lsbBitPosition, data) {
  return ((data << lsbBitPosition) & 0xFFFFFFFF) >>> 0;
}

/** Parse raw 32-bit conversion result into temperature or error */
function parseConversionResult(rawData) {
  const validBit = (rawData >>> 24) & 0x01;
  const errorBits = (rawData >>> 24) & 0xFE;

  if (!validBit || errorBits) {
    const errors = [];
    if (errorBits & 0x02) errors.push('ADC_OUT_OF_RANGE');
    if (errorBits & 0x04) errors.push('SENSOR_UNDER_RANGE');
    if (errorBits & 0x08) errors.push('SENSOR_OVER_RANGE');
    if (errorBits & 0x10) errors.push('CJ_SOFT_FAULT');
    if (errorBits & 0x20) errors.push('CJ_HARD_FAULT');
    if (errorBits & 0x40) errors.push('ADC_HARD_FAULT');
    if (errorBits & 0x80) errors.push('SENSOR_HARD_FAULT');
    if (errors.length === 0 && !validBit) errors.push('INVALID_CONVERSION');
    return { valid: false, temperature: null, errors };
  }

  // Extract 24-bit signed temperature (1/1024 degree resolution)
  let tempRaw = rawData & 0x00FFFFFF;
  if (tempRaw & 0x00800000) {
    // Sign-extend negative
    tempRaw = tempRaw - 0x01000000;
  }
  const temperature = tempRaw / 1024.0;
  return { valid: true, temperature, errors: [] };
}

/** Build a 32-bit channel configuration word for a thermocouple */
function buildThermocoupleConfig(sensorType, cjChannel, singleEnded, ocCheckEnabled, ocCurrent) {
  let word = 0;
  word |= maskGen32(27, sensorType & 0x1F);
  word |= maskGen32(22, cjChannel & 0x1F);
  word |= maskGen32(21, singleEnded ? 1 : 0);
  word |= maskGen32(20, ocCheckEnabled ? 1 : 0);
  word |= maskGen32(18, ocCurrent & 0x03);
  return word >>> 0;
}

/** Build a 32-bit channel configuration word for a diode */
function buildDiodeConfig(singleEnded, threeReadings, averaging, excitationCurrent, idealityFactor) {
  let word = 0;
  word |= maskGen32(27, REG.SENSOR_TYPES.DIODE);
  word |= maskGen32(26, singleEnded ? 1 : 0);
  word |= maskGen32(25, threeReadings ? 1 : 0);
  word |= maskGen32(24, averaging ? 1 : 0);
  word |= maskGen32(22, excitationCurrent & 0x03);
  word |= (idealityFactor & 0x003FFFFF);
  return word >>> 0;
}

/** Build a 32-bit channel configuration word for an RTD */
function buildRTDConfig(sensorType, rsenseChannel, numWires, excitationMode, excitationCurrent, curveType) {
  let word = 0;
  word |= maskGen32(27, sensorType & 0x1F);
  word |= maskGen32(22, rsenseChannel & 0x1F);
  word |= maskGen32(20, numWires & 0x03);
  word |= maskGen32(18, excitationMode & 0x03);
  word |= maskGen32(14, excitationCurrent & 0x0F);
  word |= maskGen32(12, curveType & 0x03);
  return word >>> 0;
}

/** Build a 32-bit channel configuration word for a thermistor */
function buildThermistorConfig(sensorType, rsenseChannel, singleEnded, excitationMode, excitationCurrent, curveType) {
  let word = 0;
  word |= maskGen32(27, sensorType & 0x1F);
  word |= maskGen32(22, rsenseChannel & 0x1F);
  word |= maskGen32(21, singleEnded ? 1 : 0);
  word |= maskGen32(20, excitationMode & 0x03);
  word |= maskGen32(14, excitationCurrent & 0x0F);
  word |= maskGen32(12, curveType & 0x03);
  return word >>> 0;
}

/** Build a 32-bit channel configuration word for a sense resistor */
function buildSenseResistorConfig(resistanceValue) {
  let word = 0;
  word |= maskGen32(27, REG.SENSOR_TYPES.SENSE_RESISTOR);
  // Resistance is stored as value * 1024 in bits 26:0
  const rawResistance = Math.round(resistanceValue * 1024) & 0x07FFFFFF;
  word |= rawResistance;
  return word >>> 0;
}

/** Build a 32-bit channel configuration word for direct ADC */
function buildDirectADCConfig(singleEnded) {
  let word = 0;
  word |= maskGen32(27, REG.SENSOR_TYPES.DIRECT_ADC);
  word |= maskGen32(26, singleEnded ? 1 : 0);
  return word >>> 0;
}

// ─── SPI Transport Layer ───────────────────────────────────────────────────────

class SPITransport {
  constructor(bus, device, speedHz, intPin) {
    this.bus = bus;
    this.device = device;
    this.speedHz = speedHz;
    this.intPin = intPin;
    this.spi = null;
    this.gpio = null;
  }

  async open() {
    try {
      const SPI = require('spi-device');
      this.spi = SPI.openSync(this.bus, this.device);

      const { Gpio } = require('onoff');
      this.gpio = new Gpio(this.intPin, 'in', 'rising');
      console.log(`[SPI] Opened /dev/spidev${this.bus}.${this.device} @ ${this.speedHz}Hz, INT pin ${this.intPin}`);
    } catch (err) {
      throw new Error(`Failed to open SPI: ${err.message}`);
    }
  }

  close() {
    if (this.spi) {
      this.spi.closeSync();
      this.spi = null;
    }
    if (this.gpio) {
      this.gpio.unexport();
      this.gpio = null;
    }
  }

  /** Transfer 4 bytes via SPI */
  transfer(txBytes) {
    const message = [{
      sendBuffer: Buffer.from(txBytes),
      receiveBuffer: Buffer.alloc(4),
      byteLength: 4,
      speedHz: this.speedHz,
    }];
    this.spi.transferSync(message);
    return message[0].receiveBuffer;
  }

  /** Write a byte to a 16-bit address */
  writeByte(address, value) {
    const txBuf = Buffer.from([
      REG.WRITE,
      (address >> 8) & 0xFF,
      address & 0xFF,
      value & 0xFF,
    ]);
    this.transfer(txBuf);
  }

  /** Read a byte from a 16-bit address */
  readByte(address) {
    const txBuf = Buffer.from([
      REG.READ,
      (address >> 8) & 0xFF,
      address & 0xFF,
      0x00,
    ]);
    const rx = this.transfer(txBuf);
    return rx[3];
  }

  /** Write a 32-bit word to an address (4 sequential bytes, MSB first) */
  writeWord(address, word) {
    const bytes = [
      (word >>> 24) & 0xFF,
      (word >>> 16) & 0xFF,
      (word >>> 8)  & 0xFF,
      word          & 0xFF,
    ];
    for (let i = 0; i < 4; i++) {
      this.writeByte(address + i, bytes[i]);
    }
  }

  /** Read a 32-bit word from an address (4 sequential bytes, MSB first) */
  readWord(address) {
    let word = 0;
    for (let i = 0; i < 4; i++) {
      word = (word << 8) | this.readByte(address + i);
    }
    return word >>> 0;
  }

  /** Wait for interrupt pin to go high (conversion done) */
  async waitForConversion(timeoutMs = 5000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.gpio.readSync() === 1) {
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error('Conversion timeout'));
        } else {
          setTimeout(check, 5);
        }
      };
      check();
    });
  }

  /** Read command/status register */
  readStatus() {
    return this.readByte(REG.COMMAND_STATUS);
  }
}

// ─── Simulated Transport (for development without hardware) ────────────────────

class SimulatedTransport {
  constructor() {
    this.memory = new Map();
    this.channels = {};
    console.log('[SIM] Using simulated SPI transport (no hardware)');
  }

  async open() {
    // Simulate the LTC2983 being ready (write 0x40 to status)
    this.memory.set(0x000, 0x40);
    console.log('[SIM] Simulated LTC2983 initialized');
  }

  close() {
    console.log('[SIM] Simulated transport closed');
  }

  writeByte(address, value) {
    this.memory.set(address, value & 0xFF);
  }

  readByte(address) {
    return this.memory.get(address) || 0x00;
  }

  writeWord(address, word) {
    this.writeByte(address,     (word >>> 24) & 0xFF);
    this.writeByte(address + 1, (word >>> 16) & 0xFF);
    this.writeByte(address + 2, (word >>> 8)  & 0xFF);
    this.writeByte(address + 3, word          & 0xFF);
  }

  readWord(address) {
    let word = 0;
    for (let i = 0; i < 4; i++) {
      word = (word << 8) | this.readByte(address + i);
    }
    return word >>> 0;
  }

  async waitForConversion(timeoutMs = 5000) {
    // Simulate conversion time
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    // Generate simulated results for configured channels
    this._generateSimulatedResults();
  }

  readStatus() {
    return 0x40; // Always ready
  }

  _generateSimulatedResults() {
    // For each configured channel, write a simulated result
    for (let ch = 1; ch <= 20; ch++) {
      const cfgAddr = REG.CHANNEL_MAP_BASE + (ch - 1) * 4;
      const cfgWord = this.readWord(cfgAddr);
      const sensorType = (cfgWord >>> 27) & 0x1F;

      if (sensorType !== REG.SENSOR_TYPES.UNASSIGNED) {
        const resultAddr = REG.RESULTS_BASE + (ch - 1) * 4;
        let simTemp;

        if (sensorType === REG.SENSOR_TYPES.DIODE) {
          simTemp = 20 + Math.random() * 10; // 20-30°C for diodes
        } else if (sensorType >= REG.SENSOR_TYPES.RTD_PT_10 && sensorType <= REG.SENSOR_TYPES.RTD_1000_CUSTOM) {
          simTemp = 22 + Math.random() * 5; // 22-27°C for RTDs
        } else if (sensorType === REG.SENSOR_TYPES.SENSE_RESISTOR) {
          simTemp = 0; // Sense resistors don't have temperature
          continue;
        } else {
          // Thermocouple types
          simTemp = 100 + Math.random() * 800; // 100-900°C
        }

        // Encode: valid bit (bit 24) = 1, temperature in 1/1024 format
        const rawTemp = Math.round(simTemp * 1024) & 0x00FFFFFF;
        const resultWord = (0x01 << 24) | rawTemp;
        this.writeWord(resultAddr, resultWord);
      }
    }
  }
}

// ─── LTC2983 Device Class ──────────────────────────────────────────────────────

class LTC2983 {
  /**
   * @param {object} options
   * @param {boolean} options.simulate - Use simulated transport
   * @param {number} options.spiBus - SPI bus number (default 0)
   * @param {number} options.spiDevice - SPI device/CS number (default 1)
   * @param {number} options.spiSpeed - SPI clock speed in Hz (default 1000000)
   * @param {number} options.intPin - GPIO pin for interrupt (default 35)
   * @param {number} options.rstPin - GPIO pin for reset (default 37)
   * @param {boolean} options.fahrenheit - Use Fahrenheit (default false)
   * @param {string} options.rejection - Rejection mode: '50/60', '60', '50' (default '50/60')
   */
  constructor(options = {}) {
    this.simulate = options.simulate || false;
    this.spiBus = options.spiBus ?? 0;
    this.spiDevice = options.spiDevice ?? 1;
    this.spiSpeed = options.spiSpeed ?? 1000000;
    this.intPin = options.intPin ?? 35;
    this.rstPin = options.rstPin ?? 37;
    this.fahrenheit = options.fahrenheit ?? false;
    this.rejection = options.rejection ?? '50/60';

    this.transport = null;
    this.channelConfigs = {};  // channel number -> config object
    this.ccMap = [];           // channels in consecutive conversion map
    this.initialized = false;
    this.converting = false;
    this.lastReadings = {};    // channel number -> last reading
  }

  /** Initialize the device */
  async init() {
    if (this.simulate) {
      this.transport = new SimulatedTransport();
    } else {
      this.transport = new SPITransport(this.spiBus, this.spiDevice, this.spiSpeed, this.intPin);
    }

    await this.transport.open();

    // If real hardware, do reset
    if (!this.simulate) {
      await this._hardwareReset();
    }

    // Validate the device
    const status = this.transport.readStatus();
    if ((status & 0x40) === 0x40) {
      console.log('[LTC2983] Device validated and ready');
      this.initialized = true;
    } else {
      console.warn(`[LTC2983] Unexpected status: 0x${status.toString(16)}`);
      this.initialized = true; // Continue anyway
    }

    // Write global config
    this.setGlobalConfig();

    return this.initialized;
  }

  /** Hardware reset via GPIO */
  async _hardwareReset() {
    try {
      const { Gpio } = require('onoff');
      const rst = new Gpio(this.rstPin, 'out');
      rst.writeSync(0); // Assert reset
      await new Promise(r => setTimeout(r, 100));
      rst.writeSync(1); // Release reset
      await new Promise(r => setTimeout(r, 1000)); // Wait for device startup
      rst.unexport();
    } catch (err) {
      console.warn(`[LTC2983] Reset GPIO error: ${err.message}`);
    }
  }

  /** Set the global configuration register */
  setGlobalConfig() {
    let rejectionBits;
    switch (this.rejection) {
      case '60':    rejectionBits = REG.REJECTION.SIXTY_HZ; break;
      case '50':    rejectionBits = REG.REJECTION.FIFTY_HZ; break;
      default:      rejectionBits = REG.REJECTION.FIFTY_SIXTY; break;
    }

    const configByte = (this.fahrenheit ? 0x04 : 0x00) | rejectionBits;
    this.transport.writeByte(REG.GLOBAL_CONFIG, configByte);
    console.log(`[LTC2983] Global config: ${this.fahrenheit ? 'Fahrenheit' : 'Celsius'}, rejection=${this.rejection}`);
  }

  /**
   * Configure a channel
   * @param {number} channel - Channel number (1-20)
   * @param {object} config - Channel configuration
   */
  configureChannel(channel, config) {
    if (channel < 1 || channel > 20) {
      throw new Error(`Invalid channel number: ${channel}. Must be 1-20.`);
    }

    const sensorType = config.sensorType ?? REG.SENSOR_TYPES.UNASSIGNED;
    let word = 0;

    if (sensorType === REG.SENSOR_TYPES.UNASSIGNED) {
      word = 0;
    } else if (sensorType === REG.SENSOR_TYPES.DIODE) {
      word = buildDiodeConfig(
        config.singleEnded ?? true,
        config.threeReadings ?? true,
        config.averaging ?? true,
        config.excitationCurrent ?? REG.DIODE_CURRENT.UA_10,
        config.idealityFactor ?? 0x00101042,  // ~1.04
      );
    } else if (sensorType === REG.SENSOR_TYPES.SENSE_RESISTOR) {
      word = buildSenseResistorConfig(config.resistanceValue ?? 10000);
    } else if (sensorType === REG.SENSOR_TYPES.DIRECT_ADC) {
      word = buildDirectADCConfig(config.singleEnded ?? true);
    } else if (sensorType >= REG.SENSOR_TYPES.RTD_PT_10 && sensorType <= REG.SENSOR_TYPES.RTD_1000_CUSTOM) {
      word = buildRTDConfig(
        sensorType,
        config.rsenseChannel ?? 0,
        config.numWires ?? 2,   // 2=2-wire, 3=3-wire, 0=4-wire
        config.excitationMode ?? 0,
        config.excitationCurrent ?? 5,
        config.curveType ?? 0,
      );
    } else if (sensorType >= REG.SENSOR_TYPES.THERMISTOR_44004 && sensorType <= REG.SENSOR_TYPES.THERMISTOR_CUSTOM) {
      word = buildThermistorConfig(
        sensorType,
        config.rsenseChannel ?? 0,
        config.singleEnded ?? true,
        config.excitationMode ?? 0,
        config.excitationCurrent ?? 0,
        config.curveType ?? 0,
      );
    } else {
      // Thermocouple types
      word = buildThermocoupleConfig(
        sensorType,
        config.cjChannel ?? 0,
        config.singleEnded ?? true,
        config.ocCheckEnabled ?? false,
        config.ocCurrent ?? REG.TC_OC_CURRENT.UA_10,
      );
    }

    // Write the 4-byte config word
    const address = REG.CHANNEL_MAP_BASE + (channel - 1) * 4;
    this.transport.writeWord(address, word);

    // Store the config
    this.channelConfigs[channel] = {
      ...config,
      sensorType,
      configWord: word,
    };

    console.log(`[LTC2983] Channel ${channel} configured: ${SENSOR_TYPE_NAMES[sensorType] || 'Unknown'} (0x${word.toString(16).padStart(8, '0')})`);
    return word;
  }

  /** Set the consecutive conversion map */
  setConversionMap(channels) {
    this.ccMap = channels.filter(ch => ch >= 1 && ch <= 20);

    let mapWord = 0;
    for (const ch of this.ccMap) {
      mapWord |= maskGen32(ch - 1, 1);
    }

    this.transport.writeWord(REG.MUX_CONFIG, mapWord);
    console.log(`[LTC2983] CC map set: channels [${this.ccMap.join(', ')}] (0x${mapWord.toString(16).padStart(8, '0')})`);
  }

  /** Initiate a consecutive conversion and read all results */
  async performConversion() {
    if (this.converting) {
      throw new Error('Conversion already in progress');
    }

    this.converting = true;

    try {
      // Write 0x80 to command/status register to start conversion
      this.transport.writeByte(REG.COMMAND_STATUS, 0x80);

      // Wait for conversion to complete
      await this.transport.waitForConversion(10000);

      // Read results for each channel in the CC map
      const results = {};
      const timestamp = Date.now();

      for (const ch of this.ccMap) {
        const resultAddr = REG.RESULTS_BASE + (ch - 1) * 4;
        const rawWord = this.transport.readWord(resultAddr);
        const parsed = parseConversionResult(rawWord);

        results[ch] = {
          channel: ch,
          sensorType: this.channelConfigs[ch]?.sensorType ?? REG.SENSOR_TYPES.UNASSIGNED,
          sensorTypeName: SENSOR_TYPE_NAMES[this.channelConfigs[ch]?.sensorType] || 'Unknown',
          ...parsed,
          rawWord,
          timestamp,
          unit: this.fahrenheit ? '°F' : '°C',
        };
      }

      this.lastReadings = results;
      return { timestamp, readings: results };
    } finally {
      this.converting = false;
    }
  }

  /** Convert a single channel */
  async convertSingleChannel(channel) {
    if (channel < 1 || channel > 20) {
      throw new Error(`Invalid channel: ${channel}`);
    }

    if (this.converting) {
      throw new Error('Conversion already in progress');
    }

    this.converting = true;

    try {
      // Write channel conversion command (0x80 | channel)
      this.transport.writeByte(REG.COMMAND_STATUS, 0x80 | channel);

      await this.transport.waitForConversion(10000);

      const resultAddr = REG.RESULTS_BASE + (channel - 1) * 4;
      const rawWord = this.transport.readWord(resultAddr);
      const parsed = parseConversionResult(rawWord);
      const timestamp = Date.now();

      const result = {
        channel,
        sensorType: this.channelConfigs[channel]?.sensorType ?? REG.SENSOR_TYPES.UNASSIGNED,
        sensorTypeName: SENSOR_TYPE_NAMES[this.channelConfigs[channel]?.sensorType] || 'Unknown',
        ...parsed,
        rawWord,
        timestamp,
        unit: this.fahrenheit ? '°F' : '°C',
      };

      this.lastReadings[channel] = result;
      return result;
    } finally {
      this.converting = false;
    }
  }

  /** Get device info */
  getDeviceInfo() {
    return {
      simulate: this.simulate,
      initialized: this.initialized,
      spiBus: this.spiBus,
      spiDevice: this.spiDevice,
      spiSpeed: this.spiSpeed,
      intPin: this.intPin,
      rstPin: this.rstPin,
      fahrenheit: this.fahrenheit,
      rejection: this.rejection,
      channelConfigs: this.channelConfigs,
      ccMap: this.ccMap,
      converting: this.converting,
      lastReadings: this.lastReadings,
    };
  }

  /** Shutdown */
  close() {
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }
    this.initialized = false;
    console.log('[LTC2983] Device closed');
  }
}

module.exports = {
  LTC2983,
  REG,
  SENSOR_TYPE_NAMES,
  parseConversionResult,
  maskGen32,
};
