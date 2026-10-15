/* ==========================================================================
   AGOS SIMULATION — SURVIVOR NODE MODEL
   Derived from AGOS_Simulation_Context.md §5, §6, §7, §12
   ========================================================================== */

import { CONFIG } from './config.js';
import { rng, metersToLatLon, latLonToMeters } from './utils.js';
import { Packet, PACKET_TYPES, TIERS, PriorityPacketQueue, RouteEntry, computeLinkCost } from './mesh.js';

export const NODE_MODES = {
  DORMANT: "DORMANT",
  ACTIVE: "ACTIVE"
};

export const MOTION_CLASSES = {
  STILL: "STILL",
  FLOATING: "FLOATING",
  ACTIVE: "ACTIVE",
  STRUGGLING: "STRUGGLING"
};

export class SurvivorNode {
  constructor(id, x, y, script = "calm_floating") {
    this.id = id;
    this.x = x;                           // local meters East
    this.y = y;                           // local meters North
    this.script = script;                 // Behavior script
    this.mode = NODE_MODES.DORMANT;       // DORMANT or ACTIVE (latched)
    
    // Immersion Sensing (§6.1)
    this.instantWet = false;              // Real-time probe wet state
    this.continuousWetTime = 0.0;         // Debounce timer
    this.tWetRequired = CONFIG.IMMERSION.T_WET_DEFAULT_S;
    this.activationTime = null;           // Sim time when node activated
    this.firstPacketQueuedTime = null;

    // Manual SOS
    this.sosPressed = false;
    this.sosPressTime = null;

    // Wave Dunking & Submersion (§10.5)
    this.isAntennaSubmerged = false;
    this.submergeTimer = 0;

    // Motion & IMU (§7.1)
    this.motionIndex = 20;               // 0 - 100
    this.motionClass = MOTION_CLASSES.FLOATING;
    this.stillDuration = 0.0;            // continuous seconds STILL
    this.struggleDuration = 0.0;         // continuous seconds STRUGGLING
    this.accelDev = 0.02;                // a_dev (g)
    this.gyroMag = 3.0;                  // g_mag (°/s)

    // Fusion & Classification (§7.2)
    this.tier = TIERS.STABLE;
    this.rawTier = TIERS.STABLE;
    this.groundTruthTier = TIERS.STABLE; // For confusion matrix
    this.ruleFired = "R6_immersed_stable";
    this.deEscalationTimer = 0.0;        // Hysteresis timer

    // GPS Model (§6.3)
    this.gpsFixed = false;
    this.gpsLat = 0;
    this.gpsLon = 0;
    this.lastKnownLat = 0;
    this.lastKnownLon = 0;
    this.fixAge = 0;
    this.satellites = CONFIG.GPS.DEFAULT_SATS;
    this.hdop = CONFIG.GPS.DEFAULT_HDOP;
    this.ttffTimer = CONFIG.GPS.TTFF_WARM_S;

    // Power & Battery (§12)
    this.batteryCapacityMah = CONFIG.POWER.BATTERY_CAPACITY_MAH;
    this.batteryMah = this.batteryCapacityMah * 0.95; // start at ~95%
    this.batteryPct = 95.0;
    this.energyUsedMah = {
      esp32: 0,
      loraTx: 0,
      loraRx: 0,
      gps: 0,
      mpu6050: 0,
      solarHarvested: 0
    };
    this.listenDutyCycle = 0.70;         // 70% listen duty cycle
    this.isListening = true;

    // Radio & Mesh State (§8, §9)
    this.bandMHz = CONFIG.RADIO.DEFAULT_BAND_MHZ;
    this.currentSF = 7;                  // Adaptive SF starts at 7
    this.routes = new Map();             // destId -> RouteEntry
    this.seqCounter = 1;
    this.packetQueue = new PriorityPacketQueue(true);
    this.txQueueBurstRemaining = 0;
    this.nextReportTimer = rng.range(2, 5); // initial stagger
    this.helloTimer = rng.range(5, CONFIG.ROUTING.HELLO_INTERVAL_S);
    this.activeTxPacket = null;
    this.txTimer = 0;
    this.cadBackoffTimer = 0;

    // Physical Movement Drift
    this.vx = 0;
    this.vy = 0;
    this.positionHistory = [];

    // Hardware Pin Activity Monitor (for Hardware View tab §16)
    this.busActivity = {
      spi: false,
      i2c: false,
      uart: false,
      immersionPulse: false,
      ledStatus: false
    };

    // Initialize initial lat/lon
    this.updateGpsPosition(0);
  }

  /**
   * Primary Node Tick called every dt seconds
   */
  update(dt, simTime, env, radioModel, isAgosMode = true) {
    this.radioModel = radioModel;
    this.packetQueue.isAgosMode = isAgosMode;

    // 1. Physical Environment & Wave Interaction
    this.updateWaveAndDrift(dt, simTime, env);

    // 2. Hardware Immersion Probe Sensing (§6.1)
    this.updateImmersionSensing(dt, simTime, env, radioModel);

    // If node is not activated yet, minimal background check
    if (this.mode === NODE_MODES.DORMANT) {
      this.drainSleepPower(dt);
      return;
    }

    // 3. Motion & IMU Synthesis (§7.1)
    this.updateMotion(dt, simTime);

    // 4. GPS Position & Fix (§6.3)
    this.updateGpsFix(dt, simTime);

    // 5. On-Node Fusion Status Classification (§7.2)
    this.updateClassification(dt);

    // 6. Power Consumption & Solar Harvesting (§12)
    this.updatePower(dt, simTime, env);

    // 7. Route maintenance & HELLO beacons (§9.1)
    this.updateMeshRouting(dt, simTime, radioModel, isAgosMode);

    // 8. Transmission Scheduler (§6.2)
    this.updateReportingSchedule(dt, simTime, radioModel);

    // 9. Process Transmit Queue & CAD Backoff
    this.processQueue(dt, simTime, radioModel);
  }

  /**
   * Environmental drift and wave dunking
   */
  updateWaveAndDrift(dt, simTime, env) {
    // Current drift vector
    const headingRad = (env.currentHeadingDeg * Math.PI) / 180;
    const currentVx = env.currentSpeedMps * Math.sin(headingRad);
    const currentVy = env.currentSpeedMps * Math.cos(headingRad);

    // Per-node jitter & wind leeway
    const jitterX = rng.gaussian(0, 0.02);
    const jitterY = rng.gaussian(0, 0.02);

    this.vx = currentVx + jitterX;
    this.vy = currentVy + jitterY;

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Track breadcrumb trail every 10 seconds
    if (this.positionHistory.length === 0 || simTime - this.positionHistory[this.positionHistory.length - 1].time >= 15) {
      this.positionHistory.push({ x: this.x, y: this.y, time: simTime });
      if (this.positionHistory.length > 50) this.positionHistory.shift();
    }

    // Wave Dunking: Submerges antenna briefly based on Beaufort sea state (§10.5)
    if (env.seaState >= 3) {
      if (this.isAntennaSubmerged) {
        this.submergeTimer -= dt;
        if (this.submergeTimer <= 0) {
          this.isAntennaSubmerged = false;
        }
      } else {
        // Probability of dunking increases with sea state
        const dunkProbPerSec = (env.seaState - 2) * 0.035;
        if (rng.random() < dunkProbPerSec * dt) {
          this.isAntennaSubmerged = true;
          this.submergeTimer = rng.range(0.6, 2.0); // 0.5 - 2 s submersion
        }
      }
    } else {
      this.isAntennaSubmerged = false;
    }
  }

  /**
   * Immersion Sensing with Pulsed AC Excitation and Debounce (§6.1)
   */
  updateImmersionSensing(dt, simTime, env) {
    // Immersion pulse LED indicator
    this.busActivity.immersionPulse = Math.sin(simTime * 8) > 0.8;

    // Instantaneous water contact: simulated from water environment + waves
    if (this.script === "dry_bench_test") {
      this.instantWet = false;
    } else if (this.script === "splash_only") {
      // Wave splash shorter than T_wet (e.g. 0.8s splash then dry)
      const cycle = simTime % 10;
      this.instantWet = cycle < 0.8;
    } else {
      // Normal ocean immersion with wave crest/trough flicker
      const wavePhase = Math.sin(simTime * 1.5 + this.id);
      // In sea, probes on the bottom of the vest are almost continuously wet
      this.instantWet = wavePhase > -0.85;
    }

    // Debounce logic
    if (this.instantWet) {
      this.continuousWetTime += dt;
      if (this.continuousWetTime >= this.tWetRequired && this.mode === NODE_MODES.DORMANT) {
        // Latch ACTIVE!
        this.mode = NODE_MODES.ACTIVE;
        this.activationTime = simTime;
        this.busActivity.ledStatus = true;

        // Immediate first packet queueing
        this.queueOwnStatusPacket(simTime, true);
      }
    } else {
      // In DORMANT, dry resets debounce. In ACTIVE, node is latched!
      if (this.mode === NODE_MODES.DORMANT) {
        this.continuousWetTime = 0;
      }
    }

    // SOS Button can wake from DORMANT into ACTIVE instantly (§6.1)
    if (this.sosPressed && this.mode === NODE_MODES.DORMANT) {
      this.mode = NODE_MODES.ACTIVE;
      this.activationTime = simTime;
      this.queueOwnStatusPacket(simTime, true);
    }
  }

  /**
   * Synthesize Motion from Behavior Script (§7.1)
   */
  updateMotion(dt, simTime) {
    this.busActivity.i2c = true; // MPU6050 read

    // Behavior script execution
    switch (this.script) {
      case "calm_floating":
        this.accelDev = 0.015 + 0.01 * Math.sin(simTime * 0.4);
        this.gyroMag = 2.5 + 1.5 * Math.sin(simTime * 0.3);
        this.motionIndex = Math.round(15 + 5 * Math.sin(simTime * 0.5));
        this.motionClass = MOTION_CLASSES.FLOATING;
        this.stillDuration = 0;
        this.struggleDuration = 0;
        this.groundTruthTier = TIERS.STABLE;
        break;

      case "swimming":
        this.accelDev = 0.22 + 0.05 * Math.sin(simTime * 1.2);
        this.gyroMag = 40.0 + 15.0 * Math.sin(simTime * 0.9);
        this.motionIndex = Math.round(55 + 10 * Math.sin(simTime));
        this.motionClass = MOTION_CLASSES.ACTIVE;
        this.stillDuration = 0;
        this.struggleDuration = 0;
        this.groundTruthTier = TIERS.STABLE;
        break;

      case "struggling":
        this.accelDev = 0.65 + rng.gaussian(0, 0.1);
        this.gyroMag = 145.0 + rng.gaussian(0, 20);
        this.motionIndex = Math.min(100, Math.round(85 + rng.range(-5, 10)));
        this.struggleDuration += dt;
        this.stillDuration = 0;
        this.motionClass = MOTION_CLASSES.STRUGGLING;
        this.groundTruthTier = this.struggleDuration >= 10 ? TIERS.WARNING : TIERS.STABLE;
        break;

      case "unresponsive":
        // Survivor goes still (incapacitated / hypothermic)
        this.accelDev = 0.01 + rng.gaussian(0, 0.005);
        this.gyroMag = 1.2 + rng.gaussian(0, 0.5);
        this.motionIndex = 3;
        this.stillDuration += dt;
        this.struggleDuration = 0;
        this.motionClass = MOTION_CLASSES.STILL;
        if (this.stillDuration >= CONFIG.MOTION.CRITICAL_STILL_TIME_S) {
          this.groundTruthTier = TIERS.CRITICAL;
        } else if (this.stillDuration >= CONFIG.MOTION.WARNING_STILL_TIME_S) {
          this.groundTruthTier = TIERS.WARNING;
        } else {
          this.groundTruthTier = TIERS.STABLE;
        }
        break;

      default:
        this.motionClass = MOTION_CLASSES.FLOATING;
        this.groundTruthTier = TIERS.STABLE;
        break;
    }

    if (this.sosPressed) {
      this.groundTruthTier = TIERS.CRITICAL;
    }
  }

  /**
   * GPS Model: Error, Fix Age, Satellites, Dunk Dropouts (§6.3)
   */
  updateGpsFix(dt, simTime) {
    this.busActivity.uart = true; // GPS NMEA parsing

    if (this.isAntennaSubmerged) {
      // GPS signal lost while underwater
      this.gpsFixed = false;
      this.fixAge += dt;
      return;
    }

    if (this.ttffTimer > 0) {
      this.ttffTimer -= dt;
      this.gpsFixed = false;
      this.fixAge += dt;
      return;
    }

    this.gpsFixed = true;
    this.fixAge = 0;
    this.updateGpsPosition(simTime);
  }

  updateGpsPosition(simTime) {
    // Add circular Gaussian error sigma ~ 2.5m
    const errorX = rng.gaussian(0, CONFIG.GPS.SIGMA_ERROR_M);
    const errorY = rng.gaussian(0, CONFIG.GPS.SIGMA_ERROR_M);

    const coords = metersToLatLon(this.x + errorX, this.y + errorY);
    this.gpsLat = coords.lat;
    this.gpsLon = coords.lon;
    this.lastKnownLat = coords.lat;
    this.lastKnownLon = coords.lon;
  }

  /**
   * On-Node Status Classification Fusion (§7.2)
   */
  updateClassification(dt) {
    let candidateTier = TIERS.STABLE;
    let firedRule = "R6_immersed_stable";

    // Evaluate rules top to bottom, first match wins:
    // Rule 1: SOS pressed -> CRITICAL
    if (this.sosPressed) {
      candidateTier = TIERS.CRITICAL;
      firedRule = "R1_manual_sos";
    }
    // Rule 2: Immersed and still_duration >= 120s -> CRITICAL
    else if (this.mode === NODE_MODES.ACTIVE && this.stillDuration >= CONFIG.MOTION.CRITICAL_STILL_TIME_S) {
      candidateTier = TIERS.CRITICAL;
      firedRule = "R2_immersed_still_120s";
    }
    // Rule 3: Immersed and battery <= 10% and would otherwise be Warning -> CRITICAL
    else if (
      this.mode === NODE_MODES.ACTIVE &&
      this.batteryPct <= CONFIG.POWER.CRITICAL_BATT_PCT &&
      (this.motionClass === MOTION_CLASSES.STRUGGLING || this.stillDuration >= CONFIG.MOTION.WARNING_STILL_TIME_S)
    ) {
      candidateTier = TIERS.CRITICAL;
      firedRule = "R3_lowbat_escalation";
    }
    // Rule 4: Immersed and (STRUGGLING or still_duration >= 30s) -> WARNING
    else if (
      this.mode === NODE_MODES.ACTIVE &&
      (this.motionClass === MOTION_CLASSES.STRUGGLING || this.stillDuration >= CONFIG.MOTION.WARNING_STILL_TIME_S)
    ) {
      candidateTier = TIERS.WARNING;
      firedRule = "R4_struggling_or_still_30s";
    }
    // Rule 5: Immersed and battery <= 20% -> WARNING
    else if (this.mode === NODE_MODES.ACTIVE && this.batteryPct <= CONFIG.POWER.WARNING_BATT_PCT) {
      candidateTier = TIERS.WARNING;
      firedRule = "R5_battery_low_20pct";
    }
    // Rule 6: Immersed, otherwise -> STABLE
    else if (this.mode === NODE_MODES.ACTIVE) {
      candidateTier = TIERS.STABLE;
      firedRule = "R6_immersed_stable";
    }

    this.rawTier = candidateTier;

    // Hysteresis (§7.2):
    // Immediate escalation!
    if (candidateTier > this.tier) {
      const oldTier = this.tier;
      this.tier = candidateTier;
      this.ruleFired = firedRule;
      this.deEscalationTimer = 0;

      // Burst of 3 packets on entering Critical or SOS (§6.2)
      if (this.tier === TIERS.CRITICAL && oldTier !== TIERS.CRITICAL) {
        this.txQueueBurstRemaining = CONFIG.REPORT_INTERVAL.CRITICAL_BURST_COUNT;
        this.nextReportTimer = 0.1; // trigger immediately
      }
    }
    // De-escalation requires 30s lower condition hold
    else if (candidateTier < this.tier) {
      this.deEscalationTimer += dt;
      if (this.deEscalationTimer >= CONFIG.MOTION.DE_ESCALATION_HOLD_S) {
        this.tier = candidateTier;
        this.ruleFired = firedRule;
        this.deEscalationTimer = 0;
      }
    } else {
      this.deEscalationTimer = 0;
      this.ruleFired = firedRule;
    }
  }

  /**
   * Power Consumption & Solar Energy Harvesting (§12)
   */
  updatePower(dt, simTime, env) {
    const cur = CONFIG.POWER.CURRENTS;
    const hours = dt / 3600.0;

    // Drain subsystems
    const espMah = cur.ESP32_ACTIVE_MA * hours;
    const gpsMah = (this.gpsFixed ? cur.GPS_ACTIVE_MA : cur.GPS_ACTIVE_MA * 1.5) * hours;
    const mpuMah = cur.MPU6050_ACTIVE_MA * hours;
    const loraRxMah = (this.isListening ? cur.LORA_RX_MA : cur.LORA_SLEEP_MA) * hours;

    this.energyUsedMah.esp32 += espMah;
    this.energyUsedMah.gps += gpsMah;
    this.energyUsedMah.mpu6050 += mpuMah;
    this.energyUsedMah.loraRx += loraRxMah;

    let totalDrainMah = espMah + gpsMah + mpuMah + loraRxMah;

    // Accelerated battery drain test script
    if (this.script === "battery_drain_fast") {
      totalDrainMah *= 25.0;
    }

    // Solar Harvesting Model
    // Solar irradiance follows sinusoidal day/night cycle (24 hour period = 1440s or scaled)
    const solarTime = (simTime / 600) % 24; // 10 min = 1 virtual day
    let sunFactor = 0;
    if (solarTime >= 6 && solarTime <= 18) {
      sunFactor = Math.sin(((solarTime - 6) / 12) * Math.PI);
    }
    // Wave tilt & cloud factor
    const cloudFactor = env.seaState > 4 ? 0.4 : 0.85;
    const solarPowerW = CONFIG.POWER.SOLAR_PANEL_W * sunFactor * cloudFactor;
    // Charge current in mA @ 3.7V = (W / 3.7) * 1000 * efficiency
    const solarChargeCurrentMa = (solarPowerW / 3.7) * 1000 * CONFIG.POWER.SOLAR_EFFICIENCY;
    const solarHarvestedMah = solarChargeCurrentMa * hours;
    this.energyUsedMah.solarHarvested += solarHarvestedMah;

    // Net battery change
    this.batteryMah = Math.max(0, Math.min(this.batteryCapacityMah, this.batteryMah - totalDrainMah + solarHarvestedMah));
    this.batteryPct = Math.max(0, Math.min(100, (this.batteryMah / this.batteryCapacityMah) * 100));
  }

  drainSleepPower(dt) {
    const hours = dt / 3600.0;
    const sleepMah = (CONFIG.POWER.CURRENTS.ESP32_SLEEP_MA + CONFIG.POWER.CURRENTS.IMMERSION_MA) * hours;
    this.energyUsedMah.esp32 += sleepMah;
    this.batteryMah = Math.max(0, this.batteryMah - sleepMah);
    this.batteryPct = Math.max(0, (this.batteryMah / this.batteryCapacityMah) * 100);
  }

  /**
   * Reporting intervals per tier (§6.2)
   */
  updateReportingSchedule(dt, simTime, radioModel) {
    this.nextReportTimer -= dt;

    if (this.nextReportTimer <= 0) {
      this.queueOwnStatusPacket(simTime, false, radioModel);

      // Determine next report interval with ±10% jitter
      let baseInterval = CONFIG.REPORT_INTERVAL.STABLE_S;
      if (this.tier === TIERS.CRITICAL) {
        baseInterval = CONFIG.REPORT_INTERVAL.CRITICAL_S;
      } else if (this.tier === TIERS.WARNING) {
        baseInterval = CONFIG.REPORT_INTERVAL.WARNING_S;
      }

      const jitter = baseInterval * CONFIG.REPORT_INTERVAL.JITTER_PCT;
      const intervalWithJitter = baseInterval + rng.range(-jitter, jitter);

      if (this.txQueueBurstRemaining > 0) {
        this.txQueueBurstRemaining--;
        this.nextReportTimer = rng.range(0.8, 1.5); // rapid burst
      } else {
        this.nextReportTimer = intervalWithJitter;
      }
    }
  }

  /**
   * Build & enqueue own status packet
   */
  queueOwnStatusPacket(simTime, isFirstActivation = false, radioModel = null) {
    if (this.mode !== NODE_MODES.ACTIVE) return;

    const route = this.routes.get(0); // Route to gateway (0)
    const nextHop = route ? route.nextHop : 0;
    const sf = route ? route.sf : this.currentSF;
    const rm = radioModel || this.radioModel;
    const toa = rm ? rm.computeToA(sf, 26) : (CONFIG.SF_TABLE[sf]?.toa24B || 0.062);

    const packet = new Packet({
      type: PACKET_TYPES.STATUS,
      src: this.id,
      dst: 0,
      prev: this.id,
      nextHop: nextHop,
      seq: this.seqCounter++,
      ttl: 6,
      hops: 0,
      prio: this.tier,
      flags: {
        immersed: this.instantWet,
        sos: this.sosPressed,
        no_fix: !this.gpsFixed,
        lowbat: this.batteryPct <= 20,
        struggle: this.motionClass === MOTION_CLASSES.STRUGGLING,
        still: this.motionClass === MOTION_CLASSES.STILL
      },
      lat: this.gpsLat || this.lastKnownLat,
      lon: this.gpsLon || this.lastKnownLon,
      fix_age: Math.round(this.fixAge),
      sats: this.satellites,
      hdop: this.hdop,
      batt: Math.round(this.batteryPct),
      motion: this.motionIndex,
      motionClass: this.motionClass,
      ruleFired: this.ruleFired,
      createdTime: simTime,
      sf: sf,
      toa: toa
    });

    if (isFirstActivation && !this.firstPacketQueuedTime) {
      this.firstPacketQueuedTime = simTime;
    }

    this.packetQueue.enqueue(packet);
  }

  /**
   * Relay packet from another node (§9.2)
   */
  receivePacketToRelay(packet, simTime, radioModel, isAgosMode = true) {
    if (this.mode !== NODE_MODES.ACTIVE) return false;
    if (packet.ttl <= 1) return false; // Hop limit exceeded
    if (packet.hopPath.includes(this.id)) return false; // Loop prevention

    // Do not relay if antenna is submerged
    if (this.isAntennaSubmerged) return false;

    const route = this.routes.get(0);
    const nextHop = route ? route.nextHop : 0;
    const sf = route ? route.sf : this.currentSF;

    const relayPacket = packet.clone();
    relayPacket.prev = this.id;
    relayPacket.nextHop = nextHop;
    relayPacket.ttl -= 1;
    relayPacket.hops += 1;
    relayPacket.sf = sf;
    relayPacket.toa = (radioModel && typeof radioModel.computeToA === 'function') 
      ? radioModel.computeToA(sf, relayPacket.payloadBytes) 
      : (CONFIG.SF_TABLE[sf]?.toa24B || 0.062);
    relayPacket.hopPath.push(this.id);

    return this.packetQueue.enqueue(relayPacket);
  }

  /**
   * Mesh Routing Maintenance & HELLO Beacons (§9.1)
   */
  updateMeshRouting(dt, simTime, radioModel, isAgosMode) {
    this.helloTimer -= dt;
    if (this.helloTimer <= 0) {
      this.helloTimer = CONFIG.ROUTING.HELLO_INTERVAL_S + rng.range(-5, 5);
      // Clean expired routes
      for (const [destId, route] of this.routes.entries()) {
        if (simTime > route.expiryTime) {
          this.routes.delete(destId);
        }
      }
    }
  }

  /**
   * Process packet transmit queue & CAD backoff
   */
  processQueue(dt, simTime, radioModel) {
    // If currently transmitting, decrement airtime
    if (this.activeTxPacket) {
      this.txTimer -= dt;
      this.busActivity.spi = true; // SPI to LoRa SX127x

      // Deduct TX battery energy
      const hours = dt / 3600.0;
      const txMah = CONFIG.POWER.CURRENTS.LORA_TX_17DBM_MA * hours;
      this.energyUsedMah.loraTx += txMah;
      this.batteryMah = Math.max(0, this.batteryMah - txMah);

      if (this.txTimer <= 0) {
        // Transmission finished
        this.activeTxPacket = null;
      }
      return;
    }

    if (this.cadBackoffTimer > 0) {
      this.cadBackoffTimer -= dt;
      return;
    }

    if (this.packetQueue.length === 0) return;

    // Pick top packet according to priority queue
    const nextPacket = this.packetQueue.dequeue();
    if (!nextPacket) return;

    // Backoff window (§9.2 #3):
    // Critical packets get shorter random backoff
    let backoff = 0;
    if (this.packetQueue.isAgosMode && nextPacket.prio === TIERS.CRITICAL) {
      backoff = rng.range(0.02, 0.08); // 20 - 80 ms
    } else {
      backoff = rng.range(0.1, 0.4); // 100 - 400 ms
    }

    this.cadBackoffTimer = backoff;
    this.activeTxPacket = nextPacket;
    this.txTimer = nextPacket.toa;
    nextPacket.txStartTime = simTime + backoff;
    nextPacket.txEndTime = nextPacket.txStartTime + nextPacket.toa;
  }

  /**
   * Manual Controls / Triggers from UI
   */
  triggerSos() {
    this.sosPressed = true;
    this.sosPressTime = Date.now();
    this.mode = NODE_MODES.ACTIVE;
    this.txQueueBurstRemaining = CONFIG.REPORT_INTERVAL.CRITICAL_BURST_COUNT;
    this.nextReportTimer = 0.05;
  }

  resetSos() {
    this.sosPressed = false;
  }

  setScript(scriptName) {
    this.script = scriptName;
    if (scriptName === "unresponsive") {
      this.stillDuration = 0;
    } else if (scriptName === "struggling") {
      this.struggleDuration = 0;
    }
  }

  setBatteryPct(pct) {
    this.batteryPct = Math.max(0, Math.min(100, pct));
    this.batteryMah = this.batteryCapacityMah * (this.batteryPct / 100);
  }
}
