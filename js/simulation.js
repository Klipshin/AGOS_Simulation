/* ==========================================================================
   AGOS SIMULATION — MAIN SIMULATION CONTROLLER & METRICS ENGINE
   Derived from AGOS_Simulation_Context.md §1, §9, §11, §14, §15
   ========================================================================== */

import { CONFIG } from './config.js';
import { rng } from './utils.js';
import { RadioModel } from './radio.js';
import { SurvivorNode, NODE_MODES, MOTION_CLASSES } from './node.js';
import { MasterGateway } from './gateway.js';
import { TIERS, RouteEntry, computeLinkCost } from './mesh.js';

export class Simulation {
  constructor() {
    this.simTime = 0;              // Simulated seconds elapsed
    this.timeScale = 1.0;          // 1x to 600x
    this.isPaused = false;
    this.isAgosMode = true;        // true = AGOS (contribution), false = Baseline AODV
    this.seed = 4242;

    // Environmental state
    this.env = {
      seaState: CONFIG.ENV.DEFAULT_SEA_STATE, // Beaufort 0-6
      waterType: CONFIG.ENV.WATER_TYPE,       // "sea" or "fresh"
      currentSpeedMps: CONFIG.ENV.DEFAULT_CURRENT_MPS,
      currentHeadingDeg: CONFIG.ENV.DEFAULT_CURRENT_HEADING_DEG,
      channelJammed: false
    };

    // Subsystems
    this.radio = new RadioModel();
    this.gateway = new MasterGateway(0, 800);
    this.nodes = [];
    this.selectedNodeId = 1;

    // In-Flight Packets propagating through wireless medium
    this.inFlightPackets = []; // { packet, sender, receiver, progress, isSuccess, linkInfo }

    // Evaluation Metrics Logger (§15)
    this.metrics = {
      packetsGenerated: { total: 0, [TIERS.STABLE]: 0, [TIERS.WARNING]: 0, [TIERS.CRITICAL]: 0 },
      packetsDelivered: { total: 0, [TIERS.STABLE]: 0, [TIERS.WARNING]: 0, [TIERS.CRITICAL]: 0 },
      latencies: { [TIERS.STABLE]: [], [TIERS.WARNING]: [], [TIERS.CRITICAL]: [] },
      hopCounts: [0, 0, 0, 0, 0, 0, 0, 0], // index = hop count
      collisionsCount: 0,
      retransmissionsCount: 0,
      rerrCount: 0,
      routeChangesCount: 0,
      activationLatencies: [],
      // Classification Confusion Matrix: [groundTruth][inferred]
      confusionMatrix: {
        [TIERS.STABLE]:   { [TIERS.STABLE]: 0, [TIERS.WARNING]: 0, [TIERS.CRITICAL]: 0 },
        [TIERS.WARNING]:  { [TIERS.STABLE]: 0, [TIERS.WARNING]: 0, [TIERS.CRITICAL]: 0 },
        [TIERS.CRITICAL]: { [TIERS.STABLE]: 0, [TIERS.WARNING]: 0, [TIERS.CRITICAL]: 0 }
      }
    };

    // Initialize Default Scenario
    this.loadScenario("abandon_ship");
  }

  /**
   * Main Simulation Step Loop
   */
  tick(realDt) {
    if (this.isPaused) return;

    // Limit maximum dt per frame to prevent numeric explosion during high speed-ups
    const effectiveDt = Math.min(realDt * this.timeScale, 1.0);
    this.simTime += effectiveDt;

    // 1. Update Master Gateway
    this.gateway.update(effectiveDt, this.simTime);

    // 2. Update Survivor Nodes
    for (const node of this.nodes) {
      node.update(effectiveDt, this.simTime, this.env, this.radio, this.isAgosMode);

      // Log activation responsiveness
      if (node.activationTime && node.firstPacketQueuedTime && !node._activationLogged) {
        node._activationLogged = true;
        const latency = node.firstPacketQueuedTime - (node.activationTime - node.tWetRequired);
        this.metrics.activationLatencies.push(latency);
      }

      // Record classification confusion matrix sample every 10 seconds
      if (node.mode === NODE_MODES.ACTIVE && Math.floor(this.simTime) % 10 === 0 && !node._cmSampled) {
        node._cmSampled = true;
        this.metrics.confusionMatrix[node.groundTruthTier][node.tier]++;
      } else if (Math.floor(this.simTime) % 10 !== 0) {
        node._cmSampled = false;
      }
    }

    // 3. Process Radio Wireless Medium & In-Flight Transmissions
    this.processWirelessMedium(effectiveDt);

    // 4. Update Dynamic Routing Mesh Paths (§9)
    this.updateMeshRoutingPaths();
  }

  /**
   * Wireless Medium: Packet Broadcast, Propagation, Interference, and Collisions
   */
  processWirelessMedium(dt) {
    // Collect all newly transmitting packets from active nodes
    for (const node of this.nodes) {
      if (node.activeTxPacket && !node.activeTxPacket._dispatched) {
        node.activeTxPacket._dispatched = true;
        const packet = node.activeTxPacket;

        // Metric: packet generated
        this.metrics.packetsGenerated.total++;
        this.metrics.packetsGenerated[packet.prio]++;

        // Find candidate receivers within physical reach
        this.dispatchPacketToMedium(packet, node);
      }
    }

    // Update in-flight packet animations and delivery completion
    for (let i = this.inFlightPackets.length - 1; i >= 0; i--) {
      const flight = this.inFlightPackets[i];
      flight.elapsed += dt;
      flight.progress = Math.min(1.0, flight.elapsed / flight.packet.toa);

      if (flight.elapsed >= flight.packet.toa) {
        // Packet reached destination receiver!
        this.deliverPacket(flight);
        this.inFlightPackets.splice(i, 1);
      }
    }
  }

  /**
   * Dispatch a packet onto the physical wireless channel
   */
  dispatchPacketToMedium(packet, sender) {
    if (this.env.channelJammed) {
      // Channel jammer active: all packets destroyed by RF interference
      this.metrics.collisionsCount++;
      return;
    }

    const potentialReceivers = [...this.nodes, this.gateway];

    for (const receiver of potentialReceivers) {
      if (receiver.id === sender.id) continue;

      // Calculate link budget
      const dist = Math.hypot(receiver.x - sender.x, receiver.y - sender.y);
      const ht = sender.antennaHeight || CONFIG.RADIO.ANTENNA_HEIGHT_NODE_M;
      const hr = receiver.antennaHeight || (receiver.id === 0 ? CONFIG.RADIO.GATEWAY_ANTENNA_HEIGHT_M : CONFIG.RADIO.ANTENNA_HEIGHT_NODE_M);

      const link = this.radio.evaluateLink(
        dist,
        ht,
        hr,
        packet.sf,
        this.env.seaState,
        sender.isAntennaSubmerged || (receiver.isAntennaSubmerged || false)
      );

      if (link.isLinkOk) {
        // Multi-hop routing: deliver to intended next-hop relay or directly to Gateway
        const isTarget = (packet.nextHop === receiver.id) || (packet.nextHop === 0 && receiver.id === 0);
        if (isTarget) {
          this.inFlightPackets.push({
            packet: packet.clone(),
            sender: sender,
            receiver: receiver,
            elapsed: 0,
            progress: 0,
            linkInfo: link,
            isCollision: false
          });
        }
      }
    }

    // Check for simultaneous overlapping transmissions at each receiver (Capture / Collision §9.3)
    this.resolveActiveCollisions();
  }

  /**
   * Check for collisions among concurrent packets arriving at identical receivers
   */
  resolveActiveCollisions() {
    const receiverMap = new Map();

    for (const flight of this.inFlightPackets) {
      const rxId = flight.receiver.id;
      if (!receiverMap.has(rxId)) {
        receiverMap.set(rxId, []);
      }
      receiverMap.get(rxId).push(flight);
    }

    for (const [rxId, flights] of receiverMap.entries()) {
      if (flights.length > 1) {
        // Collision evaluation between pairs
        for (let i = 0; i < flights.length; i++) {
          for (let j = i + 1; j < flights.length; j++) {
            const f1 = flights[i];
            const f2 = flights[j];

            const outcome = this.radio.resolveCollision(
              { sf: f1.packet.sf, rssi: f1.linkInfo.rssi },
              { sf: f2.packet.sf, rssi: f2.linkInfo.rssi }
            );

            if (!outcome.packetASurvives) f1.isCollision = true;
            if (!outcome.packetBSurvives) f2.isCollision = true;

            if (f1.isCollision || f2.isCollision) {
              this.metrics.collisionsCount++;
            }
          }
        }
      }
    }
  }

  /**
   * Complete delivery to destination receiver
   */
  deliverPacket(flight) {
    if (flight.isCollision) return; // Dropped due to collision

    const receiver = flight.receiver;
    const packet = flight.packet;

    if (receiver.id === 0) {
      // Reached Master Gateway!
      const result = this.gateway.ingestPacket(packet, this.simTime, flight.linkInfo);
      if (result.status === "ACCEPTED") {
        this.metrics.packetsDelivered.total++;
        this.metrics.packetsDelivered[packet.prio]++;

        const latency = Math.max(0.01, this.simTime - packet.createdTime);
        this.metrics.latencies[packet.prio].push(latency);
        if (this.metrics.latencies[packet.prio].length > 150) {
          this.metrics.latencies[packet.prio].shift();
        }

        const hopIdx = Math.min(packet.hops, this.metrics.hopCounts.length - 1);
        this.metrics.hopCounts[hopIdx]++;
      }
    } else {
      // Reached an intermediate SurvivorNode relay
      receiver.receivePacketToRelay(packet, this.simTime, this.radio, this.isAgosMode);
    }
  }

  /**
   * Update AODV Route Tables towards Gateway (0) for all nodes
   */
  updateMeshRoutingPaths() {
    // 2-pass distance vector to establish transitive multi-hop routes across mesh nodes
    for (let pass = 0; pass < 2; pass++) {
      for (const node of this.nodes) {
        if (node.mode !== NODE_MODES.ACTIVE) continue;

        // 1. Can node reach Gateway directly?
        const distToGw = Math.hypot(this.gateway.x - node.x, this.gateway.y - node.y);
        const directGwLink = this.radio.evaluateLink(
          distToGw,
          CONFIG.RADIO.ANTENNA_HEIGHT_NODE_M,
          this.gateway.antennaHeight,
          node.currentSF,
          this.env.seaState,
          node.isAntennaSubmerged
        );

        let bestNextHop = 0;
        let bestCost = Infinity;
        let bestHops = 1;
        let bestSf = node.currentSF;

        if (directGwLink.isLinkOk) {
          const directCost = computeLinkCost(1, directGwLink.rssi, directGwLink.sensitivity, node.batteryPct, this.isAgosMode);
          bestNextHop = 0;
          bestCost = directCost;
          bestHops = 1;

          if (this.isAgosMode) {
            bestSf = this.pickAdaptiveSf(directGwLink.rssi);
          }
        }

        // 2. Evaluate multi-hop neighbor relays (if direct link is weaker or out of reach)
        for (const neighbor of this.nodes) {
          if (neighbor.id === node.id || neighbor.mode !== NODE_MODES.ACTIVE) continue;

          const neighborRoute = neighbor.routes.get(0);
          if (!neighborRoute) continue; // neighbor has no path to gw
          if (neighborRoute.nextHop === node.id) continue; // prevent 2-node routing loops!

          const distToNeighbor = Math.hypot(neighbor.x - node.x, neighbor.y - node.y);
          const link = this.radio.evaluateLink(
            distToNeighbor,
            CONFIG.RADIO.ANTENNA_HEIGHT_NODE_M,
            CONFIG.RADIO.ANTENNA_HEIGHT_NODE_M,
            node.currentSF,
            this.env.seaState,
            node.isAntennaSubmerged || neighbor.isAntennaSubmerged
          );

          if (link.isLinkOk) {
            const totalHops = neighborRoute.hops + 1;
            const routeCost = computeLinkCost(totalHops, link.rssi, link.sensitivity, neighbor.batteryPct, this.isAgosMode);

            if (routeCost < bestCost) {
              bestCost = routeCost;
              bestNextHop = neighbor.id;
              bestHops = totalHops;

              if (this.isAgosMode) {
                bestSf = this.pickAdaptiveSf(link.rssi);
              }
            }
          }
        }

        // Store or update route
        if (bestCost < Infinity) {
          let route = node.routes.get(0);
          if (!route) {
            route = new RouteEntry(0, bestNextHop, bestHops, 1, bestCost, bestSf);
            node.routes.set(0, route);
            this.metrics.routeChangesCount++;
          } else {
            if (route.nextHop !== bestNextHop || route.hops !== bestHops) {
              this.metrics.routeChangesCount++;
            }
            route.nextHop = bestNextHop;
            route.hops = bestHops;
            route.cost = bestCost;
            route.sf = bestSf;
            route.expiryTime = this.simTime + CONFIG.ROUTING.ROUTE_TIMEOUT_S;
          }
          node.currentSF = bestSf;
        } else {
          // Route broken: no direct reach and no relay path available
          node.routes.delete(0);
        }
      }
    }
  }

  /**
   * Adaptive Spreading Factor Selection (§9.2 #2)
   * Pick lowest SF whose margin >= target margin (6 dB)
   */
  pickAdaptiveSf(rssi) {
    for (let sf = 7; sf <= 12; sf++) {
      const spec = CONFIG.SF_TABLE[sf];
      const margin = rssi - spec.sensitivity;
      if (margin >= CONFIG.ROUTING.TARGET_SNR_MARGIN_DB) {
        return sf;
      }
    }
    return 12; // fallback to most resilient SF
  }

  /**
   * Load Preset Scenarios (§14.1)
   */
  loadScenario(presetName) {
    this.simTime = 0;
    this.nodes = [];
    this.inFlightPackets = [];
    this.gateway = new MasterGateway(0, 1200); // SAR vessel starts ~1.2km North
    this.resetMetrics();
    rng.setSeed(this.seed);

    const maxN = CONFIG.MAX_NODES || 3;

    switch (presetName) {
      case "abandon_ship":
        // Multi-hop relay topology: Node 1 is beyond direct GW reach (>850m) and hops through Node 2!
        this.env.seaState = 2;
        this.env.currentSpeedMps = 0.25;
        this.env.currentHeadingDeg = 70;
        this.gateway.x = 0;
        this.gateway.y = 700;
        this.gateway.waypoints = [
          { x: 0, y: 700 },
          { x: 100, y: 300 },
          { x: -50, y: 0 }
        ];

        // Node 2 is at 280m (420m from GW -> Direct Hop 1)
        // Node 1 is at -220m (920m from GW -> Beyond 850m limit! 500m from Node 2 -> Hops through Node 2!)
        // Node 3 is at (180, 150) (578m from GW -> Direct Hop 1 or backup relay)
        const presets = [
          { id: 1, x: 0,   y: -220, script: "calm_floating" },
          { id: 2, x: 0,   y: 280,  script: "struggling" },
          { id: 3, x: 180, y: 150,  script: "unresponsive" }
        ];

        for (let i = 0; i < maxN; i++) {
          const cfg = presets[i] || { id: i + 1, x: (i - 1) * 80, y: 0, script: "calm_floating" };
          const node = new SurvivorNode(cfg.id, cfg.x, cfg.y, cfg.script);
          node.mode = NODE_MODES.ACTIVE;
          this.nodes.push(node);
        }
        break;

      case "dispersal":
        // 3-Hop Linear Relay Chain: Node 3 ➔ Node 1 ➔ Node 2 ➔ Gateway
        this.env.seaState = 3;
        this.env.currentSpeedMps = 0.55;
        this.env.currentHeadingDeg = 45;
        this.gateway.x = 0;
        this.gateway.y = 700;

        const dispPositions = [
          { id: 1, x: 0, y: -200, script: "calm_floating" }, // Hop 2 via #2
          { id: 2, x: 0, y: 300,  script: "calm_floating" }, // Hop 1 to GW
          { id: 3, x: 0, y: -680, script: "calm_floating" }  // Hop 3 via #1
        ];
        for (let i = 0; i < maxN; i++) {
          const cfg = dispPositions[i] || { id: i + 1, x: i * 200, y: i * 150, script: "calm_floating" };
          const node = new SurvivorNode(cfg.id, cfg.x, cfg.y, cfg.script);
          node.mode = NODE_MODES.ACTIVE;
          this.nodes.push(node);
        }
        break;

      case "critical_storm":
        // High sea state (Beaufort 4), one unresponsive + one SOS
        this.env.seaState = 4;
        this.env.currentSpeedMps = 0.4;
        this.gateway.x = 0;
        this.gateway.y = 600;

        const stormConfigs = [
          { id: 1, x: -80, y: -30, script: "unresponsive", sos: false },
          { id: 2, x: 60,  y: 40,  script: "struggling",   sos: false },
          { id: 3, x: 0,   y: 120, script: "calm_floating", sos: true }
        ];
        for (let i = 0; i < maxN; i++) {
          const cfg = stormConfigs[i] || { id: i + 1, x: (i - 1) * 60, y: 0, script: "calm_floating", sos: false };
          const node = new SurvivorNode(cfg.id, cfg.x, cfg.y, cfg.script);
          node.mode = NODE_MODES.ACTIVE;
          if (cfg.sos) node.triggerSos();
          this.nodes.push(node);
        }
        break;

      case "battery_stress":
        // Mixed battery levels across the 3 nodes
        this.env.seaState = 1;
        this.gateway.x = 0;
        this.gateway.y = 500;

        const battConfigs = [
          { id: 1, x: -70, y: 0,   script: "battery_drain_fast", batt: 18 },
          { id: 2, x: 0,   y: -60, script: "calm_floating",      batt: 52 },
          { id: 3, x: 70,  y: 40,  script: "calm_floating",      batt: 94 }
        ];
        for (let i = 0; i < maxN; i++) {
          const cfg = battConfigs[i] || { id: i + 1, x: (i - 1) * 70, y: 0, script: "calm_floating", batt: 75 };
          const node = new SurvivorNode(cfg.id, cfg.x, cfg.y, cfg.script);
          node.mode = NODE_MODES.ACTIVE;
          node.setBatteryPct(cfg.batt);
          this.nodes.push(node);
        }
        break;

      case "band_ab":
        // Direct benchmark comparison with 3 nodes
        this.env.seaState = 3;
        this.gateway.x = 0;
        this.gateway.y = 700;

        const bandConfigs = [
          { id: 1, x: -120, y: -40 },
          { id: 2, x: 0,    y: 60 },
          { id: 3, x: 140,  y: -20 }
        ];
        for (let i = 0; i < maxN; i++) {
          const cfg = bandConfigs[i] || { id: i + 1, x: (i - 1) * 100, y: 0 };
          const node = new SurvivorNode(cfg.id, cfg.x, cfg.y, "calm_floating");
          node.mode = NODE_MODES.ACTIVE;
          this.nodes.push(node);
        }
        break;
    }

    this.selectedNodeId = 1;
  }

  resetMetrics() {
    this.metrics = {
      packetsGenerated: { total: 0, [TIERS.STABLE]: 0, [TIERS.WARNING]: 0, [TIERS.CRITICAL]: 0 },
      packetsDelivered: { total: 0, [TIERS.STABLE]: 0, [TIERS.WARNING]: 0, [TIERS.CRITICAL]: 0 },
      latencies: { [TIERS.STABLE]: [], [TIERS.WARNING]: [], [TIERS.CRITICAL]: [] },
      hopCounts: [0, 0, 0, 0, 0, 0, 0, 0],
      collisionsCount: 0,
      retransmissionsCount: 0,
      rerrCount: 0,
      routeChangesCount: 0,
      activationLatencies: [],
      confusionMatrix: {
        [TIERS.STABLE]:   { [TIERS.STABLE]: 0, [TIERS.WARNING]: 0, [TIERS.CRITICAL]: 0 },
        [TIERS.WARNING]:  { [TIERS.STABLE]: 0, [TIERS.WARNING]: 0, [TIERS.CRITICAL]: 0 },
        [TIERS.CRITICAL]: { [TIERS.STABLE]: 0, [TIERS.WARNING]: 0, [TIERS.CRITICAL]: 0 }
      }
    };
  }

  /**
   * Fault Injection (§14)
   */
  injectFault(type, targetId = null) {
    switch (type) {
      case "kill_node": {
        const id = targetId || this.selectedNodeId;
        const node = this.nodes.find(n => n.id === id);
        if (node) {
          node.mode = NODE_MODES.DORMANT;
          node.batteryPct = 0;
          node.batteryMah = 0;
        }
        break;
      }
      case "jam_channel":
        this.env.channelJammed = !this.env.channelJammed;
        break;

      case "rogue_wave":
        this.env.seaState = Math.min(6, this.env.seaState + 2);
        // dunk all nodes
        for (const n of this.nodes) {
          n.isAntennaSubmerged = true;
          n.submergeTimer = 2.5;
        }
        break;

      case "gps_blackout":
        for (const n of this.nodes) {
          n.gpsFixed = false;
          n.ttffTimer = 45;
        }
        break;
    }
  }

  /**
   * Export Evaluation Metrics as CSV (§15)
   */
  exportCsv() {
    let csv = "Timestamp_s,Node_ID,Mode,Tier,Rule_Fired,Lat,Lon,Battery_Pct,Motion_Class,Motion_Idx,Hops,SF\n";
    for (const node of this.nodes) {
      csv += `${this.simTime.toFixed(1)},${node.id},${node.mode},${node.tier},${node.ruleFired},${node.gpsLat.toFixed(6)},${node.gpsLon.toFixed(6)},${node.batteryPct.toFixed(1)},${node.motionClass},${node.motionIndex},${node.routes.get(0)?.hops || 0},${node.currentSF}\n`;
    }
    return csv;
  }
}
