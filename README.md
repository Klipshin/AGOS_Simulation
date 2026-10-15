# 🛟 AGOS — Autonomous Geolocation for Open-Sea Survival

> **Team Pillagers · BS CpE 4-H2**  
> **Adviser:** Engr. Julian N. Semblante  
> *Motion-based status is a proxy signal, not a medical diagnosis.*

---

## 🌊 Overview

**AGOS** is a specialized open-sea emergency geolocation and rescue coordination simulation designed for maritime dead-zones where cellular and internet connectivity are unavailable.

The simulation models:
- **LoRa Mesh Ad-Hoc Networking**: Multi-hop modified AODV routing with SNR-based cost metrics, adaptive Spreading Factors (SF7–SF12), and battery constraints.
- **Node Biomechanics & Marine Physics**: 3 survivor nodes subject to ocean current drift, wind leeway, wave immersion, and 6-axis IMU proxy status classification (Active, Tread, Exhaustion, Hypothermia, Unresponsive) with 30s de-escalation hysteresis.
- **Dual Gateway Architecture**:
  1. **Option 1 (Standalone Hardware Box)**: Autonomous ESP32 gateway with 0.96" 128×64 SSD1306 OLED display, status LEDs, and audible piezobuzzer alarm.
  2. **Option 2 (Mobile Companion)**: Rescuer companion interface connected via BLE / USB to the gateway hardware.
- **Dead-Zone Offline Tile Cache**: Simulated tile pre-caching for Philippine maritime corridors (Camotes Sea, Guimaras Strait, Cebu Strait).
- **Tactical Mapbox GIS & Local Radar Fallback**: Real-time positioning, range circles, relay links, and ocean radar fallback if offline.

---

## 🚀 Quick Start

### 1. Configure Environment Variables

Mapbox requires an access token for map tiles. The token is loaded securely from `.env` and kept out of version control.

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and insert your Mapbox access token:
   ```env
   MAPBOX_ACCESS_TOKEN=pk.your_actual_mapbox_token_here
   ```
   *(Get a free token at [account.mapbox.com](https://account.mapbox.com/))*

> **Note:** If no `.env` file is present or if opened without a web server, the simulation automatically falls back to an offline tactical radar grid. You can also set a token dynamically in your browser console via:
> ```js
> localStorage.setItem('MAPBOX_ACCESS_TOKEN', 'pk.your_token');
> ```

### 2. Run Locally

Because the project uses standard ES Modules (`import`/`export`), it should be served via an HTTP server rather than directly via `file://`.

Run any of the following in the project root:

**Using Python:**
```bash
python -m http.server 8000
```
Open [http://localhost:8000](http://localhost:8000)

**Using Node.js:**
```bash
npx serve .
```

**Using VS Code:**
- Install the **Live Server** extension, right-click `index.html`, and select **"Open with Live Server"**.

---

## 📁 Repository Structure

```
AGOS_Simulation/
├── .env.example              # Environment variables template
├── .gitignore                # Git exclusions (ignores .env, OS files, etc.)
├── index.html                # Main application interface and views
├── AGOS_Simulation_Context.md# Detailed simulation specifications & formulas
├── README.md                 # Project documentation
├── css/
│   └── style.css             # Tactical dark-mode UI stylesheet
└── js/
    ├── app.js                # Main application entry point & animation loop
    ├── config.js             # Simulation constants & loadEnv() dynamic loader
    ├── gateway.js            # Standalone OLED display & dual-mode gateway controller
    ├── mesh.js               # Multi-hop AODV mesh router & packet queue
    ├── node.js               # Wearable beacon node state, GPS, IMU, battery
    ├── radio.js              # LoRa propagation, Okumura-Hata maritime path loss, SNR
    ├── simulation.js         # Master simulation clock, drift physics, metric tracker
    ├── ui.js                 # Tactical Mapbox GIS, OLED renderer, tabs, HUD
    └── utils.js              # Haversine, coordinate projections, color utilities
```

---

## 🔒 Security

- The `.env` file is excluded from Git tracking via `.gitignore`.
- Never commit private API tokens or credentials into source control.

---

## 📜 License & Acknowledgments

Developed by **Team Pillagers** for BS Computer Engineering 4-H2.  
Adviser: Engr. Julian N. Semblante.
