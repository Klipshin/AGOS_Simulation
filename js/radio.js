/* ==========================================================================
   AGOS SIMULATION — RADIO & CHANNEL PROPAGATION MODEL
   Derived from AGOS_Simulation_Context.md §10
   ========================================================================== */

import { CONFIG } from './config.js';
import { rng } from './utils.js';

export class RadioModel {
  constructor() {
    this.bandMHz = CONFIG.RADIO.DEFAULT_BAND_MHZ; // 433 or 915
    this.txPowerDbm = CONFIG.RADIO.DEFAULT_TX_POWER_DBM; // 17 dBm
    this.bandwidthHz = CONFIG.RADIO.BANDWIDTH_HZ; // 125000
    this.codingRate = CONFIG.RADIO.CODING_RATE; // 1 (4/5)
    this.preambleSymbols = CONFIG.RADIO.PREAMBLE_SYMBOLS; // 8
    this.waterType = CONFIG.ENV.WATER_TYPE; // "sea" or "fresh"
    this.antennaMismatch = false; // if true, adds 4 dB loss
  }

  /**
   * Compute exact Time-on-Air (ToA) in seconds (§10.3)
   * @param {number} sf Spreading factor 7-12
   * @param {number} payloadBytes Payload size in bytes (e.g. 26)
   */
  computeToA(sf, payloadBytes = 26) {
    const bw = this.bandwidthHz;
    const cr = this.codingRate; // 1 for 4/5
    const ih = 0; // explicit header
    const crc = 1; // CRC enabled
    const tsym = Math.pow(2, sf) / bw;
    
    // Low Data Rate Optimization (DE) enabled if symbol duration > 16ms
    const de = tsym > 0.016 ? 1 : 0;

    const tPreamble = (this.preambleSymbols + 4.25) * tsym;

    const numerator = 8 * payloadBytes - 4 * sf + 28 + 16 * crc - 20 * ih;
    const denominator = 4 * (sf - 2 * de);
    const terms = Math.max(Math.ceil(numerator / denominator) * (cr + 4), 0);
    const nPayload = 8 + terms;

    return tPreamble + nPayload * tsym;
  }

  /**
   * Calculate Path Loss over water (FSPL vs Two-Ray ground reflection) (§10.4)
   * @param {number} distanceMeters Distance in meters
   * @param {number} ht Transmitter height above waterline (e.g. 0.3m)
   * @param {number} hr Receiver height (0.3m for node, 3.5m for SAR vessel)
   * @param {number} seaState Beaufort 0-6
   */
  calculatePathLoss(distanceMeters, ht, hr, seaState = 2) {
    const d = Math.max(distanceMeters, 1.0);
    const fMHz = this.bandMHz;
    const wavelength = 299792458 / (fMHz * 1e6); // lambda in meters

    // 1. Free Space Path Loss (FSPL)
    const dKm = d / 1000.0;
    const fspl = 32.44 + 20 * Math.log10(dKm) + 20 * Math.log10(fMHz);

    // 2. Plane-earth Two-Ray reflection over seawater (break point)
    const dBreak = (4 * ht * hr) / wavelength;
    let twoRay = fspl;
    if (d > dBreak && ht > 0 && hr > 0) {
      twoRay = 40 * Math.log10(d) - 20 * Math.log10(ht * hr);
    }

    // Dominant deterministic path loss
    const detPL = Math.max(fspl, twoRay);

    // 3. Sea-state induced wave shadowing (log-normal)
    // sigma_s = 3 + 1.5 * SeaState dB
    const sigmaS = 3.0 + 1.5 * seaState;
    const shadowLoss = rng.gaussian(0, sigmaS);

    // 4. Small-scale multipath fast fading (Rayleigh/Rician approximation)
    const fastFade = rng.gaussian(0, 2.0);

    // 5. Body / Wearer loss & antenna mismatch
    const bodyLoss = CONFIG.RADIO.BODY_LOSS_DB || 4.5;
    const mismatchLoss = this.antennaMismatch ? 4.5 : 0.0;

    return Math.max(detPL + shadowLoss + fastFade + bodyLoss + mismatchLoss, 20.0);
  }

  /**
   * Evaluate Link Budget between two nodes
   * @returns {Object} { rssi, snr, isLinkOk, sfMargin, linkCost }
   */
  evaluateLink(distanceMeters, ht, hr, sf, seaState = 2, isSubmerged = false) {
    const sfSpec = CONFIG.SF_TABLE[sf] || CONFIG.SF_TABLE[7];

    const maxRange = hr > 1.5 
      ? (CONFIG.RADIO.MAX_DIRECT_GW_RANGE_M || 850) 
      : (CONFIG.RADIO.MAX_NODE_RELAY_RANGE_M || 650);

    // If beyond physical horizon or ocean swell wave blockage limit
    if (distanceMeters > maxRange) {
      return {
        distanceMeters,
        rssi: -138.0,
        snr: -22.0,
        sensitivity: sfSpec.sensitivity,
        snrMin: sfSpec.snrMin,
        marginDb: -15.0,
        isLinkOk: false,
        toa: this.computeToA(sf, 26)
      };
    }

    let pathLoss = this.calculatePathLoss(distanceMeters, ht, hr, seaState);

    // Submerged antenna attenuation hook (§10.6)
    if (isSubmerged) {
      const key = `${this.bandMHz}_${this.waterType}`;
      const submLoss = CONFIG.SUBMERGED_LOSS_DB[key] || 60.0;
      pathLoss += submLoss;
    }

    // Additional wave trough loss during high sea state
    if (seaState >= 3) {
      // Periodic wave shadowing trough penalty
      const waveTroughPenalty = rng.gaussian(seaState * 1.8, 2.0);
      pathLoss += Math.max(0, waveTroughPenalty);
    }

    const gTx = CONFIG.RADIO.ANTENNA_GAIN_DBI;
    const gRx = hr > 1.5 ? CONFIG.RADIO.GATEWAY_ANTENNA_GAIN_DBI : CONFIG.RADIO.ANTENNA_GAIN_DBI;

    // Received Signal Strength Indicator (dBm)
    const rssi = this.txPowerDbm + gTx + gRx - pathLoss;

    // Signal-to-Noise Ratio (dB)
    // Noise floor = -174 dBm/Hz + 10*log10(BW) + NF (approx -115 dBm at 125 kHz with 6dB NF)
    const noiseFloorDbm = -115.0;
    const snr = rssi - noiseFloorDbm;

    const isRssiOk = rssi >= sfSpec.sensitivity;
    const isSnrOk = snr >= sfSpec.snrMin;
    const isLinkOk = isRssiOk && isSnrOk;

    const sfMargin = Math.min(rssi - sfSpec.sensitivity, snr - sfSpec.snrMin);

    return {
      distanceMeters,
      rssi: Math.round(rssi * 10) / 10,
      snr: Math.round(snr * 10) / 10,
      sensitivity: sfSpec.sensitivity,
      snrMin: sfSpec.snrMin,
      marginDb: Math.round(sfMargin * 10) / 10,
      isLinkOk,
      toa: this.computeToA(sf, 26)
    };
  }

  /**
   * Collision resolution via LoRa Capture Effect (§9.3)
   * If two simultaneous transmissions arrive on the same SF,
   * the stronger one survives if RSSI difference >= 6.0 dB.
   */
  resolveCollision(packetA, packetB) {
    if (packetA.sf !== packetB.sf) {
      // Quasi-orthogonal spreading factors can decode simultaneously
      return { packetASurvives: true, packetBSurvives: true, captured: false };
    }

    const deltaRssi = packetA.rssi - packetB.rssi;
    if (deltaRssi >= CONFIG.RADIO.CAPTURE_EFFECT_MARGIN_DB) {
      // Packet A captures the receiver
      return { packetASurvives: true, packetBSurvives: false, captured: true, winner: packetA };
    } else if (deltaRssi <= -CONFIG.RADIO.CAPTURE_EFFECT_MARGIN_DB) {
      // Packet B captures the receiver
      return { packetASurvives: false, packetBSurvives: true, captured: true, winner: packetB };
    } else {
      // Destructive collision: both packets corrupted
      return { packetASurvives: false, packetBSurvives: false, captured: false };
    }
  }
}
