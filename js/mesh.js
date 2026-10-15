/* ==========================================================================
   AGOS SIMULATION — RESCUE WEB MESH & MODIFIED AODV ROUTING
   Derived from AGOS_Simulation_Context.md §8 & §9
   ========================================================================== */

import { CONFIG } from './config.js';

export const PACKET_TYPES = {
  STATUS: 0,
  RREQ: 1,
  RREP: 2,
  RERR: 3,
  ACK: 4,
  HELLO: 5
};

export const TIERS = {
  STABLE: 0,
  WARNING: 1,
  CRITICAL: 2
};

export class Packet {
  constructor(options = {}) {
    this.id = options.id || Math.random().toString(36).substring(2, 9);
    this.ver = options.ver || 1;
    this.type = options.type !== undefined ? options.type : PACKET_TYPES.STATUS;
    this.src = options.src;                   // Originating node ID
    this.dst = options.dst !== undefined ? options.dst : 0; // 0 = Master Gateway
    this.prev = options.prev || options.src;  // Previous hop node ID
    this.nextHop = options.nextHop || 0;      // Current intended recipient
    this.seq = options.seq || 1;              // Origin sequence number
    this.ttl = options.ttl || 7;              // Hop budget
    this.hops = options.hops || 0;            // Hops traversed so far
    this.prio = options.prio || TIERS.STABLE; // 0=Stable, 1=Warning, 2=Critical
    this.flags = options.flags || {};         // { immersed, sos, no_fix, lowbat, struggle, still }
    this.lat = options.lat || 0;
    this.lon = options.lon || 0;
    this.fix_age = options.fix_age || 0;
    this.sats = options.sats || CONFIG.GPS.DEFAULT_SATS;
    this.hdop = options.hdop || CONFIG.GPS.DEFAULT_HDOP;
    this.batt = options.batt || 100;
    this.motion = options.motion || 0;        // 0-100 motion index
    this.motionClass = options.motionClass || "FLOATING";
    this.ruleFired = options.ruleFired || "R6_immersed_stable";
    this.createdTime = options.createdTime || 0;
    this.sf = options.sf || 7;
    this.retries = options.retries || 0;

    // Airtime in seconds (calculated by radio model)
    this.toa = options.toa || 0.062;
    this.payloadBytes = options.payloadBytes || 26;

    // Simulation flight tracking
    this.txStartTime = 0;
    this.txEndTime = 0;
    this.hopPath = options.hopPath ? [...options.hopPath] : [this.src];
  }

  clone() {
    const p = new Packet({ ...this, hopPath: [...this.hopPath] });
    return p;
  }
}

/**
 * Priority-Aware Forwarding Queue (§9.2 #3)
 * Critical > Warning > Stable, then oldest first
 */
export class PriorityPacketQueue {
  constructor(isAgosMode = true) {
    this.queue = [];
    this.isAgosMode = isAgosMode;
    this.maxSize = 25;
  }

  enqueue(packet) {
    if (this.queue.length >= this.maxSize) {
      if (this.isAgosMode) {
        // Drop lowest priority packet (Stable first) on congestion
        const dropIndex = this.queue.findIndex(p => p.prio === TIERS.STABLE);
        if (dropIndex !== -1 && packet.prio > TIERS.STABLE) {
          this.queue.splice(dropIndex, 1);
        } else if (this.queue.length >= this.maxSize) {
          return false; // Queue full
        }
      } else {
        // Baseline FIFO: drop tail
        this.queue.shift();
      }
    }

    this.queue.push(packet);

    if (this.isAgosMode) {
      // Sort: Priority descending (Critical=2 first), then createdTime ascending (older first)
      this.queue.sort((a, b) => {
        if (b.prio !== a.prio) return b.prio - a.prio;
        return a.createdTime - b.createdTime;
      });
    }

    return true;
  }

  dequeue() {
    return this.queue.shift();
  }

  peek() {
    return this.queue[0] || null;
  }

  get length() {
    return this.queue.length;
  }

  clear() {
    this.queue = [];
  }
}

/**
 * Routing Table Entry for Modified AODV
 */
export class RouteEntry {
  constructor(destId, nextHop, hops, destSeq, cost = 1, sf = 7) {
    this.destId = destId;
    this.nextHop = nextHop;
    this.hops = hops;
    this.destSeq = destSeq;
    this.cost = cost;
    this.sf = sf;
    this.lastRssi = -100;
    this.lastSnr = 0;
    this.consecutiveLosses = 0;
    this.consecutiveSuccesses = 0;
    this.expiryTime = 0;
  }
}

/**
 * Compute Link Cost for Route Selection (§9.2 #1)
 * cost = w_h * hops + w_r * f(RSSI/SNR margin) + w_b * (battery penalty)
 */
export function computeLinkCost(hops, rssi, sensitivity, batteryPct = 100, isAgosMode = true) {
  if (!isAgosMode) {
    // Baseline AODV: plain hop count
    return hops;
  }

  const { W_HOPS, W_RSSI, W_BATT } = CONFIG.ROUTING.COST_WEIGHTS;
  const margin = Math.max(rssi - sensitivity, 0);

  // f(margin): steeply penalize links near sensitivity floor (< 6 dB margin)
  let fMargin = 0;
  if (margin < 6.0) {
    fMargin = 10.0 / (margin + 0.5); // high penalty
  } else {
    fMargin = 1.0 / (margin / 6.0);
  }

  // Battery penalty: penalize using relays whose battery is depleted
  const battFactor = batteryPct < 20 ? 3.0 : (100 - batteryPct) / 100.0;

  return (W_HOPS * hops) + (W_RSSI * fMargin) + (W_BATT * battFactor);
}
