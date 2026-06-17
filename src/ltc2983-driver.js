/**
 * LTC2983 SPI Driver - Modern Node.js Implementation
 * Supports real SPI hardware (spi-device + onoff) and simulation mode
 *
 * Original: Reese Russell 7/31/17
 * Updated: 2026 - Modern ES6+, proper async, simulation support
 *
 * Reference: LTC2983 Datasheet Rev. D
 * - SPI Mode 0 (CPOL=0, CPHA=0), MSB first, max 2 MHz
 * - Big-endian multi-byte transfers with address auto-increment
 */

'use strict';

// ─── LTC2983 Register Map Constants ────────────────────────────────────────────
const REG = {
  // SPI Commands (Table 2B)
  WRITE: 0x02,
  READ:  0x03,

  // Base Addresses (Table 2A)
  COMMAND_STATUS:       0x000,  // Command/Status register
  RESULTS_BASE:         0x010,  // Conversion results: 0x010–0x05F (20 × 4 bytes)
  GLOBAL_CONFIG:        0x0F0,  // Global configuration register
  MULTI_CHANNEL_MASK:   0x0F4,  // Multi-channel conversion mask: 0x0F4–0x0F7 (4 bytes)
  MUX_DELAY:            0x0FF,  // MUX configuration delay
  CHANNEL_MAP_BASE:     0x200,  // Channel assignment: 0x200–0x24F (20 × 4 bytes)
  CUSTOM_DATA_BASE:     0x250,  // Custom sensor table data: 0x250–0x3CF

  // Sensor Type Codes (bits 31:27 of channel assignment word) - Table in §7
  SENSOR_TYPES: {
    UNASSIGNED:        0b00000,  // 0
    TYPE_J:            0b00001,  // 1
    TYPE_K:            0b00010,  // 2
    TYPE_E:            0b00011,  // 3
    TYPE_N:            0b00100,  // 4
    TYPE_R:            0b00101,  // 5
    TYPE_S:            0b00110,  // 6
    TYPE_T:            0b00111,  // 7  - FIXED: was 0b01000
    TYPE_B:            0b01000,  // 8  - FIXED: was 0b00111
    TYPE_CUSTOM_TC:    0b01001,  // 9
    RTD_PT_10:         0b01010,  // 10
    RTD_PT_50:         0b01011,  // 11
    RTD_PT_100:        0b01100,  // 12
    RTD_PT_200:        0b01101,  // 13
    RTD_PT_500:        0b01110,  // 14
    RTD_PT_1000:       0b01111,  // 15
    RTD_1000_375:      0b10000,  // 16 - RTD 1000 (α = 0.00375)
    RTD_NI_120:        0b10001,  // 17
    RTD_CUSTOM:        0b10010,  // 18
    THERMISTOR_44004:  0b10011,  // 19 - 2.252kΩ
    THERMISTOR_44005:  0b10100,  // 20 - 3kΩ
    THERMISTOR_44007:  0b10101,  // 21 - 5kΩ
    THERMISTOR_44006:  0b10110,  // 22 - 10kΩ
    THERMISTOR_44008:  0b10111,  // 23 - 30kΩ
    THERMISTOR_YSI400: 0b11000,  // 24 - YSI-400 2.252kΩ
    THERMISTOR_1003K:  0b11001,  // 25 - Spectrum 1003k 1kΩ
    THERMISTOR_SH:     0b11010,  // 26 - Custom Steinhart-Hart
    THERMISTOR_TABLE:  0b11011,  // 27 - Custom Table
    DIODE:             0b11100,  // 28
    SENSE_RESISTOR:    0b11101,  // 29
    DIRECT_ADC:        0b11110,  // 30
    // 0b11111 (31) is reserved
  },

  // Rejection Modes (Global Config bits 1:0)
  REJECTION: {
    FIFTY_SIXTY: 0b00,  // 50/60 Hz simultaneous (75 dB)
    SIXTY_HZ:    0b01,  // 60 Hz only (120 dB)
    FIFTY_HZ:    0b10,  // 50 Hz only (120 dB)
  },

  // Thermocouple OC current (bits 19:18)
  TC_OC_CURRENT: {
    UA_10:    0b00,
    UA_100:   0b01,
    UA_500:   0b10,
    UA_1000:  0b11,
  },

  // Diode excitation current (bits 23:22)
  DIODE_CURRENT: {
    UA_10: 0b00,  // 1I=10µA, 4I=40µA, 8I=80µA
    UA_20: 0b01,  // 1I=20µA, 4I=80µA, 8I=160µA
    UA_40: 0b10,  // 1I=40µA, 4I=160µA, 8I=320µA
    UA_80: 0b11,  // 1I=80µA, 4I=320µA, 8I=640µA
  },

  // RTD Excitation Current (bits 17:14) - Table 29
  RTD_CURRENT: {
    UA_5:    0b0001,
    UA_10:   0b0010,
    UA_25:   0b0011,
    UA_50:   0b0100,
    UA_100:  0b0101,
    UA_250:  0b0110,
    UA_500:  0b0111,
    UA_1000: 0b1000,
  },

  // RTD Wire Configuration (bits 21:18) - Table 28
  RTD_WIRES: {
    TWO_WIRE:           0b0000,  // 2-wire, external ground, no rotation, no sharing
    TWO_WIRE_SHARE:     0b0001,  // 2-wire, internal ground, sharing
    THREE_WIRE:         0b0100,  // 3-wire, external ground
    THREE_WIRE_SHARE:   0b0101,  // 3-wire, internal ground, sharing
    FOUR_WIRE:          0b1000,  // 4-wire, external ground
    FOUR_WIRE_SHARE:    0b1001,  // 4-wire, internal ground, sharing
    FOUR_WIRE_ROT:      0b1010,  // 4-wire, internal ground, rotation, sharing
    FOUR_WIRE_KELVIN:   0b1100,  // 4-wire Kelvin RSENSE, external ground
    FOUR_WIRE_KELVIN_S: 0b1101,  // 4-wire Kelvin RSENSE, internal ground, sharing
    FOUR_WIRE_KELVIN_R: 0b1110,  // 4-wire Kelvin RSENSE, internal ground, rotation, sharing
  },

  // RTD Curve (bits 13:12) - Table 30
  RTD_CURVE: {
    EUROPEAN: 0b00,  // α = 0.00385
    AMERICAN: 0b01,  // α = 0.003911
    JAPANESE: 0b10,  // α = 0.003916
    ITS_90:   0b11,  // α = 0.003926
  },

  // Thermistor Excitation Current (bits 18:15) - Table 53
  THERM_CURRENT: {
    NA_250:   0b0001,  // 250 nA
    NA_500:   0b0010,  // 500 nA
    UA_1:     0b0011,  // 1 µA
    UA_5:     0b0100,  // 5 µA
    UA_10:    0b0101,  // 10 µA
    UA_25:    0b0110,  // 25 µA
    UA_50:    0b0111,  // 50 µA
    UA_100:   0b1000,  // 100 µA
    UA_250:   0b1001,  // 250 µA
    UA_500:   0b1010,  // 500 µA
    UA_1000:  0b1011,  // 1 mA
    AUTO:     0b1100,  // Auto Range (not for custom sensors)
  },

  // Thermistor Configuration (bits 21:19) - Table 52
  THERM_CONFIG: {
    DIFF:           0b000,  // Differential, no sharing, no rotation
    DIFF_ROT_SHARE: 0b001,  // Differential, sharing, rotation
    DIFF_SHARE:     0b010,  // Differential, sharing, no rotation
    SE:             0b100,  // Single-ended, no sharing
  },

  // Status register values
  STATUS: {
    BUSY:  0x80,  // Start=1, Done=0 - conversion in progress or initializing
    READY: 0x40,  // Start=0, Done=1 - ready for commands
  },

  // Command byte for sleep mode
  SLEEP_CMD: 0x97,
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
  [REG.SENSOR_TYPES.RTD_1000_375]:      'RTD 1000 (α=0.00375)',
  [REG.SENSOR_TYPES.RTD_NI_120]:        'RTD NI-120',
  [REG.SENSOR_TYPES.RTD_CUSTOM]:        'RTD Custom',
  [REG.SENSOR_TYPES.THERMISTOR_44004]:  'Thermistor 44004/44033 2.252kΩ',
  [REG.SENSOR_TYPES.THERMISTOR_44005]:  'Thermistor 44005/44030 3kΩ',
  [REG.SENSOR_TYPES.THERMISTOR_44007]:  'Thermistor 44007/44034 5kΩ',
  [REG.SENSOR_TYPES.THERMISTOR_44006]:  'Thermistor 44006/44031 10kΩ',
  [REG.SENSOR_TYPES.THERMISTOR_44008]:  'Thermistor 44008/44032 30kΩ',
  [REG.SENSOR_TYPES.THERMISTOR_YSI400]: 'Thermistor YSI-400 2.252kΩ',
  [REG.SENSOR_TYPES.THERMISTOR_1003K]:  'Thermistor Spectrum 1003k 1kΩ',
  [REG.SENSOR_TYPES.THERMISTOR_SH]:     'Thermistor Custom Steinhart-Hart',
  [REG.SENSOR_TYPES.THERMISTOR_TABLE]:  'Thermistor Custom Table',
  [REG.SENSOR_TYPES.DIODE]:             'Diode',
  [REG.SENSOR_TYPES.SENSE_RESISTOR]:    'Sense Resistor',
  [REG.SENSOR_TYPES.DIRECT_ADC]:        'Direct ADC',
};

// Fault bit definitions (Table 10)
const FAULT_BITS = {
  SENSOR_HARD_FAULT:   0x80,  // D31 - Bad/open/short sensor
  ADC_HARD_FAULT:      0x40,  // D30 - Bad ADC reading
  CJ_HARD_FAULT:       0x20,  // D29 - Cold-junction sensor hard fault
  CJ_SOFT_FAULT:       0x10,  // D28 - Cold-junction sensor beyond normal range
  SENSOR_OVER_RANGE:   0x08,  // D27 - Reading above normal range
  SENSOR_UNDER_RANGE:  0x04,  // D26 - Reading below normal range
  ADC_OUT_OF_RANGE:    0x02,  // D25 - ADC absolute input beyond ±1.125·VREF/2
  VALID:               0x01,  // D24 - Result valid (1 = valid)
};

// ─── Utility Functions ─────────────────────────────────────────────────────────

/** Generate a 32-bit mask: shift data left by lsbBitPosition */
function maskGen32(lsbBitPosition, data) {
  return ((data << lsbBitPosition) & 0xFFFFFFFF) >>> 0;
}

/**
 * Parse raw 32-bit conversion result into temperature or error
 * Per §8 of the datasheet:
 * - D31..D24: fault byte
 * - D23..D0: temperature as 24-bit two's complement, units of 1/1024 °C
 * - Hard faults (D31, D30, D29) clamp output to -999
 */
function parseConversionResult(rawData) {
  const faultByte = (rawData >>> 24) & 0xFF;
  const validBit = faultByte & FAULT_BITS.VALID;

  // Check for hard faults first
  const hardFaults = faultByte & (FAULT_BITS.SENSOR_HARD_FAULT | FAULT_BITS.ADC_HARD_FAULT | FAULT_BITS.CJ_HARD_FAULT);

  // Build error list
  const errors = [];
  if (faultByte & FAULT_BITS.SENSOR_HARD_FAULT) errors.push('SENSOR_HARD_FAULT');
  if (faultByte & FAULT_BITS.ADC_HARD_FAULT) errors.push('ADC_HARD_FAULT');
  if (faultByte & FAULT_BITS.CJ_HARD_FAULT) errors.push('CJ_HARD_FAULT');
  if (faultByte & FAULT_BITS.CJ_SOFT_FAULT) errors.push('CJ_SOFT_FAULT');
  if (faultByte & FAULT_BITS.SENSOR_OVER_RANGE) errors.push('SENSOR_OVER_RANGE');
  if (faultByte & FAULT_BITS.SENSOR_UNDER_RANGE) errors.push('SENSOR_UNDER_RANGE');
  if (faultByte & FAULT_BITS.ADC_OUT_OF_RANGE) errors.push('ADC_OUT_OF_RANGE');

  // If not valid or has hard faults, return invalid
  if (!validBit || hardFaults) {
    if (errors.length === 0 && !validBit) errors.push('INVALID_CONVERSION');
    return { valid: false, temperature: null, errors, faultByte };
  }

  // Extract 24-bit signed temperature (1/1024 degree resolution)
  // D23 is the sign bit
  let tempRaw = rawData & 0x00FFFFFF;
  if (tempRaw & 0x00800000) {
    // Sign-extend negative value
    tempRaw = tempRaw - 0x01000000;
  }
  const temperature = tempRaw / 1024.0;

  return { valid: true, temperature, errors, faultByte };
}

/**
 * Build a 32-bit channel configuration word for a thermocouple
 * Per §7.1 (Tables 11-14):
 * B31..27: sensor type
 * B26..22: CJ channel pointer (0=none, 1-20=channel)
 * B21: SGL (1=single-ended, 0=differential)
 * B20: OC check enable
 * B19..18: OC current
 * B17..12: 0
 * B11..6: custom address (for type 9 only)
 * B5..0: custom length-1 (for type 9 only)
 */
function buildThermocoupleConfig(sensorType, cjChannel, singleEnded, ocCheckEnabled, ocCurrent, customAddr = 0, customLen = 0) {
  let word = 0;
  word |= maskGen32(27, sensorType & 0x1F);
  word |= maskGen32(22, cjChannel & 0x1F);
  word |= maskGen32(21, singleEnded ? 1 : 0);
  word |= maskGen32(20, ocCheckEnabled ? 1 : 0);
  word |= maskGen32(18, ocCurrent & 0x03);
  // B17..12 = 0
  if (sensorType === REG.SENSOR_TYPES.TYPE_CUSTOM_TC) {
    word |= maskGen32(6, customAddr & 0x3F);
    word |= (customLen & 0x3F);
  }
  return word >>> 0;
}

/**
 * Build a 32-bit channel configuration word for a diode
 * Per §7.2 (Tables 17-20):
 * B31..27: sensor type (28)
 * B26: SGL (1=single-ended, 0=differential)
 * B25: 2/3 reading mode (0=two, 1=three)
 * B24: averaging enable
 * B23..22: excitation current
 * B21..0: ideality factor (2 int bits + 20 frac bits, 0=default 1.003)
 */
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

/**
 * Build a 32-bit channel configuration word for an RTD
 * Per §7.3 (Tables 25-30):
 * B31..27: sensor type (10-18)
 * B26..22: RSENSE channel pointer (2-20, value N means CH(N)-CH(N-1))
 * B21..18: sensor configuration (wires + excitation mode)
 * B17..14: excitation current
 * B13..12: curve type
 * B11..6: custom address (for type 18 only)
 * B5..0: custom length-1 (for type 18 only)
 */
function buildRTDConfig(sensorType, rsenseChannel, wireConfig, excitationCurrent, curveType, customAddr = 0, customLen = 0) {
  let word = 0;
  word |= maskGen32(27, sensorType & 0x1F);
  word |= maskGen32(22, rsenseChannel & 0x1F);
  word |= maskGen32(18, wireConfig & 0x0F);
  word |= maskGen32(14, excitationCurrent & 0x0F);
  word |= maskGen32(12, curveType & 0x03);
  if (sensorType === REG.SENSOR_TYPES.RTD_CUSTOM) {
    word |= maskGen32(6, customAddr & 0x3F);
    word |= (customLen & 0x3F);
  }
  return word >>> 0;
}

/**
 * Build a 32-bit channel configuration word for a thermistor
 * Per §7.5 (Tables 50-53):
 * B31..27: sensor type (19-27)
 * B26..22: RSENSE channel pointer
 * B21..19: sensor configuration (SGL + excitation mode)
 * B18..15: excitation current
 * B14..12: 0
 * B11..6: custom address (for types 26, 27)
 * B5..0: custom length-1 (for type 27, always 0 for type 26)
 */
function buildThermistorConfig(sensorType, rsenseChannel, sensorConfig, excitationCurrent, customAddr = 0, customLen = 0) {
  let word = 0;
  word |= maskGen32(27, sensorType & 0x1F);
  word |= maskGen32(22, rsenseChannel & 0x1F);
  word |= maskGen32(19, sensorConfig & 0x07);
  word |= maskGen32(15, excitationCurrent & 0x0F);
  // B14..12 = 0
  if (sensorType === REG.SENSOR_TYPES.THERMISTOR_SH || sensorType === REG.SENSOR_TYPES.THERMISTOR_TABLE) {
    word |= maskGen32(6, customAddr & 0x3F);
    word |= (customLen & 0x3F);
  }
  return word >>> 0;
}

/**
 * Build a 32-bit channel configuration word for a sense resistor
 * Per §7.4 (Tables 33-35):
 * B31..27: sensor type (29)
 * B26..0: resistance value (17 integer bits + 10 fraction bits)
 * Value range: 0 to ~131,072 Ω with 1/1024 Ω resolution
 */
function buildSenseResistorConfig(resistanceValue) {
  let word = 0;
  word |= maskGen32(27, REG.SENSOR_TYPES.SENSE_RESISTOR);
  // Resistance is stored as value * 1024 in bits 26:0
  const rawResistance = Math.round(resistanceValue * 1024) & 0x07FFFFFF;
  word |= rawResistance;
  return word >>> 0;
}

/**
 * Build a 32-bit channel configuration word for direct ADC
 * Per §7.6 (Table 63):
 * Differential: 0xF0000000
 * Single-ended: 0xF4000000
 */
function buildDirectADCConfig(singleEnded) {
  let word = 0;
  word |= maskGen32(27, REG.SENSOR_TYPES.DIRECT_ADC);
  word |= maskGen32(26, singleEnded ? 1 : 0);
  return word >>> 0;
}

/**
 * Encode diode ideality factor
 * Per §7.2: range 0-4, resolution 1/1048576 (2^-20)
 * B21..B20 = 2-bit integer part, B19..B0 = 20-bit fraction
 * All zeros = factory default η = 1.003
 */
function encodeIdealityFactor(eta) {
  if (eta === 0 || eta === 1.003) return 0;  // Use default
  const raw = Math.round(eta * (1 << 20)) & 0x3FFFFF;
  return raw;
}

/**
 * Decode diode ideality factor from raw value
 */
function decodeIdealityFactor(raw) {
  if (raw === 0) return 1.003;  // Default
  return raw / (1 << 20);
}

// ─── SPI Transport Layer ───────────────────────────────────────────────────────

class SPITransport {
  constructor(bus, device, speedHz, intPin) {
    this.bus = bus;
    this.device = device;
    this.speedHz = Math.min(speedHz, 2000000);  // Max 2 MHz per datasheet
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

  /**
   * Write bytes to a 16-bit address
   * Per §3: [0x02][addr_hi][addr_lo][data0][data1]...
   * Address auto-increments for each subsequent byte
   */
  writeBytes(address, data) {
    const txBuf = Buffer.alloc(3 + data.length);
    txBuf[0] = REG.WRITE;
    txBuf[1] = (address >> 8) & 0xFF;
    txBuf[2] = address & 0xFF;
    for (let i = 0; i < data.length; i++) {
      txBuf[3 + i] = data[i];
    }

    const message = [{
      sendBuffer: txBuf,
      receiveBuffer: Buffer.alloc(txBuf.length),
      byteLength: txBuf.length,
      speedHz: this.speedHz,
    }];
    this.spi.transferSync(message);
  }

  /**
   * Read bytes from a 16-bit address
   * Per §3: [0x03][addr_hi][addr_lo] then clock in N bytes
   */
  readBytes(address, length) {
    const txBuf = Buffer.alloc(3 + length);
    txBuf[0] = REG.READ;
    txBuf[1] = (address >> 8) & 0xFF;
    txBuf[2] = address & 0xFF;
    // Remaining bytes are 0x00 (clock out data)

    const rxBuf = Buffer.alloc(3 + length);
    const message = [{
      sendBuffer: txBuf,
      receiveBuffer: rxBuf,
      byteLength: txBuf.length,
      speedHz: this.speedHz,
    }];
    this.spi.transferSync(message);

    // Data starts at byte 3
    return Array.from(rxBuf.slice(3));
  }

  /** Write a single byte to a 16-bit address */
  writeByte(address, value) {
    this.writeBytes(address, [value & 0xFF]);
  }

  /** Read a single byte from a 16-bit address */
  readByte(address) {
    const data = this.readBytes(address, 1);
    return data[0];
  }

  /**
   * Write a 32-bit word to an address (4 sequential bytes, MSB first)
   * Per §3: Multi-byte values are big-endian
   */
  writeWord(address, word) {
    const bytes = [
      (word >>> 24) & 0xFF,
      (word >>> 16) & 0xFF,
      (word >>> 8)  & 0xFF,
      word          & 0xFF,
    ];
    this.writeBytes(address, bytes);
  }

  /** Read a 32-bit word from an address (4 sequential bytes, MSB first) */
  readWord(address) {
    const bytes = this.readBytes(address, 4);
    return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
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

  /**
   * Wait for device ready by polling status register
   * Per §5: poll 0x000 until it reads 0x40 (Start=0, Done=1)
   */
  async waitForReady(timeoutMs = 5000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        const status = this.readByte(REG.COMMAND_STATUS);
        if ((status & 0xC0) === REG.STATUS.READY) {
          resolve(status);
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error(`Device not ready (status: 0x${status.toString(16)})`));
        } else {
          setTimeout(check, 10);
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

  writeBytes(address, data) {
    for (let i = 0; i < data.length; i++) {
      this.memory.set(address + i, data[i] & 0xFF);
    }
  }

  readBytes(address, length) {
    const result = [];
    for (let i = 0; i < length; i++) {
      result.push(this.memory.get(address + i) || 0x00);
    }
    return result;
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
    // Simulate conversion time (2-3 cycles, ~164-251ms)
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    // Generate simulated results for configured channels
    this._generateSimulatedResults();
  }

  async waitForReady(timeoutMs = 5000) {
    // Always ready in simulation
    return REG.STATUS.READY;
  }

  readStatus() {
    return REG.STATUS.READY;
  }

  _generateSimulatedResults() {
    // For each configured channel, write a simulated result
    for (let ch = 1; ch <= 20; ch++) {
      const cfgAddr = REG.CHANNEL_MAP_BASE + (ch - 1) * 4;
      const cfgWord = this.readWord(cfgAddr);
      const sensorType = (cfgWord >>> 27) & 0x1F;

      if (sensorType !== REG.SENSOR_TYPES.UNASSIGNED && sensorType !== REG.SENSOR_TYPES.SENSE_RESISTOR) {
        const resultAddr = REG.RESULTS_BASE + (ch - 1) * 4;
        let simTemp;

        if (sensorType === REG.SENSOR_TYPES.DIODE) {
          simTemp = 20 + Math.random() * 10; // 20-30°C for diodes
        } else if (sensorType >= REG.SENSOR_TYPES.RTD_PT_10 && sensorType <= REG.SENSOR_TYPES.RTD_CUSTOM) {
          simTemp = 22 + Math.random() * 5; // 22-27°C for RTDs
        } else if (sensorType >= REG.SENSOR_TYPES.THERMISTOR_44004 && sensorType <= REG.SENSOR_TYPES.THERMISTOR_TABLE) {
          simTemp = 23 + Math.random() * 4; // 23-27°C for thermistors
        } else if (sensorType === REG.SENSOR_TYPES.DIRECT_ADC) {
          simTemp = 0.5 + Math.random() * 1.5; // 0.5-2V for ADC
        } else {
          // Thermocouple types - simulate realistic temperatures
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
   * @param {number} options.spiSpeed - SPI clock speed in Hz (default 1000000, max 2000000)
   * @param {number} options.intPin - GPIO pin for interrupt (default 35)
   * @param {number} options.rstPin - GPIO pin for reset (default 37)
   * @param {boolean} options.fahrenheit - Use Fahrenheit (default false)
   * @param {string} options.rejection - Rejection mode: '50/60', '60', '50' (default '50/60')
   */
  constructor(options = {}) {
    this.simulate = options.simulate || false;
    this.spiBus = options.spiBus ?? 0;
    this.spiDevice = options.spiDevice ?? 1;
    this.spiSpeed = Math.min(options.spiSpeed ?? 1000000, 2000000);
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

    // If real hardware, do reset and wait for startup
    if (!this.simulate) {
      await this._hardwareReset();
      // Wait for device to be ready (per §5, ~200ms startup)
      await this.transport.waitForReady(5000);
    }

    // Validate the device
    const status = this.transport.readStatus();
    if ((status & 0xC0) === REG.STATUS.READY) {
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
      rst.writeSync(0); // Assert reset (active low)
      await new Promise(r => setTimeout(r, 100));
      rst.writeSync(1); // Release reset
      await new Promise(r => setTimeout(r, 250)); // Wait for device startup (~200ms per datasheet)
      rst.unexport();
    } catch (err) {
      console.warn(`[LTC2983] Reset GPIO error: ${err.message}`);
    }
  }

  /**
   * Set the global configuration register (0x0F0)
   * Per §12: bits 7..3 = 0, bit 2 = temp unit (0=°C, 1=°F), bits 1..0 = rejection
   */
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
   * Set MUX configuration delay (0x0FF)
   * Per §13: value × 100µs extra settling delay (max 25.5ms)
   */
  setMuxDelay(units100us) {
    const value = Math.min(255, Math.max(0, Math.round(units100us)));
    this.transport.writeByte(REG.MUX_DELAY, value);
    console.log(`[LTC2983] MUX delay set to ${value * 100}µs`);
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
        config.idealityFactor ?? 0,  // 0 = default 1.003
      );
    } else if (sensorType === REG.SENSOR_TYPES.SENSE_RESISTOR) {
      word = buildSenseResistorConfig(config.resistanceValue ?? 10000);
    } else if (sensorType === REG.SENSOR_TYPES.DIRECT_ADC) {
      word = buildDirectADCConfig(config.singleEnded ?? true);
    } else if (sensorType >= REG.SENSOR_TYPES.RTD_PT_10 && sensorType <= REG.SENSOR_TYPES.RTD_CUSTOM) {
      // RTD configuration
      let wireConfig = config.wireConfig ?? REG.RTD_WIRES.TWO_WIRE;
      // Legacy support: convert numWires to wireConfig
      if (config.numWires !== undefined) {
        switch (config.numWires) {
          case 2: wireConfig = config.sharing ? REG.RTD_WIRES.TWO_WIRE_SHARE : REG.RTD_WIRES.TWO_WIRE; break;
          case 3: wireConfig = config.sharing ? REG.RTD_WIRES.THREE_WIRE_SHARE : REG.RTD_WIRES.THREE_WIRE; break;
          case 4: wireConfig = config.sharing ? REG.RTD_WIRES.FOUR_WIRE_SHARE : REG.RTD_WIRES.FOUR_WIRE; break;
        }
      }
      word = buildRTDConfig(
        sensorType,
        config.rsenseChannel ?? 0,
        wireConfig,
        config.excitationCurrent ?? REG.RTD_CURRENT.UA_100,
        config.curveType ?? REG.RTD_CURVE.EUROPEAN,
        config.customAddr ?? 0,
        config.customLen ?? 0,
      );
    } else if (sensorType >= REG.SENSOR_TYPES.THERMISTOR_44004 && sensorType <= REG.SENSOR_TYPES.THERMISTOR_TABLE) {
      // Thermistor configuration
      let sensorConfig = config.sensorConfig ?? REG.THERM_CONFIG.SE;
      // Legacy support
      if (config.singleEnded !== undefined) {
        sensorConfig = config.singleEnded ? REG.THERM_CONFIG.SE : REG.THERM_CONFIG.DIFF;
      }
      word = buildThermistorConfig(
        sensorType,
        config.rsenseChannel ?? 0,
        sensorConfig,
        config.excitationCurrent ?? REG.THERM_CURRENT.UA_10,
        config.customAddr ?? 0,
        config.customLen ?? 0,
      );
    } else {
      // Thermocouple types (1-9)
      word = buildThermocoupleConfig(
        sensorType,
        config.cjChannel ?? 0,
        config.singleEnded ?? true,
        config.ocCheckEnabled ?? false,
        config.ocCurrent ?? REG.TC_OC_CURRENT.UA_10,
        config.customAddr ?? 0,
        config.customLen ?? 0,
      );
    }

    // Write the 4-byte config word to channel assignment address
    // Per §4: config_addr(CHn) = 0x200 + 4*(n-1)
    const address = REG.CHANNEL_MAP_BASE + (channel - 1) * 4;
    this.transport.writeWord(address, word);

    // Store the config
    this.channelConfigs[channel] = {
      ...config,
      sensorType,
      sensorTypeName: SENSOR_TYPE_NAMES[sensorType] || 'Unknown',
      configWord: word,
    };

    console.log(`[LTC2983] Channel ${channel} configured: ${SENSOR_TYPE_NAMES[sensorType] || 'Unknown'} (0x${word.toString(16).padStart(8, '0')})`);
    return word;
  }

  /**
   * Set the multi-channel conversion mask
   * Per §9: 4-byte mask at 0x0F4-0x0F7, bit (n-1) corresponds to CHn
   */
  setConversionMap(channels) {
    this.ccMap = channels.filter(ch => ch >= 1 && ch <= 20);

    // Build 32-bit mask: bit 0 = CH1, bit 1 = CH2, ..., bit 19 = CH20
    let mapWord = 0;
    for (const ch of this.ccMap) {
      mapWord |= (1 << (ch - 1));
    }

    // Write to mask register (0x0F4-0x0F7)
    // Per §9: 0x0F7 has CH1-CH8, 0x0F6 has CH9-CH16, 0x0F5 has CH17-CH20
    this.transport.writeWord(REG.MULTI_CHANNEL_MASK, mapWord);
    console.log(`[LTC2983] CC map set: channels [${this.ccMap.join(', ')}] (0x${mapWord.toString(16).padStart(8, '0')})`);
  }

  /**
   * Initiate a multi-channel conversion and read all results
   * Per §6: write 0x80 (B4..B0 = 00000) to start multi-channel conversion
   */
  async performConversion() {
    if (this.converting) {
      throw new Error('Conversion already in progress');
    }

    this.converting = true;

    try {
      // Write 0x80 to command/status register to start multi-channel conversion
      this.transport.writeByte(REG.COMMAND_STATUS, 0x80);

      // Wait for conversion to complete
      await this.transport.waitForConversion(10000);

      // Read results for each channel in the CC map
      const results = {};
      const timestamp = Date.now();

      for (const ch of this.ccMap) {
        // Per §4: result_addr(CHn) = 0x010 + 4*(n-1)
        const resultAddr = REG.RESULTS_BASE + (ch - 1) * 4;
        const rawWord = this.transport.readWord(resultAddr);
        const parsed = parseConversionResult(rawWord);

        results[ch] = {
          channel: ch,
          sensorType: this.channelConfigs[ch]?.sensorType ?? REG.SENSOR_TYPES.UNASSIGNED,
          sensorTypeName: this.channelConfigs[ch]?.sensorTypeName || SENSOR_TYPE_NAMES[this.channelConfigs[ch]?.sensorType] || 'Unknown',
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

  /**
   * Convert a single channel
   * Per §6: write (0x80 | channel) to start single-channel conversion
   */
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
        sensorTypeName: this.channelConfigs[channel]?.sensorTypeName || SENSOR_TYPE_NAMES[this.channelConfigs[channel]?.sensorType] || 'Unknown',
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

  /**
   * Enter sleep mode
   * Per §14: write 0x97 to 0x000
   */
  sleep() {
    this.transport.writeByte(REG.COMMAND_STATUS, REG.SLEEP_CMD);
    console.log('[LTC2983] Entered sleep mode');
  }

  /**
   * Start auto-scan polling for K-type thermocouples
   * Continuously polls configured channels at the specified interval
   * @param {number} intervalMs - Polling interval in milliseconds (min 200ms for 2-cycle conversion)
   * @param {function} callback - Called with results after each scan: callback({ timestamp, readings })
   * @param {number[]} channels - Optional array of specific channels to scan (defaults to ccMap)
   */
  startAutoScan(intervalMs = 1000, callback = null, channels = null) {
    if (this.autoScanActive) {
      console.warn('[LTC2983] Auto-scan already active');
      return;
    }

    // Minimum interval based on conversion time (~167ms for 2-cycle, ~251ms for 3-cycle)
    const minInterval = 200;
    const actualInterval = Math.max(intervalMs, minInterval);

    // Use provided channels or fall back to ccMap
    const scanChannels = channels || this.ccMap;
    if (scanChannels.length === 0) {
      throw new Error('No channels configured for auto-scan');
    }

    // If specific channels provided, update the conversion map
    if (channels) {
      this.setConversionMap(channels);
    }

    this.autoScanActive = true;
    this.autoScanCallback = callback;

    console.log(`[LTC2983] Starting auto-scan: channels [${scanChannels.join(', ')}], interval ${actualInterval}ms`);

    const doScan = async () => {
      if (!this.autoScanActive || !this.initialized) {
        this.stopAutoScan();
        return;
      }

      try {
        const result = await this.performConversion();

        if (this.autoScanCallback) {
          this.autoScanCallback(result);
        }
      } catch (err) {
        console.error(`[LTC2983] Auto-scan error: ${err.message}`);
      }
    };

    // Start the interval
    this.autoScanInterval = setInterval(doScan, actualInterval);

    // Do first scan immediately
    doScan();
  }

  /**
   * Stop auto-scan polling
   */
  stopAutoScan() {
    if (this.autoScanInterval) {
      clearInterval(this.autoScanInterval);
      this.autoScanInterval = null;
    }
    this.autoScanActive = false;
    this.autoScanCallback = null;
    console.log('[LTC2983] Auto-scan stopped');
  }

  /**
   * Configure multiple K-type thermocouples for auto-scan
   * Convenience method to set up K-type TCs with a shared cold junction
   * @param {number[]} tcChannels - Array of channel numbers for thermocouples
   * @param {number} cjChannel - Channel number for cold junction sensor (diode)
   * @param {object} options - Additional options
   */
  configureKTypeAutoScan(tcChannels, cjChannel = 0, options = {}) {
    const {
      singleEnded = true,
      ocCheckEnabled = false,
      ocCurrent = REG.TC_OC_CURRENT.UA_10,
      diodeCurrent = REG.DIODE_CURRENT.UA_10,
      diodeThreeReadings = true,
      diodeAveraging = true,
    } = options;

    // Configure cold junction diode if specified
    if (cjChannel > 0 && cjChannel <= 20) {
      this.configureChannel(cjChannel, {
        sensorType: REG.SENSOR_TYPES.DIODE,
        singleEnded: true,
        threeReadings: diodeThreeReadings,
        averaging: diodeAveraging,
        excitationCurrent: diodeCurrent,
        idealityFactor: 0,  // Use default 1.003
      });
    }

    // Configure each K-type thermocouple
    const configuredChannels = [];
    for (const ch of tcChannels) {
      if (ch >= 1 && ch <= 20) {
        this.configureChannel(ch, {
          sensorType: REG.SENSOR_TYPES.TYPE_K,
          cjChannel: cjChannel,
          singleEnded: singleEnded,
          ocCheckEnabled: ocCheckEnabled,
          ocCurrent: ocCurrent,
        });
        configuredChannels.push(ch);
      }
    }

    // Set up conversion map (include CJ channel if configured)
    const conversionChannels = cjChannel > 0 ? [cjChannel, ...configuredChannels] : configuredChannels;
    this.setConversionMap(conversionChannels);

    console.log(`[LTC2983] K-type auto-scan configured: TCs on [${configuredChannels.join(', ')}], CJ on CH${cjChannel || 'none'}`);

    return configuredChannels;
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
      autoScanActive: this.autoScanActive,
      lastReadings: this.lastReadings,
    };
  }

  /** Shutdown */
  close() {
    this.stopAutoScan();
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
  FAULT_BITS,
  parseConversionResult,
  maskGen32,
  buildThermocoupleConfig,
  buildDiodeConfig,
  buildRTDConfig,
  buildThermistorConfig,
  buildSenseResistorConfig,
  buildDirectADCConfig,
  encodeIdealityFactor,
  decodeIdealityFactor,
};
