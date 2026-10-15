/* ==========================================================================
   AGOS SIMULATION — UI CONTROLLER, MAPBOX GIS & DASHBOARD RENDERER
   Derived from AGOS_Simulation_Context.md §13, §15, §16 + Mapbox + Dual Gateways
   ========================================================================== */

import { CONFIG } from './config.js';
import { TIERS } from './mesh.js';
import { NODE_MODES, MOTION_CLASSES } from './node.js';
import { sfx, formatTime, formatDuration, metersToLatLon, latLonToMeters } from './utils.js';

export class SimulationUI {
  constructor(sim) {
    this.sim = sim;

    // View Tabs
    this.activeTab = "tactical_map"; // "tactical_map", "mesh_graph", "hardware_view", "metrics_view"

    // Gateway Deployment Mode
    this.gatewayMode = CONFIG.GATEWAY_MODES.MOBILE_COMPANION;

    // Mapbox State
    this.mapbox = null;
    this.mapboxLoaded = false;
    this.mapStyle = CONFIG.MAPBOX.DEFAULT_STYLE;
    this.deadZoneMode = true; // Maritime dead-zone mode (offline tiles)

    // Map Canvas State (Overlay)
    this.mapContainer = document.getElementById("map-container");
    this.mapCanvas = document.getElementById("tactical-map-canvas");
    this.mapCtx = this.mapCanvas ? this.mapCanvas.getContext("2d") : null;
    this.zoom = 0.55;
    this.panX = 0;
    this.panY = 0;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.lastMouseX = 0;
    this.lastMouseY = 0;
    this.draggedNode = null;
    this.draggedGateway = false;

    // Last-Mile Radar Canvas
    this.radarCanvas = document.getElementById("radar-canvas");
    this.radarCtx = this.radarCanvas ? this.radarCanvas.getContext("2d") : null;

    // OLED Mock Canvases
    this.oledCanvas = document.getElementById("oled-canvas");
    this.oledCtx = this.oledCanvas ? this.oledCanvas.getContext("2d") : null;

    // Animation & Wave phase
    this.wavePhase = 0;
    this.radarSweepAngle = 0;

    // Initialize Mapbox & Listeners
    this.initMapbox();
    this.initEventListeners();
    this.resizeCanvases();
  }

  /**
   * Initialize Mapbox GL JS with the User's API Key
   */
  initMapbox() {
    if (window.mapboxgl) {
      if (!CONFIG.MAPBOX.TOKEN || CONFIG.MAPBOX.TOKEN.includes("your_mapbox_access_token_here")) {
        console.info(
          "AGOS Simulation: Mapbox token is not set or using placeholder. Add MAPBOX_ACCESS_TOKEN in .env (or localStorage.setItem('MAPBOX_ACCESS_TOKEN', 'your_token')). Falling back to tactical radar canvas."
        );
        return;
      }
      try {
        mapboxgl.accessToken = CONFIG.MAPBOX.TOKEN;
        this.mapbox = new mapboxgl.Map({
          container: 'mapbox-container',
          style: this.mapStyle,
          center: [CONFIG.GEO_ORIGIN.lon, CONFIG.GEO_ORIGIN.lat],
          zoom: 13.5,
          pitch: 20,
          bearing: -10,
          attributionControl: false
        });

        this.mapbox.on('load', () => {
          this.mapboxLoaded = true;
          this.resizeCanvases();
        });

        this.mapbox.on('resize', () => {
          this.resizeCanvases();
        });
      } catch (err) {
        console.warn("Mapbox initialization error, falling back to local canvas:", err);
      }
    }
  }

  resizeCanvases() {
    if (this.mapCanvas && this.mapCanvas.parentElement) {
      const rect = this.mapCanvas.parentElement.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        this.mapCanvas.width = rect.width;
        this.mapCanvas.height = rect.height;
        if (this.panX === 0 && this.panY === 0) {
          this.panX = rect.width / 2;
          this.panY = rect.height / 2 + 60;
        }
      }
    }
    if (this.mapbox && this.mapboxLoaded) {
      this.mapbox.resize();
    }
    if (this.radarCanvas) {
      this.radarCanvas.width = 120;
      this.radarCanvas.height = 120;
    }
    if (this.oledCanvas) {
      this.oledCanvas.width = 128;
      this.oledCanvas.height = 64;
    }
  }

  initEventListeners() {
    window.addEventListener("resize", () => this.resizeCanvases());

    // Map Click & Drag Interactivity (Dragging Gateway AND Nodes)
    if (this.mapCanvas) {
      this.mapCanvas.addEventListener("mousedown", (e) => {
        const rect = this.mapCanvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // 1. Check if user clicked on Master Gateway (SAR Vessel)
        const gwPos = this.worldToScreen(this.sim.gateway.x, this.sim.gateway.y);
        if (Math.hypot(gwPos.x - mouseX, gwPos.y - mouseY) < 30) {
          this.draggedGateway = true;
          this.draggedNode = null;
          if (this.mapbox) this.mapbox.dragPan.disable();
          this.mapCanvas.style.cursor = "grabbing";
          e.stopPropagation();
          return;
        }

        // 2. Check if user clicked on any survivor node
        let clickedNode = null;
        for (const n of this.sim.nodes) {
          const pt = this.worldToScreen(n.x, n.y);
          if (Math.hypot(pt.x - mouseX, pt.y - mouseY) < 22) {
            clickedNode = n;
            break;
          }
        }

        if (clickedNode) {
          this.sim.selectedNodeId = clickedNode.id;
          this.draggedNode = clickedNode;
          this.draggedGateway = false;
          if (this.mapbox) this.mapbox.dragPan.disable();
          this.mapCanvas.style.cursor = "grabbing";
          this.renderNodeDrawer();
          e.stopPropagation();
          return;
        }

        // 3. User clicked on empty sea -> Pan map
        this.isDragging = true;
        this.dragStartX = mouseX;
        this.dragStartY = mouseY;
        this.lastMouseX = mouseX;
        this.lastMouseY = mouseY;
        this.mapCanvas.style.cursor = "grabbing";
      });

      this.mapCanvas.addEventListener("mousemove", (e) => {
        const rect = this.mapCanvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (this.draggedGateway) {
          const worldPos = this.screenToWorld(mouseX, mouseY);
          this.sim.gateway.x = worldPos.x;
          this.sim.gateway.y = worldPos.y;
        } else if (this.draggedNode) {
          const worldPos = this.screenToWorld(mouseX, mouseY);
          this.draggedNode.x = worldPos.x;
          this.draggedNode.y = worldPos.y;
          this.draggedNode.updateGpsPosition(this.sim.simTime);
        } else if (this.isDragging) {
          const dx = mouseX - this.lastMouseX;
          const dy = mouseY - this.lastMouseY;
          this.lastMouseX = mouseX;
          this.lastMouseY = mouseY;

          if (this.mapbox && this.mapboxLoaded) {
            this.mapbox.panBy([-dx, -dy], { duration: 0 });
          } else {
            this.panX += dx;
            this.panY += dy;
          }
        } else {
          // Hover cursor state detection
          const gwPos = this.worldToScreen(this.sim.gateway.x, this.sim.gateway.y);
          const isOverGw = Math.hypot(gwPos.x - mouseX, gwPos.y - mouseY) < 30;
          let isOverNode = false;
          for (const n of this.sim.nodes) {
            const pt = this.worldToScreen(n.x, n.y);
            if (Math.hypot(pt.x - mouseX, pt.y - mouseY) < 22) {
              isOverNode = true;
              break;
            }
          }
          this.mapCanvas.style.cursor = (isOverGw || isOverNode) ? "grab" : "default";
        }
      });

      window.addEventListener("mouseup", () => {
        this.isDragging = false;
        this.draggedNode = null;
        this.draggedGateway = false;
        if (this.mapbox) this.mapbox.dragPan.enable();
        if (this.mapCanvas) this.mapCanvas.style.cursor = "default";
      });

      this.mapCanvas.addEventListener("wheel", (e) => {
        if (!this.mapbox || !this.mapboxLoaded) {
          e.preventDefault();
          const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
          const newZoom = Math.max(0.15, Math.min(2.5, this.zoom * zoomFactor));

          const rect = this.mapCanvas.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;

          this.panX = mouseX - (mouseX - this.panX) * (newZoom / this.zoom);
          this.panY = mouseY - (mouseY - this.panY) * (newZoom / this.zoom);
          this.zoom = newZoom;
        }
      });
    }

    // Top Navigation Tabs
    document.querySelectorAll(".top-tabs .tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".top-tabs .tab").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".workspace .view").forEach(p => p.classList.remove("active"));
        btn.classList.add("active");
        this.activeTab = btn.dataset.tab;
        const panel = document.getElementById(`panel-${this.activeTab}`);
        if (panel) panel.classList.add("active");

        if (this.activeTab === "tactical_map" && this.mapbox) {
          this.mapbox.resize();
        }
      });
    });

    // Collapsible sidebars
    const btnCollapseAlerts = document.getElementById("btn-collapse-alerts");
    const sidebarAlerts = document.getElementById("sidebar-alerts");
    if (btnCollapseAlerts && sidebarAlerts) {
      btnCollapseAlerts.addEventListener("click", () => {
        sidebarAlerts.classList.toggle("collapsed");
        btnCollapseAlerts.textContent = sidebarAlerts.classList.contains("collapsed") ? "▶" : "◀";
        setTimeout(() => this.resizeCanvases(), 350);
      });
    }

    const btnCollapseDetail = document.getElementById("btn-collapse-detail");
    const sidebarDetail = document.getElementById("sidebar-detail");
    if (btnCollapseDetail && sidebarDetail) {
      btnCollapseDetail.addEventListener("click", () => {
        sidebarDetail.classList.toggle("collapsed");
        btnCollapseDetail.textContent = sidebarDetail.classList.contains("collapsed") ? "◀" : "▶";
        setTimeout(() => this.resizeCanvases(), 350);
      });
    }

    // Gateway Mode Selector
    const selectGwMode = document.getElementById("select-gateway-mode");
    if (selectGwMode) {
      selectGwMode.addEventListener("change", (e) => {
        this.setGatewayMode(e.target.value);
      });
    }

    // Mapbox Style Selector
    const selectMapStyle = document.getElementById("select-map-style");
    if (selectMapStyle) {
      selectMapStyle.addEventListener("change", (e) => {
        const styleKey = e.target.value;
        if (styleKey === "satellite") {
          this.mapStyle = CONFIG.MAPBOX.SATELLITE_STYLE;
        } else if (styleKey === "nav_night") {
          this.mapStyle = CONFIG.MAPBOX.NAV_NIGHT_STYLE;
        } else {
          this.mapStyle = CONFIG.MAPBOX.DEFAULT_STYLE;
        }
        if (this.mapbox) {
          this.mapbox.setStyle(this.mapStyle);
        }
      });
    }

    // Offline Tile Pack Modal Buttons
    const btnOpenOfflineModal = document.getElementById("btn-open-offline-modal");
    const btnCloseOfflineModal = document.getElementById("btn-close-offline-modal");
    const btnDoneOfflineModal = document.getElementById("btn-done-offline-modal");
    const modalOffline = document.getElementById("modal-offline-tiles");

    if (btnOpenOfflineModal && modalOffline) {
      btnOpenOfflineModal.addEventListener("click", () => {
        modalOffline.classList.add("show");
      });
    }
    const closeOffline = () => modalOffline && modalOffline.classList.remove("show");
    if (btnCloseOfflineModal) btnCloseOfflineModal.addEventListener("click", closeOffline);
    if (btnDoneOfflineModal) btnDoneOfflineModal.addEventListener("click", closeOffline);

    // Simulated Tile Download Action
    const btnReDownloadTiles = document.getElementById("btn-re-download-tiles");
    if (btnReDownloadTiles) {
      btnReDownloadTiles.addEventListener("click", () => {
        this.simulateTileDownload();
      });
    }

    // Time Control Buttons
    const btnPlay = document.getElementById("btn-play-pause");
    if (btnPlay) {
      btnPlay.addEventListener("click", () => {
        this.sim.isPaused = !this.sim.isPaused;
        btnPlay.innerHTML = this.sim.isPaused ? "▶ Resume" : "⏸ Pause";
      });
    }

    const btnStep = document.getElementById("btn-step");
    if (btnStep) {
      btnStep.addEventListener("click", () => {
        this.sim.isPaused = true;
        if (btnPlay) btnPlay.innerHTML = "▶ Resume";
        this.sim.tick(0.2);
      });
    }

    const speedSelect = document.getElementById("select-speed");
    if (speedSelect) {
      speedSelect.addEventListener("change", (e) => {
        this.sim.timeScale = parseFloat(e.target.value);
      });
    }

    // Protocol Mode Switch: AGOS vs Baseline
    const toggleAgos = document.getElementById("toggle-agos-mode");
    if (toggleAgos) {
      toggleAgos.addEventListener("change", (e) => {
        this.sim.isAgosMode = e.target.checked;
        const label = document.getElementById("lbl-routing-mode");
        if (label) {
          label.textContent = this.sim.isAgosMode ? "AGOS Mesh" : "Baseline AODV";
          label.className = this.sim.isAgosMode ? "mode-label agos" : "mode-label";
        }
      });
    }

    // Scenario Presets
    const selectPreset = document.getElementById("select-scenario");
    if (selectPreset) {
      selectPreset.addEventListener("change", (e) => {
        this.sim.loadScenario(e.target.value);
        this.renderNodeDrawer();
      });
    }

    // Fault Injections
    const btnFaultKill = document.getElementById("btn-fault-kill");
    if (btnFaultKill) {
      btnFaultKill.addEventListener("click", () => {
        this.sim.injectFault("kill_node");
        this.renderNodeDrawer();
      });
    }

    const btnFaultJam = document.getElementById("btn-fault-jam");
    if (btnFaultJam) {
      btnFaultJam.addEventListener("click", () => {
        this.sim.injectFault("jam_channel");
        btnFaultJam.style.background = this.sim.env.channelJammed ? "#ff3366" : "";
      });
    }

    const btnFaultWave = document.getElementById("btn-fault-wave");
    if (btnFaultWave) {
      btnFaultWave.addEventListener("click", () => {
        this.sim.injectFault("rogue_wave");
      });
    }

    const btnFaultGps = document.getElementById("btn-fault-gps");
    if (btnFaultGps) {
      btnFaultGps.addEventListener("click", () => {
        this.sim.injectFault("gps_blackout");
      });
    }

    // Audio Mute Toggle
    const btnMute = document.getElementById("btn-sound-mute");
    if (btnMute) {
      btnMute.addEventListener("click", () => {
        const isMuted = sfx.toggleMute();
        btnMute.textContent = isMuted ? "🔇" : "🔊";
      });
    }

    // CSV Export
    const btnExport = document.getElementById("btn-export-csv");
    if (btnExport) {
      btnExport.addEventListener("click", () => {
        const csvContent = this.sim.exportCsv();
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `AGOS_Evaluation_Metrics_${Math.round(this.sim.simTime)}s.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      });
    }

    // Map Zoom Controls
    const btnZoomIn = document.getElementById("btn-zoom-in");
    const btnZoomOut = document.getElementById("btn-zoom-out");
    const btnResetView = document.getElementById("btn-reset-view");

    if (btnZoomIn) {
      btnZoomIn.addEventListener("click", () => {
        if (this.mapbox) this.mapbox.zoomIn();
        else this.zoom = Math.min(2.5, this.zoom * 1.25);
      });
    }

    if (btnZoomOut) {
      btnZoomOut.addEventListener("click", () => {
        if (this.mapbox) this.mapbox.zoomOut();
        else this.zoom = Math.max(0.15, this.zoom * 0.8);
      });
    }

    if (btnResetView) {
      btnResetView.addEventListener("click", () => {
        if (this.mapbox) {
          this.mapbox.flyTo({
            center: [CONFIG.GEO_ORIGIN.lon, CONFIG.GEO_ORIGIN.lat],
            zoom: 13.5,
            pitch: 20,
            bearing: -10
          });
        } else {
          this.zoom = 0.55;
          this.panX = this.mapCanvas.width / 2;
          this.panY = this.mapCanvas.height / 2 + 60;
        }
      });
    }
  }

  setGatewayMode(mode) {
    this.gatewayMode = mode;
    const overlayGw = document.getElementById("overlay-gw-mode");
    if (overlayGw) {
      overlayGw.textContent = mode === CONFIG.GATEWAY_MODES.STANDALONE_OLED
        ? "📟 Standalone OLED GW"
        : "📱 Mobile Host App (BLE)";
    }
  }

  simulateTileDownload() {
    const bar = document.getElementById("tile-download-bar");
    const text = document.getElementById("tile-download-text");
    const pct = document.getElementById("tile-download-pct");

    let progress = 0;
    const interval = setInterval(() => {
      progress += 20;
      if (bar) bar.style.width = `${progress}%`;
      if (pct) pct.textContent = `${progress}%`;
      if (text) text.textContent = `${Math.round((progress / 100) * 1420)} / 1,420 Tiles Cached`;

      if (progress >= 100) {
        clearInterval(interval);
      }
    }, 250);
  }

  screenToWorld(sx, sy) {
    if (this.mapbox && this.mapboxLoaded) {
      const lngLat = this.mapbox.unproject([sx, sy]);
      return latLonToMeters(lngLat.lat, lngLat.lng);
    }
    return {
      x: (sx - this.panX) / this.zoom,
      y: -(sy - this.panY) / this.zoom
    };
  }

  worldToScreen(wx, wy) {
    if (this.mapbox && this.mapboxLoaded) {
      const coords = metersToLatLon(wx, wy);
      const pt = this.mapbox.project([coords.lon, coords.lat]);
      return { x: pt.x, y: pt.y };
    }
    return {
      x: this.panX + wx * this.zoom,
      y: this.panY - wy * this.zoom
    };
  }

  /**
   * Main Render Loop
   */
  render() {
    this.wavePhase += 0.02;
    this.radarSweepAngle = (this.radarSweepAngle + 0.04) % (Math.PI * 2);

    // Update Header HUD
    this.renderHeaderHud();

    // Render Active Tab
    if (this.activeTab === "tactical_map") {
      this.renderTacticalMap();
      this.renderPriorityAlerts();
      this.renderNodeDrawer();
      this.renderLastMileRadar();
    } else if (this.activeTab === "mesh_graph") {
      this.renderMeshTopology();
    } else if (this.activeTab === "hardware_view") {
      this.renderHardwareSchematic();
    } else if (this.activeTab === "metrics_view") {
      this.renderMetricsAnalytics();
    }

    // Render Master Gateway OLED Mock
    if (this.oledCtx) {
      this.sim.gateway.renderOled(this.oledCtx, this.sim.simTime);
    }
  }

  renderHeaderHud() {
    const timeEl = document.getElementById("hud-sim-time");
    if (timeEl) timeEl.textContent = formatTime(this.sim.simTime);

    const activeNodes = this.sim.nodes.filter(n => n.mode === NODE_MODES.ACTIVE).length;
    const critNodes = this.sim.nodes.filter(n => n.mode === NODE_MODES.ACTIVE && n.tier === TIERS.CRITICAL).length;

    const nodesEl = document.getElementById("hud-active-nodes");
    if (nodesEl) nodesEl.textContent = `${activeNodes}/${this.sim.nodes.length}`;

    const critEl = document.getElementById("hud-crit-count");
    if (critEl) critEl.textContent = critNodes;

    const seaEl = document.getElementById("hud-sea-state");
    if (seaEl) seaEl.textContent = `B${this.sim.env.seaState}`;

    const pdrTotal = this.sim.metrics.packetsGenerated.total > 0
      ? ((this.sim.metrics.packetsDelivered.total / this.sim.metrics.packetsGenerated.total) * 100).toFixed(1)
      : "100.0";
    const pdrEl = document.getElementById("hud-pdr");
    if (pdrEl) pdrEl.textContent = `${pdrTotal}%`;
  }

  /**
   * Render Tactical Sea Map Canvas
   */
  renderTacticalMap() {
    const ctx = this.mapCtx;
    if (!ctx) return;

    ctx.clearRect(0, 0, this.mapCanvas.width, this.mapCanvas.height);

    // If Mapbox is not loaded, draw fallback ocean grid
    if (!this.mapbox || !this.mapboxLoaded) {
      ctx.fillStyle = "#071224";
      ctx.fillRect(0, 0, this.mapCanvas.width, this.mapCanvas.height);

      ctx.strokeStyle = "rgba(0, 150, 255, 0.05)";
      ctx.lineWidth = 1;
      for (let wy = -1500; wy <= 2000; wy += 80) {
        const p1 = this.worldToScreen(-2000, wy);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        for (let wx = -2000; wx <= 2000; wx += 100) {
          const pt = this.worldToScreen(wx, wy + Math.sin(wx * 0.005 + this.wavePhase + wy * 0.002) * 12);
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();
      }
    }

    // 1. Gateway Range Rings
    const gwPos = this.worldToScreen(this.sim.gateway.x, this.sim.gateway.y);
    const ringRadii = [400, 800, 1200];
    ctx.strokeStyle = "rgba(0, 240, 255, 0.15)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (const r of ringRadii) {
      const edgePt = this.worldToScreen(this.sim.gateway.x + r, this.sim.gateway.y);
      const screenRadius = Math.max(1, Math.hypot(edgePt.x - gwPos.x, edgePt.y - gwPos.y));
      if (Number.isFinite(gwPos.x) && Number.isFinite(gwPos.y) && Number.isFinite(screenRadius) && screenRadius > 0) {
        ctx.beginPath();
        ctx.arc(gwPos.x, gwPos.y, screenRadius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = "rgba(0, 240, 255, 0.4)";
        ctx.font = "9px 'JetBrains Mono', monospace";
        ctx.fillText(`${r}m`, gwPos.x + 6, gwPos.y - screenRadius - 2);
      }
    }
    ctx.setLineDash([]);

    // 2. Mesh Routing Links with Multi-Hop Indicators & Stream Flow
    for (const node of this.sim.nodes) {
      if (node.mode !== NODE_MODES.ACTIVE) continue;
      const route = node.routes.get(0);
      if (!route) continue;

      let targetPos = null;
      let isRelayHop = false;
      let nextNode = null;

      if (route.nextHop === 0) {
        targetPos = gwPos;
      } else {
        nextNode = this.sim.nodes.find(n => n.id === route.nextHop);
        if (nextNode) {
          targetPos = this.worldToScreen(nextNode.x, nextNode.y);
          isRelayHop = true;
        }
      }

      if (targetPos) {
        const nodePos = this.worldToScreen(node.x, node.y);
        ctx.save();

        if (isRelayHop) {
          // Multi-hop relay link (Orange/Amber with animated dash flow)
          ctx.strokeStyle = "#f59e0b";
          ctx.lineWidth = 2.5;
          ctx.setLineDash([8, 5]);
          ctx.lineDashOffset = -this.sim.simTime * 25;
          ctx.beginPath();
          ctx.moveTo(nodePos.x, nodePos.y);
          ctx.lineTo(targetPos.x, targetPos.y);
          ctx.stroke();
          ctx.setLineDash([]);

          // Hop Label badge at midpoint
          const midX = (nodePos.x + targetPos.x) / 2;
          const midY = (nodePos.y + targetPos.y) / 2;
          const badgeText = `Hop ${route.hops} ➔ #${route.nextHop}`;
          ctx.font = "bold 9px 'JetBrains Mono', monospace";
          const tw = ctx.measureText(badgeText).width;
          ctx.fillStyle = "rgba(10, 22, 40, 0.9)";
          ctx.strokeStyle = "#f59e0b";
          ctx.lineWidth = 1;
          ctx.fillRect(midX - tw / 2 - 4, midY - 8, tw + 8, 16);
          ctx.strokeRect(midX - tw / 2 - 4, midY - 8, tw + 8, 16);
          ctx.fillStyle = "#f59e0b";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(badgeText, midX, midY);
        } else {
          // Direct 1-Hop to Gateway (Cyan line)
          ctx.strokeStyle = "rgba(0, 240, 255, 0.65)";
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.lineDashOffset = -this.sim.simTime * 15;
          ctx.beginPath();
          ctx.moveTo(nodePos.x, nodePos.y);
          ctx.lineTo(targetPos.x, targetPos.y);
          ctx.stroke();
          ctx.setLineDash([]);

          const midX = (nodePos.x + targetPos.x) / 2;
          const midY = (nodePos.y + targetPos.y) / 2;
          ctx.font = "bold 8px 'JetBrains Mono', monospace";
          ctx.fillStyle = "rgba(0, 240, 255, 0.8)";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("Direct (Hop 1)", midX, midY);
        }

        ctx.restore();
      }
    }

    // 3. In-Flight Wireless Packets Animation
    for (const flight of this.sim.inFlightPackets) {
      const p1 = this.worldToScreen(flight.sender.x, flight.sender.y);
      const p2 = this.worldToScreen(flight.receiver.x, flight.receiver.y);

      const curX = p1.x + (p2.x - p1.x) * flight.progress;
      const curY = p1.y + (p2.y - p1.y) * flight.progress;

      ctx.fillStyle = flight.packet.prio === TIERS.CRITICAL ? "#ff3366" : (flight.packet.prio === TIERS.WARNING ? "#f59e0b" : "#00f0ff");
      ctx.beginPath();
      ctx.arc(curX, curY, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(curX, curY, 7, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 4. Survivor Nodes
    for (const node of this.sim.nodes) {
      this.drawSurvivorNode(ctx, node);
    }

    // 5. Master Gateway (SAR Vessel)
    this.drawMasterGateway(ctx, gwPos);
  }

  drawSurvivorNode(ctx, node) {
    const pos = this.worldToScreen(node.x, node.y);
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    const isSelected = node.id === this.sim.selectedNodeId;
    const isDormant = node.mode === NODE_MODES.DORMANT;

    // Breadcrumb drift trail
    if (node.positionHistory.length > 1) {
      ctx.strokeStyle = "rgba(56, 189, 248, 0.2)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < node.positionHistory.length; i++) {
        const hp = this.worldToScreen(node.positionHistory[i].x, node.positionHistory[i].y);
        if (i === 0) ctx.moveTo(hp.x, hp.y);
        else ctx.lineTo(hp.x, hp.y);
      }
      ctx.stroke();
    }

    let tierColor = "#10b981"; // Stable (Green)
    if (isDormant) {
      tierColor = "#64748b";
    } else if (node.tier === TIERS.CRITICAL) {
      tierColor = "#ff3366";
    } else if (node.tier === TIERS.WARNING) {
      tierColor = "#f59e0b";
    }

    // Antenna dunk ripple
    if (node.isAntennaSubmerged) {
      ctx.strokeStyle = "rgba(56, 189, 248, 0.8)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 16, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Selection ring
    if (isSelected) {
      ctx.strokeStyle = "#00f0ff";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 16, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Node body
    ctx.fillStyle = tierColor;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 9, 0, Math.PI * 2);
    ctx.fill();

    // Node number
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 9px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${node.id}`, pos.x, pos.y);

    // Battery small bar below
    const barW = 14;
    const barH = 2.5;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(pos.x - barW / 2, pos.y + 12, barW, barH);
    ctx.fillStyle = node.batteryPct < 20 ? "#ff3366" : (node.batteryPct < 40 ? "#f59e0b" : "#10b981");
    ctx.fillRect(pos.x - barW / 2, pos.y + 12, barW * (node.batteryPct / 100), barH);

    // SOS badge
    if (node.sosPressed) {
      ctx.fillStyle = "#ff3366";
      ctx.font = "bold 8px 'Inter', sans-serif";
      ctx.fillText("SOS", pos.x, pos.y - 13);
    }
  }

  drawMasterGateway(ctx, gwPos) {
    if (!Number.isFinite(gwPos.x) || !Number.isFinite(gwPos.y)) return;
    ctx.save();
    ctx.fillStyle = "#00f0ff";
    ctx.shadowColor = "#00f0ff";
    ctx.shadowBlur = 12;

    const boatLen = 22;
    const boatWid = 11;

    // Boat shape
    ctx.beginPath();
    ctx.moveTo(gwPos.x, gwPos.y - boatLen);
    ctx.lineTo(gwPos.x + boatWid, gwPos.y + boatLen * 0.4);
    ctx.lineTo(gwPos.x - boatWid, gwPos.y + boatLen * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Drag hint ring around gateway
    ctx.strokeStyle = "rgba(0, 240, 255, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(gwPos.x, gwPos.y, 22, 0, Math.PI * 2);
    ctx.stroke();

    // Vessel Label
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 10px 'Inter', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("SAR GATEWAY (GW-0)", gwPos.x, gwPos.y + boatLen + 6);
  }

  /**
   * Render Priority Alert List
   */
  renderPriorityAlerts() {
    const container = document.getElementById("priority-alerts-container");
    if (!container) return;

    const rankedNodes = this.sim.gateway.getRankedAlerts(this.sim.simTime);
    if (rankedNodes.length === 0) {
      container.innerHTML = `<div class="empty-hint">Waiting for survivor reports. Nodes transmit periodically (~1.5 min) to conserve power.</div>`;
      return;
    }

    let html = "";
    for (const record of rankedNodes) {
      const isCrit = record.tier === TIERS.CRITICAL;
      const isWarn = record.tier === TIERS.WARNING;
      const tierName = isCrit ? "CRITICAL" : (isWarn ? "WARNING" : "STABLE");
      const isSelected = record.id === this.sim.selectedNodeId;

      html += `
        <div class="alert-card ${isSelected ? 'selected' : ''}" onclick="window.agosSimUI.selectNode(${record.id})">
          <span class="alert-badge badge-${tierName}">${tierName}</span>
          <span class="alert-id">SURVIVOR #${record.id.toString().padStart(2, '0')}</span>
          ${record.sos ? '<span style="color:#ff3366;font-weight:700;margin-left:4px">· SOS</span>' : ''}
          ${record.isLost ? '<span style="color:#f59e0b;font-weight:700;margin-left:4px">· LOST</span>' : ''}
          <div class="alert-rule">${record.ruleFired}</div>
          <div class="alert-meta">
            <span>📍 ${record.lat.toFixed(4)}°, ${record.lon.toFixed(4)}°</span>
            <span>🔋 ${record.battery}%</span>
            <span>🔗 Hops: ${record.hops}</span>
            <span>⏱ ${record.ageSeconds ? record.ageSeconds.toFixed(0) : '0'}s ago</span>
          </div>
        </div>
      `;
    }

    container.innerHTML = html;
  }

  /**
   * Render Selected Node Detail Drawer
   */
  renderNodeDrawer() {
    const drawer = document.getElementById("node-detail-drawer");
    const drawerTitle = document.getElementById("drawer-title");
    if (!drawer) return;

    const node = this.sim.nodes.find(n => n.id === this.sim.selectedNodeId);
    if (!node) {
      if (drawerTitle) drawerTitle.textContent = "Select a node";
      drawer.innerHTML = `<div class="empty-hint">Click any survivor node or the SAR vessel on the map to inspect live telemetry.</div>`;
      return;
    }

    if (drawerTitle) drawerTitle.textContent = `Survivor #${node.id.toString().padStart(2, '0')}`;

    const totalMahDrained = node.energyUsedMah.esp32 + node.energyUsedMah.loraTx + node.energyUsedMah.loraRx + node.energyUsedMah.gps + node.energyUsedMah.mpu6050;
    const hoursElapsed = Math.max(0.01, this.sim.simTime / 3600);
    const avgDrainPerHour = totalMahDrained / hoursElapsed;
    const estRuntimeHours = avgDrainPerHour > 0 ? (node.batteryMah / avgDrainPerHour) : 80;
    const passes72h = estRuntimeHours >= 72;

    const route = node.routes.get(0);
    let hopChain = "";
    if (route) {
      if (route.nextHop === 0) {
        hopChain = `<span style="color:#00f0ff;font-weight:700">DIRECT LINK (1-HOP)</span><br>Node #${node.id} ➔ Master Gateway (GW-0) <span style="color:#64748b">(SF${route.sf})</span>`;
      } else {
        hopChain = `<span style="color:#f59e0b;font-weight:700">MULTI-HOP MESH RELAY (${route.hops} HOPS)</span><br>Node #${node.id} ➔ <strong>Relay #${route.nextHop}</strong> ➔ Gateway <span style="color:#f59e0b">(SF${route.sf})</span>`;
      }
    } else {
      hopChain = `<span style="color:#ff3366;font-weight:700">OUT OF RANGE</span><br><span style="color:#94a3b8">Beyond 850m GW range & no relay in 650m</span>`;
    }

    const tierName = node.tier === 2 ? 'CRITICAL' : (node.tier === 1 ? 'WARNING' : 'STABLE');

    // Interval display: 90s (~1.5 min)
    let reportIntervalText = "90 s (1.5 min) — Power Saving";
    if (node.tier === TIERS.CRITICAL) reportIntervalText = "15 s (Critical Escalation)";
    else if (node.tier === TIERS.WARNING) reportIntervalText = "45 s (Warning State)";

    drawer.innerHTML = `
      <div style="text-align:center;margin-bottom:8px">
        <span class="status-pill pill-${tierName}">${tierName}</span>
      </div>

      <div class="detail-section">
        <div class="detail-section-title sec-status">STATUS & RULE CLASSIFICATION</div>
        <div class="detail-row"><span class="detail-key">Fired Rule</span><span class="detail-val" style="font-size:10px">${node.ruleFired}</span></div>
        <div class="detail-row"><span class="detail-key">Report Cycle</span><span class="detail-val val-ok">${reportIntervalText}</span></div>
        <div class="detail-row"><span class="detail-key">Next Report</span><span class="detail-val">in ${Math.max(0, node.nextReportTimer).toFixed(1)} s</span></div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title sec-immersion">IMMERSION CONTACT PROBES (§6.1)</div>
        <div class="detail-row"><span class="detail-key">Wet State</span><span class="detail-val ${node.instantWet ? 'val-wet' : ''}">${node.instantWet ? 'WET (Submerged)' : 'DRY'}</span></div>
        <div class="detail-row"><span class="detail-key">Continuous Wet</span><span class="detail-val">${node.continuousWetTime.toFixed(1)} s / 2.0 s</span></div>
        <div class="detail-row"><span class="detail-key">Antenna Dunk</span><span class="detail-val">${node.isAntennaSubmerged ? 'SUBMERGED (Wave)' : 'Clear (Above water)'}</span></div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title sec-motion">MPU6050 MOTION INDEX (§7.1)</div>
        <div class="detail-row"><span class="detail-key">Motion Class</span><span class="detail-val val-active">${node.motionClass}</span></div>
        <div class="detail-row"><span class="detail-key">Motion Index</span><span class="detail-val">${node.motionIndex} / 100</span></div>
        <div class="detail-row"><span class="detail-key">Still Time</span><span class="detail-val">${node.stillDuration.toFixed(0)} s</span></div>
        <div class="detail-row"><span class="detail-key">Accel / Gyro</span><span class="detail-val">${node.accelDev.toFixed(3)}g · ${node.gyroMag.toFixed(1)}°/s</span></div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title sec-gps">u-blox NEO-M8N GPS (§6.3)</div>
        <div class="detail-row"><span class="detail-key">Fix Status</span><span class="detail-val val-ok">${node.gpsFixed ? 'FIXED 3D' : 'ACQUIRING'}</span></div>
        <div class="detail-row"><span class="detail-key">Coordinates</span><span class="detail-val">${node.gpsLat.toFixed(5)}°, ${node.gpsLon.toFixed(5)}°</span></div>
        <div class="detail-row"><span class="detail-key">Satellites</span><span class="detail-val">${node.satellites} sats (HDOP ${node.hdop})</span></div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title sec-power">POWER & 72-HOUR RUNTIME (§12)</div>
        <div class="power-bar-wrap">
          <div class="power-bar-fill" style="width:${node.batteryPct}%"></div>
        </div>
        <div class="detail-row"><span class="detail-key">Battery</span><span class="detail-val">${node.batteryPct.toFixed(1)}% (${node.batteryMah.toFixed(0)} mAh)</span></div>
        <div class="detail-row"><span class="detail-key">Est. Runtime</span><span class="detail-val">${estRuntimeHours.toFixed(1)} hrs</span></div>
        <div class="detail-row"><span class="detail-key">72h Target</span><span class="detail-val ${passes72h ? 'val-ok' : 'val-crit'}">${passes72h ? 'PASS (≥72h)' : 'FAIL (<72h)'}</span></div>
        <div class="detail-row"><span class="detail-key">Solar Harvest</span><span class="detail-val">+${node.energyUsedMah.solarHarvested.toFixed(1)} mAh</span></div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title sec-mesh">RESCUE WEB MESH ROUTING (§9)</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:10px;line-height:1.4;padding:4px 0">${hopChain}</div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title" style="color:#cbd5e1">INTERACTIVE TRIGGERS</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:4px">
          <button class="btn-sm btn-primary" style="grid-column:1/-1;font-weight:700" onclick="window.agosSimUI.sendImmediatePacket(${node.id})">
            📡 Transmit Packet Now (Watch Hop)
          </button>
          <button class="btn-sm ${node.sosPressed ? 'btn-danger' : ''}" style="grid-column:1/-1" onclick="window.agosSimUI.toggleSos(${node.id})">
            ${node.sosPressed ? 'Release SOS' : '🚨 Trigger SOS'}
          </button>
          <button class="btn-sm" onclick="window.agosSimUI.setScript(${node.id}, 'unresponsive')">🧊 Force Still</button>
          <button class="btn-sm" onclick="window.agosSimUI.setScript(${node.id}, 'struggling')">🌊 Struggling</button>
          <button class="btn-sm" onclick="window.agosSimUI.setScript(${node.id}, 'calm_floating')">🏊 Floating</button>
          <button class="btn-sm" onclick="window.agosSimUI.setScript(${node.id}, 'battery_drain_fast')">⚡ Fast Drain</button>
        </div>
      </div>
    `;
  }

  /**
   * Rescuer Last-Mile Tactical Radar View
   */
  renderLastMileRadar() {
    const ctx = this.radarCtx;
    if (!ctx) return;

    ctx.clearRect(0, 0, 120, 120);
    const cx = 60;
    const cy = 60;
    const maxR = 52;

    ctx.fillStyle = "#030c1c";
    ctx.beginPath();
    ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(0, 240, 255, 0.2)";
    ctx.lineWidth = 1;
    [0.33, 0.66, 1.0].forEach(frac => {
      ctx.beginPath();
      ctx.arc(cx, cy, maxR * frac, 0, Math.PI * 2);
      ctx.stroke();
    });

    ctx.beginPath();
    ctx.moveTo(cx, cy - maxR);
    ctx.lineTo(cx, cy + maxR);
    ctx.moveTo(cx - maxR, cy);
    ctx.lineTo(cx + maxR, cy);
    ctx.stroke();

    // Radar sweep
    ctx.strokeStyle = "rgba(0, 240, 255, 0.6)";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(this.radarSweepAngle) * maxR, cy + Math.sin(this.radarSweepAngle) * maxR);
    ctx.stroke();

    const targetNode = this.sim.nodes.find(n => n.id === this.sim.selectedNodeId);
    if (targetNode) {
      const dx = targetNode.x - this.sim.gateway.x;
      const dy = targetNode.y - this.sim.gateway.y;
      const dist = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);

      const radarDist = Math.min(maxR - 4, (dist / 1000) * maxR);
      const targetPx = cx + Math.cos(angle) * radarDist;
      const targetPy = cy - Math.sin(angle) * radarDist;

      ctx.fillStyle = targetNode.tier === TIERS.CRITICAL ? "#ff3366" : "#10b981";
      ctx.beginPath();
      ctx.arc(targetPx, targetPy, 3.5, 0, Math.PI * 2);
      ctx.fill();

      const bearing = Math.round(((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360);
      const radarInfo = document.getElementById("radar-target-info");
      if (radarInfo) {
        radarInfo.innerHTML = `<strong>#${targetNode.id}</strong> · ${Math.round(dist)}m · ${bearing}°`;
      }
    }
  }

  /**
   * Render Network Graph Topology
   */
  renderMeshTopology() {
    const canvas = document.getElementById("mesh-topology-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#071224";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#00f0ff";
    ctx.font = "bold 13px 'Inter', sans-serif";
    ctx.fillText("RESCUE WEB — MULTI-HOP CONVERGECAST ROUTING", 20, 28);

    const levels = { 0: [this.sim.gateway], 1: [], 2: [], 3: [], 4: [] };

    for (const node of this.sim.nodes) {
      if (node.mode !== NODE_MODES.ACTIVE) continue;
      const route = node.routes.get(0);
      const hops = route ? Math.min(4, route.hops) : 4;
      if (levels[hops]) levels[hops].push(node);
    }

    const levelHeights = [70, 160, 250, 340, 420];
    const nodePositions = new Map();

    for (const [lvl, list] of Object.entries(levels)) {
      const y = levelHeights[lvl];
      const count = list.length;
      for (let i = 0; i < count; i++) {
        const x = (canvas.width / (count + 1)) * (i + 1);
        nodePositions.set(list[i].id, { x, y });
      }
    }

    // Links
    for (const node of this.sim.nodes) {
      if (node.mode !== NODE_MODES.ACTIVE) continue;
      const route = node.routes.get(0);
      if (!route) continue;

      const p1 = nodePositions.get(node.id);
      const p2 = nodePositions.get(route.nextHop);

      if (p1 && p2) {
        ctx.strokeStyle = "rgba(0, 240, 255, 0.45)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();

        ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
        ctx.font = "9px 'JetBrains Mono', monospace";
        ctx.fillText(`SF${route.sf}`, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
      }
    }

    // Nodes
    for (const [id, pos] of nodePositions.entries()) {
      ctx.fillStyle = id === 0 ? "#00f0ff" : "#10b981";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 13, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#000000";
      ctx.font = "bold 9px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(id === 0 ? "GW" : `${id}`, pos.x, pos.y);
    }
  }

  /**
   * Render Hardware Prototype Visual Activity LEDs
   */
  renderHardwareSchematic() {
    const node = this.sim.nodes.find(n => n.id === this.sim.selectedNodeId) || this.sim.nodes[0];
    if (!node) return;

    const setLed = (id, active, activeColor = "#00f0ff") => {
      const el = document.getElementById(id);
      if (el) {
        el.setAttribute("fill", active ? activeColor : "#1e293b");
        el.setAttribute("opacity", active ? "1" : "0.3");
      }
    };

    setLed("hw-led-spi-vis", node.busActivity.spi, "#f59e0b");
    setLed("hw-led-i2c-vis", node.busActivity.i2c, "#a78bfa");
    setLed("hw-led-uart-vis", node.busActivity.uart, "#10b981");
    setLed("hw-led-pulse-vis", node.busActivity.immersionPulse, "#38bdf8");
    setLed("hw-led-status-vis", node.mode === NODE_MODES.ACTIVE, "#10b981");
  }

  /**
   * Render Analytics & Confusion Matrix
   */
  renderMetricsAnalytics() {
    const cm = this.sim.metrics.confusionMatrix;
    const tableEl = document.getElementById("confusion-matrix-body");
    if (tableEl) {
      tableEl.innerHTML = `
        <tr><td><strong>Stable</strong></td><td>${cm[0][0]}</td><td>${cm[0][1]}</td><td>${cm[0][2]}</td></tr>
        <tr><td><strong>Warning</strong></td><td>${cm[1][0]}</td><td>${cm[1][1]}</td><td>${cm[1][2]}</td></tr>
        <tr><td><strong>Critical</strong></td><td>${cm[2][0]}</td><td>${cm[2][1]}</td><td>${cm[2][2]}</td></tr>
      `;
    }

    const critLats = this.sim.metrics.latencies[TIERS.CRITICAL];
    const meanCrit = critLats.length > 0 ? (critLats.reduce((a, b) => a + b, 0) / critLats.length).toFixed(2) : "0.00";
    const elCritLat = document.getElementById("stat-crit-latency");
    if (elCritLat) elCritLat.textContent = `${meanCrit} s`;

    const elCollisions = document.getElementById("stat-collisions");
    if (elCollisions) elCollisions.textContent = this.sim.metrics.collisionsCount;

    const elRerr = document.getElementById("stat-rerr");
    if (elRerr) elRerr.textContent = this.sim.metrics.rerrCount;
  }

  selectNode(nodeId) {
    this.sim.selectedNodeId = nodeId;
    const node = this.sim.nodes.find(n => n.id === nodeId);
    if (node) {
      if (this.mapbox) {
        this.mapbox.flyTo({
          center: [node.gpsLon, node.gpsLat],
          zoom: 14.5,
          speed: 1.2
        });
      } else {
        this.panX = this.mapCanvas.width / 2 - node.x * this.zoom;
        this.panY = this.mapCanvas.height / 2 + node.y * this.zoom;
      }
    }
    this.renderNodeDrawer();
  }

  toggleSos(nodeId) {
    const node = this.sim.nodes.find(n => n.id === nodeId);
    if (node) {
      if (node.sosPressed) node.resetSos();
      else node.triggerSos();
      this.renderNodeDrawer();
    }
  }

  setScript(nodeId, scriptName) {
    const node = this.sim.nodes.find(n => n.id === nodeId);
    if (node) {
      node.setScript(scriptName);
      this.renderNodeDrawer();
    }
  }

  sendImmediatePacket(nodeId) {
    const node = this.sim.nodes.find(n => n.id === nodeId);
    if (node) {
      if (node.mode !== NODE_MODES.ACTIVE) {
        node.mode = NODE_MODES.ACTIVE;
      }
      node.queueOwnStatusPacket(this.sim.simTime, false, this.sim.radio);
      sfx.playLoraChirp();
      this.renderNodeDrawer();
    }
  }
}
