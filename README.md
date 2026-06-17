# LTC2983 Node.js Driver for Raspberry Pi

A complete Node.js driver and web interface for the Analog Devices LTC2983 Multi-Sensor High Accuracy Digital Temperature Measurement System.

## Features

- **Full LTC2983 Support**: Thermocouples (J, K, E, N, R, S, T, B, custom), RTDs (PT-10/50/100/200/500/1000, NI-120, custom), thermistors (standard and custom Steinhart-Hart), diodes, and direct ADC
- **Web Interface**: Real-time temperature monitoring dashboard with live charts
- **Auto-Scan Polling**: Continuous K-type thermocouple scanning with configurable intervals
- **Data Logging**: SQLite database with configurable retention and CSV export
- **Simulation Mode**: Development and testing without hardware
- **REST API**: Full programmatic control via HTTP endpoints
- **Socket.IO**: Real-time updates to connected clients

## Hardware Requirements

- Raspberry Pi (tested on Pi 4, should work on Pi 3+)
- LTC2983 evaluation board or custom PCB
- SPI connection (default: `/dev/spidev0.1`)
- GPIO for interrupt (default: GPIO 35) and reset (default: GPIO 37)

## Installation

```bash
git clone https://github.com/portlandhodl/LTC2983_NODEJS_RASPI.git
cd LTC2983_NODEJS_RASPI
npm install
```

## Quick Start

### Hardware Mode
```bash
npm start
```

### Simulation Mode (no hardware required)
```bash
npm run dev
# or
node server.js --simulate
```

Open http://localhost:3000 in your browser.

## Configuration

Configuration is stored in `data/config.json` and persists across restarts.

### Default Configuration
```json
{
  "device": {
    "spiBus": 0,
    "spiDevice": 1,
    "spiSpeed": 1000000,
    "intPin": 35,
    "rstPin": 37,
    "simulate": false
  },
  "global": {
    "fahrenheit": false,
    "rejection": "50/60"
  },
  "channels": {},
  "conversionMap": [],
  "logging": {
    "enabled": false,
    "intervalMs": 1000,
    "maxDbSizeMB": 500,
    "retentionDays": 30
  },
  "server": {
    "port": 3000
  }
}
```

## API Reference

### Device Control

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Get device status |
| `/api/device/init` | POST | Initialize/reinitialize device |
| `/api/device/info` | GET | Get detailed device info |

### Channel Configuration

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/channels` | GET | List all channels |
| `/api/channels/:id` | GET | Get channel config |
| `/api/channels/:id` | PUT | Configure channel |
| `/api/channels/:id` | DELETE | Remove channel config |

### Conversions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/convert` | POST | Run multi-channel conversion |
| `/api/convert/:channel` | POST | Convert single channel |
| `/api/conversion-map` | GET | Get conversion map |
| `/api/conversion-map` | PUT | Set conversion map |

### K-Type Auto-Scan

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/autoscan/configure` | POST | Configure K-type thermocouples |
| `/api/autoscan/start` | POST | Start auto-scan polling |
| `/api/autoscan/stop` | POST | Stop auto-scan |
| `/api/autoscan/status` | GET | Get auto-scan status |

### Logging & Data

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/logging/start` | POST | Start logging |
| `/api/logging/stop` | POST | Stop logging |
| `/api/logging/status` | GET | Get logging status |
| `/api/readings` | GET | Query readings |
| `/api/readings/latest` | GET | Get latest readings |
| `/api/readings/export` | GET | Export CSV |
| `/api/readings/purge` | POST | Purge old data |

## K-Type Auto-Scan Example

Configure and start continuous K-type thermocouple scanning:

```javascript
// Configure K-type thermocouples on channels 3, 7, 11, 15 with cold junction on channel 1
fetch('/api/autoscan/configure', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tcChannels: [3, 7, 11, 15],
    cjChannel: 1,
    options: {
      singleEnded: true,
      ocCheckEnabled: false
    }
  })
});

// Start scanning at 1 second intervals
fetch('/api/autoscan/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ intervalMs: 1000 })
});
```

## Programmatic Usage

```javascript
const { LTC2983, REG } = require('./src/ltc2983-driver');

async function main() {
  const device = new LTC2983({
    simulate: false,
    spiBus: 0,
    spiDevice: 1,
    spiSpeed: 1000000,
    intPin: 35,
    rstPin: 37,
    fahrenheit: false,
    rejection: '50/60'
  });

  await device.init();

  // Configure a diode for cold junction on channel 1
  device.configureChannel(1, {
    sensorType: REG.SENSOR_TYPES.DIODE,
    singleEnded: true,
    threeReadings: true,
    averaging: true
  });

  // Configure K-type thermocouple on channel 3
  device.configureChannel(3, {
    sensorType: REG.SENSOR_TYPES.TYPE_K,
    cjChannel: 1,
    singleEnded: true,
    ocCheckEnabled: false
  });

  // Set conversion map
  device.setConversionMap([1, 3]);

  // Perform conversion
  const result = await device.performConversion();
  console.log(result);

  // Or use auto-scan for continuous polling
  device.startAutoScan(1000, (result) => {
    console.log('Scan result:', result);
  });

  // Stop after 10 seconds
  setTimeout(() => {
    device.stopAutoScan();
    device.close();
  }, 10000);
}

main();
```

## Sensor Type Codes

| Code | Type |
|------|------|
| 0 | Unassigned |
| 1 | Type J Thermocouple |
| 2 | Type K Thermocouple |
| 3 | Type E Thermocouple |
| 4 | Type N Thermocouple |
| 5 | Type R Thermocouple |
| 6 | Type S Thermocouple |
| 7 | Type T Thermocouple |
| 8 | Type B Thermocouple |
| 9 | Custom Thermocouple |
| 10-18 | RTD types |
| 19-27 | Thermistor types |
| 28 | Diode |
| 29 | Sense Resistor |
| 30 | Direct ADC |

## Fault Codes

The driver decodes all LTC2983 fault bits:

| Bit | Name | Description |
|-----|------|-------------|
| D31 | SENSOR_HARD_FAULT | Bad/open/short sensor |
| D30 | ADC_HARD_FAULT | Bad ADC reading |
| D29 | CJ_HARD_FAULT | Cold-junction sensor hard fault |
| D28 | CJ_SOFT_FAULT | Cold-junction beyond normal range |
| D27 | SENSOR_OVER_RANGE | Reading above normal range |
| D26 | SENSOR_UNDER_RANGE | Reading below normal range |
| D25 | ADC_OUT_OF_RANGE | ADC input beyond ±1.125·VREF/2 |
| D24 | VALID | Result valid (1 = valid) |

## Technical Notes

### SPI Protocol
- Mode 0 (CPOL=0, CPHA=0)
- MSB first
- Max 2 MHz clock
- Big-endian multi-byte transfers
- Address auto-increment

### Conversion Timing
- 2-cycle conversion: ~167ms
- 3-cycle conversion: ~251ms (with OC check or 3-reading diode)
- Minimum auto-scan interval: 200ms

### Temperature Resolution
- 1/1024 °C (or °F)
- 24-bit two's complement
- Range: -273.15°C to +8191.999°C

## License

MIT

## Credits

- Original driver: Reese Russell (2017)
- Updated implementation: 2026
- Based on LTC2983 Datasheet Rev. D
