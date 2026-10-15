/* ==========================================================================
   AGOS SIMULATION — CONFIGURATION & CONSTANTS
   Derived from AGOS_Simulation_Context.md
   ========================================================================== */

export const CONFIG = {
  // Hard Constraints & Disclaimers
  DISCLAIMER: "Motion-based status is a proxy signal, not a medical diagnosis.",
  SYSTEM_NAME: "AGOS — Autonomous Geolocation for Open-Sea Survival",
  SUBTITLE: "Team Pillagers · BS CpE 4-H2 · Adviser: Engr. Julian N. Semblante",

  // Node Count Configuration
  MAX_NODES: 3, // Configured to max 3 nodes as requested

  // Mapbox & Dead-Zone Offline Tile Cache Config
  MAPBOX: {
    TOKEN: "", // Loaded dynamically from .env or localStorage via loadEnv()
    DEFAULT_STYLE: "mapbox://styles/mapbox/dark-v11",
    SATELLITE_STYLE: "mapbox://styles/mapbox/satellite-streets-v12",
    NAV_NIGHT_STYLE: "mapbox://styles/mapbox/navigation-night-v1"
  },

  // Gateway Hardware Deployment Modes
  GATEWAY_MODES: {
    STANDALONE_OLED: "STANDALONE_OLED", // Option 1: Autonomous hardware box with 0.96" OLED display & buzzer
    MOBILE_COMPANION: "MOBILE_COMPANION" // Option 2: ESP32 connected via BLE / USB to rescuer mobile app
  },

  // Pre-cached Dead-Zone Maritime Sectors
  OFFLINE_SECTORS: [
    {
      id: "camotes_sea",
      name: "Camotes Sea, Central Visayas (Dead-Zone Sector A)",
      center: [124.2041, 10.6012],
      bounds: [[124.05, 10.45], [124.35, 10.75]],
      tileCount: 1420,
      sizeMb: 38.5,
      cached: true
    },
    {
      id: "guimaras_strait",
      name: "Guimaras Strait / Iloilo (Dead-Zone Sector B)",
      center: [122.6500, 10.6800],
      bounds: [[122.50, 10.50], [122.80, 10.85]],
      tileCount: 1650,
      sizeMb: 44.2,
      cached: false
    },
    {
      id: "cebu_strait",
      name: "Bohol / Cebu Strait (Dead-Zone Sector C)",
      center: [123.8500, 9.9000],
      bounds: [[123.70, 9.75], [124.00, 10.05]],
      tileCount: 1280,
      sizeMb: 34.0,
      cached: false
    }
  ],

  // Origin for Local Coordinate System (Open Sea, e.g. Camotes Sea / Cebu, Philippines)
  GEO_ORIGIN: {
    lat: 10.6012,
    lon: 124.2041,
    name: "Camotes Sea, Central Visayas, PH"
  },

  // Immersion Sensing [FIXED / TUNABLE]
  IMMERSION: {
    PULSE_INTERVAL_MS: 250,       // Immersion sense pulse frequency in DORMANT
    PULSE_DURATION_MS: 1,         // Low duty AC-like pulse to prevent electrolysis
    T_WET_DEFAULT_S: 2.0,         // Debounce requirement: continuous wet seconds to latch ACTIVE
    PROBE_SPACING_MM: 15,         // Physical probe spacing
    EXCITATION_VOLTAGE: 3.3,
    SERIES_RESISTOR_OHM: 1000,
    PULLDOWN_RESISTOR_OHM: 10000
  },

  // Motion Classification [TUNABLE from §7.1]
  MOTION: {
    SAMPLE_RATE_HZ: 50,
    WINDOW_S: 2.0,
    THRESHOLDS: {
      STILL_ACCEL_DEV: 0.03,      // a_dev < 0.03 g
      STILL_GYRO_MAG: 5.0,        // g_mag < 5 °/s
      STRUGGLING_ACCEL_DEV: 0.5,  // a_dev > 0.5 g
      STRUGGLING_GYRO_MAG: 120.0, // g_mag > 120 °/s
      STRUGGLING_TIME_S: 10.0     // sustained for 10 s
    },
    CRITICAL_STILL_TIME_S: 120.0, // Immersed and still >= 120s -> CRITICAL
    WARNING_STILL_TIME_S: 30.0,   // Immersed and still >= 30s -> WARNING
    DE_ESCALATION_HOLD_S: 30.0    // Hysteresis hold before dropping tier
  },

  // Reporting Intervals [TUNABLE from §6.2]
  // Configured to send every ~1.5 minutes to maximize battery life for 72h+ survival
  REPORT_INTERVAL: {
    STABLE_S: 90,                 // 1.5 minutes (90s) for routine tracking
    WARNING_S: 45,                // 45 seconds for warning condition
    CRITICAL_S: 15,               // 15 seconds for critical/SOS (prevents rapid battery depletion)
    JITTER_PCT: 0.10,             // ±10% random jitter to mitigate sync collisions
    CRITICAL_BURST_COUNT: 2       // Initial burst of 2 on status escalation
  },

  // Power & Battery Model [§12]
  POWER: {
    BATTERY_CAPACITY_MAH: 2500,   // LiPo 3.7V cell
    USABLE_CAPACITY_PCT: 0.88,    // 88% usable capacity
    SOLAR_PANEL_W: 1.5,           // 1.5W nominal solar panel
    SOLAR_EFFICIENCY: 0.70,       // TP4056 + angle efficiency
    CRITICAL_BATT_PCT: 10,        // Battery <= 10% escalates Warning to Critical
    WARNING_BATT_PCT: 20,         // Battery <= 20% escalates to Warning
    // Component Current Draws (mA)
    CURRENTS: {
      ESP32_ACTIVE_MA: 45.0,
      ESP32_SLEEP_MA: 1.8,        // Includes DevKit LDO & USB-UART overhead (1-5mA)
      LORA_TX_17DBM_MA: 105.0,
      LORA_RX_MA: 11.0,
      LORA_SLEEP_MA: 0.001,
      GPS_ACTIVE_MA: 35.0,        // NEO-M8N tracking
      GPS_SLEEP_MA: 0.0,          // If power-gated via MOSFET
      MPU6050_ACTIVE_MA: 3.8,
      MAX17048_ACTIVE_MA: 0.025,
      IMMERSION_MA: 0.05
    }
  },

  // GPS Sensor Model [§6.3]
  GPS: {
    SIGMA_ERROR_M: 2.5,           // CEP radius
    TTFF_COLD_S: 26,
    TTFF_WARM_S: 5,
    TTFF_HOT_S: 1,
    DEFAULT_SATS: 9,
    DEFAULT_HDOP: 1.1
  },

  // LoRa Radio Parameters [§10]
  RADIO: {
    DEFAULT_BAND_MHZ: 433,        // SX1278 (433MHz) or SX1276 (915MHz)
    BANDWIDTH_HZ: 125000,         // 125 kHz
    CODING_RATE: 1,               // 1 = 4/5
    PREAMBLE_SYMBOLS: 8,
    DEFAULT_TX_POWER_DBM: 17.0,
    ANTENNA_GAIN_DBI: -2.0,       // Wearable spring antenna
    GATEWAY_ANTENNA_GAIN_DBI: 3.0,// SAR vessel elevated whip/mast antenna
    BODY_LOSS_DB: 4.5,            // Body/vest absorption
    ANTENNA_HEIGHT_NODE_M: 0.3,   // Wearer waterline height
    ANTENNA_HEIGHT_GW_M: 3.5,     // SAR vessel deck/mast height
    CAPTURE_EFFECT_MARGIN_DB: 6.0,// Stronger packet survives if >= 6dB delta
    MAX_DIRECT_GW_RANGE_M: 850,   // Max direct reach from water-level node to SAR gateway (~850m due to wave swell blockage)
    MAX_NODE_RELAY_RANGE_M: 650   // Max reach between two waterline survivor vest nodes (~650m)
  },

  // Spreading Factor Table (BW = 125 kHz, CR = 4/5) [§10.2]
  SF_TABLE: {
    7:  { sensitivity: -123.0, snrMin: -7.5,  bitRate: 5.47,  toa24B: 0.062 },
    8:  { sensitivity: -126.0, snrMin: -10.0, bitRate: 3.12,  toa24B: 0.113 },
    9:  { sensitivity: -129.0, snrMin: -12.5, bitRate: 1.76,  toa24B: 0.206 },
    10: { sensitivity: -132.0, snrMin: -15.0, bitRate: 0.98,  toa24B: 0.371 },
    11: { sensitivity: -134.5, snrMin: -17.5, bitRate: 0.54,  toa24B: 0.823 },
    12: { sensitivity: -137.0, snrMin: -20.0, bitRate: 0.29,  toa24B: 1.480 }
  },

  // Submerged-Antenna Attenuation Parameters [§10.6]
  SUBMERGED_LOSS_DB: {
    "433_fresh": 25.0,
    "915_fresh": 38.0,
    "433_sea": 65.0,
    "915_sea": 75.0
  },

  // Rescue Web Mesh & Modified AODV Routing [§9]
  ROUTING: {
    DEFAULT_MODE: "AGOS",         // "AGOS" (Adaptive SF + RSSI Cost + Priority Q) vs "BASELINE" (Standard AODV)
    COST_WEIGHTS: {
      W_HOPS: 1.0,                // w_h
      W_RSSI: 2.0,                // w_r
      W_BATT: 0.5                 // w_b
    },
    TARGET_SNR_MARGIN_DB: 6.0,    // Margin target for Adaptive SF
    ROUTE_TIMEOUT_S: 300.0,       // Route table expiry (aligned with 90s reporting)
    HELLO_INTERVAL_S: 60.0,       // Liveness beacon (conserves power)
    LOST_CONTACT_MULTIPLIER: 3.0  // Gateway declares LOST if no report in 3x interval (270s for stable)
  },

  // Environment Defaults [§11]
  ENV: {
    DEFAULT_SEA_STATE: 2,         // Beaufort 2 (Light breeze, 0.2-0.5m waves)
    WATER_TYPE: "sea",            // "sea" or "fresh"
    DEFAULT_CURRENT_MPS: 0.25,    // 0.25 m/s sea drift (~0.5 knot)
    DEFAULT_CURRENT_HEADING_DEG: 65, // Heading East-North-East
    WIND_LEAWAY_FACTOR: 0.03      // 3% wind leeway drift
  }
};

/**
 * Asynchronously loads environment variables from .env file or localStorage / window.ENV.
 * Sets CONFIG.MAPBOX.TOKEN dynamically without exposing secrets in source code.
 */
export async function loadEnv() {
  // 1. Check window.ENV or window.__ENV__
  if (typeof window !== "undefined") {
    if (window.ENV?.MAPBOX_ACCESS_TOKEN || window.ENV?.MAPBOX_TOKEN) {
      CONFIG.MAPBOX.TOKEN = window.ENV.MAPBOX_ACCESS_TOKEN || window.ENV.MAPBOX_TOKEN;
      return CONFIG.MAPBOX.TOKEN;
    }
    // 2. Check localStorage
    const saved = localStorage.getItem("MAPBOX_ACCESS_TOKEN") || localStorage.getItem("MAPBOX_TOKEN");
    if (saved) {
      CONFIG.MAPBOX.TOKEN = saved;
    }
  }

  // 3. Attempt to fetch .env from server root
  try {
    const res = await fetch(".env");
    if (res.ok) {
      const text = await res.text();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq !== -1) {
          const key = trimmed.slice(0, eq).trim();
          let val = trimmed.slice(eq + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (key === "MAPBOX_ACCESS_TOKEN" || key === "MAPBOX_TOKEN" || key === "VITE_MAPBOX_TOKEN") {
            if (val && !val.includes("your_mapbox_access_token_here")) {
              CONFIG.MAPBOX.TOKEN = val;
            }
          }
        }
      }
    }
  } catch (e) {
    // Silently fall back to existing CONFIG or canvas fallback
  }

  return CONFIG.MAPBOX.TOKEN;
}
