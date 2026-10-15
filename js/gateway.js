/* ==========================================================================
   AGOS SIMULATION — MASTER GATEWAY & RESCUER INGESTION
   Derived from AGOS_Simulation_Context.md §8, §13
   ========================================================================== */

import { CONFIG } from './config.js';
import { TIERS } from './mesh.js';
import { sfx } from './utils.js';

export class MasterGateway {
  constructor(x = 0, y = 500) {
    this.id = 0; // Gateway node ID is always 0
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.antennaHeight = CONFIG.RADIO.ANTENNA_HEIGHT_GW_M; // 3.5m elevated antenna
    
    // Waypoint Navigation
    this.waypoints = [
      { x: 0, y: 500 },
      { x: 300, y: 100 },
      { x: -200, y: -200 },
      { x: 100, y: -400 }
    ];
    this.currentWaypointIdx = 0;
    this.speedMps = 3.5; // SAR vessel speed ~ 7 knots
    this.isStationary = false;

    // Node Telemetry Registry
    // key: nodeId -> node record
    this.nodes = new Map();

    // Deduplication Cache: key "src_seq" -> timestamp
    this.dedupeMap = new Map();

    // Metrics & Packet Log
    this.packetsReceivedTotal = 0;
    this.packetsDeduplicated = 0;
    this.lastReceivedPacket = null;
    this.lastPacketTime = 0;
    this.packetHistory = []; // last 100 packets

    // OLED display refresh state
    this.oledScreenPage = 0;
    this.oledTimer = 0;
  }

  update(dt, simTime) {
    // 1. SAR Vessel Waypoint Movement
    if (!this.isStationary && this.waypoints.length > 0) {
      const target = this.waypoints[this.currentWaypointIdx];
      const dx = target.x - this.x;
      const dy = target.y - this.y;
      const dist = Math.hypot(dx, dy);

      if (dist < 15) {
        // Next waypoint
        this.currentWaypointIdx = (this.currentWaypointIdx + 1) % this.waypoints.length;
      } else {
        this.vx = (dx / dist) * this.speedMps;
        this.vy = (dy / dist) * this.speedMps;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
      }
    }

    // 2. Check Lost-Contact Timeouts (§13.1)
    for (const [nodeId, record] of this.nodes.entries()) {
      const timeSinceReport = simTime - record.lastSeenSimTime;
      let threshold = CONFIG.REPORT_INTERVAL.STABLE_S * CONFIG.ROUTING.LOST_CONTACT_MULTIPLIER; // 180s

      if (record.tier === TIERS.CRITICAL) {
        threshold = CONFIG.REPORT_INTERVAL.CRITICAL_S * CONFIG.ROUTING.LOST_CONTACT_MULTIPLIER; // 15s
      } else if (record.tier === TIERS.WARNING) {
        threshold = CONFIG.REPORT_INTERVAL.WARNING_S * CONFIG.ROUTING.LOST_CONTACT_MULTIPLIER; // 60s
      }

      record.isLost = timeSinceReport > threshold;
      record.ageSeconds = timeSinceReport;
    }

    // 3. Clean deduplication cache every 60s
    if (this.dedupeMap.size > 2000) {
      this.dedupeMap.clear();
    }
  }

  /**
   * Ingest Packet received over LoRa (§13.1)
   */
  ingestPacket(packet, simTime, linkInfo) {
    this.packetsReceivedTotal++;
    const dedupeKey = `${packet.src}_${packet.seq}`;

    // Deduplication check
    if (this.dedupeMap.has(dedupeKey)) {
      this.packetsDeduplicated++;
      return { status: "DEDUPLICATED", packet };
    }

    this.dedupeMap.set(dedupeKey, simTime);
    this.lastPacketTime = simTime;
    this.lastReceivedPacket = packet;

    // Latency calculation
    const latency = Math.max(0.01, simTime - packet.createdTime);

    // Audio/visual feedback for rescue team
    if (packet.prio === TIERS.CRITICAL) {
      sfx.playCriticalAlarm();
    } else {
      sfx.playLoRaChirp(packet.sf);
    }

    // Node Record creation or update
    let record = this.nodes.get(packet.src);
    const isFirstReport = !record;

    if (!record) {
      record = {
        id: packet.src,
        firstSeenSimTime: simTime,
        lastSeenSimTime: simTime,
        tier: packet.prio,
        previousTier: packet.prio,
        sos: packet.flags.sos,
        acknowledged: false,
        lat: packet.lat,
        lon: packet.lon,
        fixAge: packet.fix_age,
        sats: packet.sats,
        hdop: packet.hdop,
        battery: packet.batt,
        motion: packet.motion,
        motionClass: packet.motionClass,
        ruleFired: packet.ruleFired,
        hops: packet.hops,
        lastHopRssi: linkInfo.rssi,
        lastHopSnr: linkInfo.snr,
        sfUsed: packet.sf,
        hopPath: packet.hopPath,
        packetsDelivered: 1,
        latencies: [latency],
        isLost: false,
        trail: [{ lat: packet.lat, lon: packet.lon, time: simTime }]
      };
      this.nodes.set(packet.src, record);
    } else {
      // Escalation / changes
      if (packet.prio > record.tier) {
        record.acknowledged = false; // Reset ack on escalation
      }
      record.previousTier = record.tier;
      record.tier = packet.prio;
      record.sos = packet.flags.sos;
      record.lat = packet.lat;
      record.lon = packet.lon;
      record.fixAge = packet.fix_age;
      record.sats = packet.sats;
      record.hdop = packet.hdop;
      record.battery = packet.batt;
      record.motion = packet.motion;
      record.motionClass = packet.motionClass;
      record.ruleFired = packet.ruleFired;
      record.hops = packet.hops;
      record.lastHopRssi = linkInfo.rssi;
      record.lastHopSnr = linkInfo.snr;
      record.sfUsed = packet.sf;
      record.hopPath = packet.hopPath;
      record.lastSeenSimTime = simTime;
      record.packetsDelivered++;
      record.latencies.push(latency);
      if (record.latencies.length > 50) record.latencies.shift();

      // Add to drift trail
      if (record.trail.length === 0 || simTime - record.trail[record.trail.length - 1].time >= 20) {
        record.trail.push({ lat: packet.lat, lon: packet.lon, time: simTime });
        if (record.trail.length > 40) record.trail.shift();
      }
    }

    // Packet log buffer
    this.packetHistory.unshift({
      time: simTime,
      src: packet.src,
      seq: packet.seq,
      tier: packet.prio,
      hops: packet.hops,
      sf: packet.sf,
      rssi: linkInfo.rssi,
      snr: linkInfo.snr,
      latency: latency,
      ruleFired: packet.ruleFired
    });
    if (this.packetHistory.length > 80) this.packetHistory.pop();

    return { status: "ACCEPTED", packet, isFirstReport };
  }

  /**
   * Priority Ranked Alert List (§13.1)
   * Tier desc -> SOS first -> time-since-last-report desc -> battery asc
   */
  getRankedAlerts(simTime) {
    const list = Array.from(this.nodes.values());
    list.sort((a, b) => {
      // 1. Tier descending (Critical=2 first)
      if (b.tier !== a.tier) return b.tier - a.tier;
      // 2. SOS first
      if (b.sos !== a.sos) return (b.sos ? 1 : 0) - (a.sos ? 1 : 0);
      // 3. Time since last report descending (oldest reports prioritized)
      const ageA = simTime - a.lastSeenSimTime;
      const ageB = simTime - b.lastSeenSimTime;
      if (Math.abs(ageB - ageA) > 1) return ageB - ageA;
      // 4. Battery ascending (lowest battery first)
      return a.battery - b.battery;
    });
    return list;
  }

  acknowledgeNode(nodeId) {
    const record = this.nodes.get(nodeId);
    if (record) {
      record.acknowledged = true;
    }
  }

  /**
   * Render Master Gateway 0.96" SSD1306 128x64 OLED Mock (§13.2 #6)
   */
  renderOled(canvasCtx, simTime) {
    const ctx = canvasCtx;
    if (!ctx) return;

    // OLED Dimensions: 128 x 64 pixels
    ctx.fillStyle = "#02070f";
    ctx.fillRect(0, 0, 128, 64);

    // Subtle OLED scanline grid
    ctx.fillStyle = "rgba(0, 240, 255, 0.03)";
    for (let y = 0; y < 64; y += 2) {
      ctx.fillRect(0, y, 128, 1);
    }

    ctx.font = "8px monospace";
    ctx.fillStyle = "#00f0ff"; // Classic Cyan OLED

    // Header line
    ctx.fillText("AGOS GW-0 [433MHz]", 2, 9);
    ctx.strokeStyle = "#00f0ff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 11);
    ctx.lineTo(128, 11);
    ctx.stroke();

    // Summary counts
    let critCount = 0;
    let warnCount = 0;
    let stableCount = 0;
    for (const n of this.nodes.values()) {
      if (n.tier === TIERS.CRITICAL) critCount++;
      else if (n.tier === TIERS.WARNING) warnCount++;
      else stableCount++;
    }

    // Line 2: Stats
    ctx.fillStyle = critCount > 0 ? "#ff3366" : "#00f0ff";
    ctx.fillText(`NODES:${this.nodes.size} CRIT:${critCount}`, 2, 22);

    // Line 3: Warnings & Mode
    ctx.fillStyle = warnCount > 0 ? "#f59e0b" : "#10b981";
    ctx.fillText(`WARN:${warnCount}  STBL:${stableCount}`, 2, 33);

    // Line 4: Last Packet Ingested
    ctx.fillStyle = "#00f0ff";
    if (this.lastReceivedPacket) {
      const p = this.lastReceivedPacket;
      const age = Math.round(simTime - this.lastPacketTime);
      const tierTag = p.prio === 2 ? "CRIT" : (p.prio === 1 ? "WARN" : "STBL");
      ctx.fillText(`RX:#${p.src.toString().padStart(2, '0')} [${tierTag}] ${age}s`, 2, 45);
      ctx.fillText(`H:${p.hops} SF${p.sf} B:${p.batt}%`, 2, 55);
    } else {
      ctx.fillText("LISTENING MESH...", 2, 45);
      ctx.fillText("AODV SINK READY", 2, 55);
    }

    // Signal bars in top right corner
    const barX = 110;
    const barY = 9;
    ctx.fillStyle = "#00f0ff";
    ctx.fillRect(barX + 0, barY - 2, 2, 2);
    ctx.fillRect(barX + 3, barY - 4, 2, 4);
    ctx.fillRect(barX + 6, barY - 6, 2, 6);
    ctx.fillRect(barX + 9, barY - 8, 2, 8);
  }
}
