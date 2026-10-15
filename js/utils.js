/* ==========================================================================
   AGOS SIMULATION — UTILITIES, MATH & AUDIO SYNTHESIZER
   ========================================================================== */

import { CONFIG } from './config.js';

/**
 * Seedable Fast PRNG (Mulberry32)
 * Ensures reproducible scenarios and benchmark comparisons.
 */
export class SeededRNG {
  constructor(seed = 1337) {
    this.seed = seed;
    this.state = seed;
  }

  setSeed(seed) {
    this.seed = seed;
    this.state = seed;
  }

  random() {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min, max) {
    return min + this.random() * (max - min);
  }

  gaussian(mean = 0, stdDev = 1) {
    let u1 = this.random();
    let u2 = this.random();
    while (u1 <= 1e-15) u1 = this.random();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return mean + z0 * stdDev;
  }
}

export const rng = new SeededRNG(4242);

/**
 * Geographic conversions
 * Convert local meters (x East, y North) to Lat/Lon
 */
export function metersToLatLon(x, y, origin = CONFIG.GEO_ORIGIN) {
  // Approximate flat-earth projection for small operational area (< 20 km)
  const METERS_PER_DEG_LAT = 110574;
  const METERS_PER_DEG_LON = 111320 * Math.cos((origin.lat * Math.PI) / 180);

  const lat = origin.lat + y / METERS_PER_DEG_LAT;
  const lon = origin.lon + x / METERS_PER_DEG_LON;
  return { lat, lon };
}

export function latLonToMeters(lat, lon, origin = CONFIG.GEO_ORIGIN) {
  const METERS_PER_DEG_LAT = 110574;
  const METERS_PER_DEG_LON = 111320 * Math.cos((origin.lat * Math.PI) / 180);

  const y = (lat - origin.lat) * METERS_PER_DEG_LAT;
  const x = (lon - origin.lon) * METERS_PER_DEG_LON;
  return { x, y };
}

/**
 * Distance & Bearing
 */
export function getDistanceMeters(p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  return Math.hypot(dx, dy);
}

export function getBearingDegrees(p1, p2) {
  // 0 deg = North, 90 deg = East, 180 deg = South, 270 deg = West
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  let angle = Math.atan2(dx, dy) * (180 / Math.PI);
  if (angle < 0) angle += 360;
  return angle;
}

export function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/**
 * Web Audio Sound Effects Synthesizer
 */
class SoundEffects {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.lastAlarmTime = 0;
  }

  init() {
    if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
  }

  playLoRaChirp(sf = 7) {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      // CSS / LoRa chirp modulation: up-chirp frequency sweep
      const baseFreq = 1800 - (sf - 7) * 150;
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(baseFreq, now);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 2.2, now + 0.04);

      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.05);
    } catch (e) {
      // Audio context might be restricted before user interaction
    }
  }

  playCriticalAlarm() {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    if (now - this.lastAlarmTime < 1.5) return; // Debounce alarm sound
    this.lastAlarmTime = now;

    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(659, now + 0.15);
      osc.frequency.setValueAtTime(880, now + 0.3);

      gain.gain.setValueAtTime(0.12, now);
      gain.gain.setValueAtTime(0.12, now + 0.45);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.65);
    } catch (e) {}
  }

  playSonarPing() {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, now);
      osc.frequency.exponentialRampToValueAtTime(1180, now + 0.3);

      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.4);
    } catch (e) {}
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }
}

export const sfx = new SoundEffects();
