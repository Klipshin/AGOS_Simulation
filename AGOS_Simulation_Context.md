# AGOS — HTML Simulation Context & Spec

**Project:** AGOS — Autonomous Geolocation for Open-Sea Survival
**Team:** Team Pillagers (BS Computer Engineering 4-H2) · **Adviser:** Engr. Julian N. Semblante
**Purpose of this file:** hand this to whoever (or whatever) builds the HTML simulation. It lists the components, dimensions, wiring, node/gateway behavior, mesh logic, channel model, UI, and the build tasks. It is derived from the thesis proposal plus the design decisions made since.

> **Reading guide.** Anything marked **[FIXED]** comes from the proposal or a panel/adviser requirement and must not change. Anything marked **[TUNABLE]** is a default the simulation should expose as a slider/input. Anything marked **[ASSUMED]** is my engineering estimate and should be replaced with measured data from the real prototype when available. Dimensions and current draws are **typical/approximate** — verify against your own boards and datasheets.

---

## 1. What the system is (one paragraph)

AGOS turns a passive life vest into an active, self-reporting node. Each **survivor node** (worn on the vest) wakes automatically when its seawater-immersion probes get wet, reads GPS position, motion (IMU), and battery level, fuses those with a manual SOS button into a **priority tier (Critical / Warning / Stable)**, and transmits it over LoRa. Nodes relay each other's packets vest-to-vest through a decentralized mesh called the **"Rescue Web"** until the data reaches the **Master Gateway** (on the SAR vessel), which aggregates everything and shows it to rescuers in a map-based app (Flutter in the real project; the HTML sim stands in for it). No cellular, Wi-Fi, or satellite link is used for the survivor-to-gateway path.

### 1.1 Hard constraints [FIXED]

| # | Constraint | Source |
|---|---|---|
| 1 | **No satellite IoT component anywhere.** | Panel feedback |
| 2 | **No Wi-Fi/cellular as a substitute link when testing the mesh.** Mesh results must reflect genuine dead-zone LoRa-only operation. | Panel feedback + proposal §8 |
| 3 | Every node transmits **more than GPS**: position + status (immersion, motion, battery, SOS) + priority tier. | Panel feedback |
| 4 | Communication *beyond* the Master Gateway (to a command center) is **out of scope** (assumed to use the SAR vessel's own equipment). | Proposal §4, §8 |
| 5 | Motion-based classification is a **proxy signal, not a medical diagnosis**; the UI must not imply otherwise. | Proposal §8 |
| 6 | Power target: **≥ 72 h** operation (solar + LiPo). | Proposal §6 |
| 7 | Bluetooth/Wi-Fi is allowed **only** for the last-mile link between the gateway and nearby rescuer devices (local localization), never for survivor→gateway data. | Proposal §4 |

### 1.2 What the simulation must demonstrate

1. Automatic activation on immersion (no manual action).
2. On-node fusion → Critical / Warning / Stable.
3. Multi-hop delivery through the Rescue Web with modified AODV, RSSI-based routing, adaptive spreading factor, and Critical-first forwarding.
4. A gateway dashboard: live map, per-node telemetry, priority-ranked alerts, lost-contact detection.
5. Evaluation metrics matching the proposal's evaluation plan (§15 below).

---

## 2. Architecture

```
 SURVIVOR NODE (x N)                                         MASTER GATEWAY (x1, on SAR vessel)
 ┌───────────────────────────┐   LoRa    ┌───────────┐ LoRa  ┌───────────────────────────┐
 │ immersion → activate      │◄─────────►│ other     │◄─────►│ ESP32 + LoRa + OLED       │
 │ GPS + IMU + battery + SOS │  mesh     │ survivor  │ mesh  │ aggregate / dedupe / rank │
 │ classify → tier           │  (hops)   │ nodes     │       │        │ BLE / Wi-Fi AP   │
 │ TX own packet + relay     │           │ (relays)  │       │        ▼ (last-mile only) │
 └───────────────────────────┘           └───────────┘       │ Rescuer app (Flutter)     │
                                                             │ map · telemetry · alerts  │
                                                             └───────────────────────────┘
```

Two layers only: (1) survivor-worn sensing + mesh relay, (2) Master Gateway + rescuer-facing app.

---

## 3. Components

### 3.1 Survivor node

| Ref | Component | Role | Interface / voltage | Notes |
|---|---|---|---|---|
| U1 | **ESP32 DevKit** (classic ESP32, 38-pin) | MCU: sensing, classification, mesh logic | 3.3 V logic | Not S3/C3. Dual-core, 240 MHz. |
| U2 | **LoRa transceiver — SX1278 (433 MHz)** *(ordered)* and/or **SX1276 (915 MHz)** *(also selected)* | Mesh radio | SPI, 3.3 V | Same chip family and same pinout; **band is a parameter in the sim** (see §10.1 and §17). Ra-02-style SPI breakout with spring antenna. |
| U3 | **u-blox NEO-M8N GPS** breakout *(replaces NEO-6M in the proposal)* | Position + UTC time | UART 9600 baud default (NMEA), 3.3 V logic | Multi-constellation (GPS+GLONASS+…), faster fix than NEO-6M. Wiring identical to NEO-6M. |
| U4 | **MPU6050** (GY-521) | Motion sensing (accel + gyro) | I2C `0x68` (AD0 = GND) | 6-axis. Motion index for classification. |
| U5 | **MAX17048** fuel gauge breakout | Battery % / voltage | I2C `0x36` | Reads the cell directly; replaces a raw ADC divider. |
| P1 | **Immersion probes** (2× stainless steel contacts, DIY) | Seawater-contact detection | GPIO pulsed excitation + sense | **Not** the generic "water sensor" board (corrodes). Pulsed/AC drive to limit electrolysis. |
| SW1 | **SOS button** (IP67 panel-mount, 12 mm, momentary) | Manual override | GPIO, active-low | Internal pull-up. |
| SW2 | **Power slide switch** (SPDT) | Master on/off | — | Between charger output and system rail. |
| B1 | **LiPo 3.7 V pouch, 2000–3000 mAh, with protection PCB** | Energy storage | JST-PH 2-pin | Sim default: 2500 mAh [TUNABLE]. |
| C1 | **TP4056 charge module (with protection / solar-capable)** | Charge LiPo from solar | 5 V in | Needs input/output caps; solar blocking diode (below). |
| SP1 | **Solar panel 5 V, 1–2 W** | Daytime energy offset | 5 V | Will not sustain the system alone. |
| U6 | **MT3608 boost** *(only if the ESP32 board needs 5 V on VIN)* | 3.7 V → 5 V | — | Skip if your board accepts 3.7 V directly. |
| D1 | **1N5819 Schottky** | Solar → TP4056 reverse-block | — | Skip if module already has one. |
| LED1 | Status LED *(optional, bench only)* | Debug | GPIO + 330 Ω | Remove for final enclosure. |

### 3.2 Passives (required for a real build)

| Part | Value | Where | Why |
|---|---|---|---|
| R | 1 kΩ | In series with immersion excitation pin | Limits current through water; reduces probe corrosion |
| R | 10 kΩ | Immersion sense pin → GND | Defined LOW when dry |
| R | 4.7 kΩ ×2 | I2C SDA/SCL → 3V3 | **Only if** the breakouts don't already have pull-ups (don't double up) |
| C | 100 nF ceramic | Across LoRa VCC/GND, close to module | Decoupling |
| C | 10 µF (electrolytic/tantalum) | Across LoRa VCC/GND | Bulk cap for TX current spike (prevents brown-out) |
| R | 330 Ω | Status LED series | Current limit |
| R | 10 kΩ | SOS → GND | **Not needed** if using `INPUT_PULLUP` (recommended) |

### 3.3 Master Gateway

| Ref | Component | Role |
|---|---|---|
| G1 | ESP32 DevKit (classic) | Gateway MCU |
| G2 | LoRa module (same band/config as nodes) | Mesh sink |
| G3 | 0.96″ SSD1306 OLED, I2C `0x3C` (128×64) | Local status: node count, last packet, critical count |
| G4 | USB / power bank supply | Power (no solar/battery management needed) |
| G5 | Host device running the rescuer app (Flutter) | Map, telemetry, alerts, last-mile BLE/Wi-Fi |

---

## 4. Dimensions (typical — measure your actual boards)

### 4.1 Modules

| Part | Approx. size (L × W × H) | Notes |
|---|---|---|
| ESP32 DevKit (38-pin) | ~ 55 × 28 × 13 mm | Clone boards vary ±2 mm in width |
| LoRa SX1276/78 SPI module (Ra-02 style, no devboard) | ~ 17 × 16 × 3 mm | Spring antenna adds ~ 25–50 mm length (433 MHz spring is longer than 915 MHz) |
| ESP32 + LoRa + OLED combo board (gateway/dev option) | ~ 51 × 25 × 10 mm | Only if you use the integrated board as gateway |
| NEO-M8N GPS breakout (GY-GPSV3 style) | ~ 25–30 × 35 × 8 mm | Ceramic patch antenna ~ 25 × 25 mm on top; **must face sky** |
| MPU6050 (GY-521) | ~ 21 × 16 × 3 mm | 2.54 mm headers |
| MAX17048 breakout | ~ 25 × 18 × 3 mm | Adafruit-style; clones vary |
| TP4056 module | ~ 26–28 × 17 × 4 mm | USB-C/micro-USB version |
| MT3608 boost module | ~ 36 × 17 × 14 mm | Only if used |
| LiPo pouch 2000–3000 mAh | ~ 50–60 × 34–50 × 6–10 mm | Check exact cell; e.g. 103450 ≈ 2000 mAh |
| Solar panel 5 V 1–2 W | ~ 110 × 80 mm up to ~ 135 × 110 mm | **Measure yours**; thickness ~ 3 mm |
| SOS button, panel mount | Ø 12 mm hole, ~ 25 mm behind panel | IP67 |
| Immersion probes | 2 × stainless screws/contacts, ~ 10–20 mm apart | Spacing is a **[TUNABLE]** sensitivity parameter |
| SSD1306 OLED 0.96″ | ~ 27 × 27 × 4 mm | Gateway only |

### 4.2 Enclosure & placement (proposed, [ASSUMED])

- Node enclosure: **~ 110 × 70 × 40 mm**, IP67 box, cable glands for probe leads and antenna pass-through.
- Layout intent: ESP32 + LoRa + MPU6050 + MAX17048 + TP4056 on one stack; LiPo underneath; **GPS patch facing up/sky**; antenna vertical; probes on the **lower** outer face so they are the first thing wet.
- On the vest: node on chest/shoulder, solar panel on the shoulder/top surface, SOS button on the front face (reachable with one hand), probes at the lowest point of the node housing.
- **Sim scale suggestions:** hardware/exploded view → 1 px = 0.5 mm; vest view → 1 px = 2 mm; sea map → 1 px = 1–5 m (zoomable).

---

## 5. Wiring

### 5.1 Survivor node pin map (ESP32 classic)

| ESP32 pin | Function | Connects to | Notes |
|---|---|---|---|
| GPIO18 | SPI SCK | LoRa SCK | VSPI |
| GPIO19 | SPI MISO | LoRa MISO | |
| GPIO23 | SPI MOSI | LoRa MOSI | |
| GPIO5 | SPI CS/NSS | LoRa NSS | |
| GPIO14 | LoRa RST | LoRa RST | |
| GPIO26 | LoRa DIO0 (IRQ) | LoRa DIO0 | TX-done / RX-done interrupt |
| GPIO16 (RX2) | UART2 RX | GPS **TX** | 9600 baud NMEA |
| GPIO17 (TX2) | UART2 TX | GPS **RX** | |
| GPIO21 | I2C SDA | MPU6050 SDA + MAX17048 SDA | Shared bus |
| GPIO22 | I2C SCL | MPU6050 SCL + MAX17048 SCL | Shared bus |
| GPIO27 | SOS input | SOS button → GND | `INPUT_PULLUP`, active-low |
| GPIO33 | Immersion **excite** (out) | → 1 kΩ → Probe 1 | **Pulsed**, never held HIGH |
| GPIO32 | Immersion **sense** (in) | Probe 2, plus 10 kΩ → GND | HIGH only when water bridges probes during a pulse |
| GPIO2 | Status LED *(optional)* | → 330 Ω → LED → GND | Bench only |
| GPIO4 | GPS power-gate *(optional, proposed)* | → P-MOSFET gate (high-side switch on GPS VCC) | Recommended to hit the 72 h target; **not yet in the schematic** |
| 3V3 / GND | Power | LoRa VCC, GPS VCC, MPU6050 VCC, pull-ups | LoRa gets 100 nF + 10 µF at its pins |

### 5.2 Power path

```
Solar (+) ─► [1N5819] ─► TP4056 IN+        Solar (–) ─► TP4056 IN–
TP4056 BAT+/BAT– ◄──► LiPo (JST-PH, with protection PCB)
TP4056 OUT+ ─► [SW2 power switch] ─► ESP32 VIN (or via MT3608 5 V boost if required)
TP4056 OUT– ─► GND (common)
MAX17048 VDD/GND ─► directly across the LiPo (reads the cell), I2C to shared bus
```

### 5.3 Master Gateway wiring

| ESP32 pin | Connects to |
|---|---|
| GPIO18 / 19 / 23 / 5 / 14 / 26 | LoRa SCK / MISO / MOSI / NSS / RST / DIO0 (same as node) |
| GPIO21 / 22 | SSD1306 SDA / SCL (`0x3C`) |
| USB | Power + serial to host (and/or BLE / Wi-Fi AP to the rescuer app — last-mile only) |

### 5.4 Wiring rules the sim can optionally enforce (for a "hardware view" tab)

- SPI pins shared by nothing else. I2C devices must have distinct addresses (`0x68`, `0x36`).
- Immersion excite pin must be a **pulse** (e.g., 1 ms every 250 ms, alternating polarity if driven through two pins), not DC.
- LoRa antenna must match the band (433 vs 915 MHz) — mismatch should reduce simulated link budget.

---

## 6. Survivor node behavior

### 6.1 State machine

```
        power on
           │
           ▼
      ┌─────────┐  probes wet ≥ T_wet (debounced)   ┌─────────┐
      │ DORMANT │ ─────────────────────────────────►│ ACTIVE  │
      │ (armed) │                                   │ (latched)│
      └─────────┘◄───── manual reset only ───────── └─────────┘
   radio asleep, immersion poll                  GPS + IMU + battery on,
   ~ every 250 ms                                classify, TX own + relay
```

Rules:
- **DORMANT:** radio and GPS off; ESP32 in light/deep sleep; wake every ~250 ms to pulse the probes and read the sense pin.
- **Activation:** probes read wet continuously for `T_wet` [TUNABLE, default **2 s**] → latch ACTIVE. A wave splash shorter than `T_wet` must **not** activate.
- **ACTIVE is latched:** wave-induced dry gaps do **not** deactivate the node. Only a manual reset (button hold / power cycle) returns it to DORMANT. The sim should show "immersion state" (instantaneous wet/dry) separately from "node mode" (latched).
- **SOS button** works in **any** state, including DORMANT: it wakes the node into ACTIVE and forces Critical.
- **Target activation latency** (first wet contact → first packet queued): ≤ `T_wet` + GPS/IMU warm-up. Log it (evaluation metric).

### 6.2 Periodic cycle in ACTIVE (default timings [TUNABLE])

| Tier | Own-packet interval | Notes |
|---|---|---|
| Stable | 60 s ± 10 % jitter | |
| Warning | 20 s ± 10 % jitter | |
| Critical | 5 s ± 10 % jitter | Plus immediate **burst of 3** on first entering Critical or on SOS press |

Per cycle: read IMU window → compute motion index → read fuel gauge → latest GPS fix → classify → build packet → pick route/SF → CAD/backoff → TX → return to RX/listen schedule.

### 6.3 GPS model

- Default fix error: **σ ≈ 2.5 m** (circular) [TUNABLE].
- Time-to-first-fix: cold ≈ 26 s, warm ≈ 5 s, hot ≈ 1 s [ASSUMED typical M8N; make configurable].
- Packet carries **fix age**, **satellite count**, and **HDOP**; if no fix, send **last-known position + fix age** and a "no-fix" flag (don't send fake coordinates).
- Optional: fix dropouts when the antenna is dunked/waves wash over (ties to §10.5).

---

## 7. Status classification (on-node fusion)

Inputs (the four signals from the proposal): **immersion**, **motion pattern**, **battery level**, **manual SOS**.

### 7.1 Motion classification from the IMU [TUNABLE, ASSUMED — calibrate with real MPU6050 data]

Sample accel + gyro at ~50 Hz; window ~ 2 s; `a_dev = std(|a| − 1 g)`, `g_mag = mean(|gyro|)`.

| Motion class | Condition (default) | Meaning |
|---|---|---|
| `STILL` | `a_dev < 0.03 g` and `g_mag < 5 °/s` | No voluntary movement (calm or incapacitated) |
| `FLOATING` | Low-amplitude, low-frequency (≈ 0.1–0.5 Hz) quasi-periodic motion | Normal wave motion while floating |
| `ACTIVE` | Moderate irregular motion (swimming, signalling) | Responsive survivor |
| `STRUGGLING` | `a_dev > 0.5 g` or `g_mag > 120 °/s` sustained ≥ 10 s | Possible panic/distress |

Also track `still_duration` (seconds continuously `STILL`).

### 7.2 Tier rules (evaluate top to bottom, first match wins) [TUNABLE]

| Priority | Rule | Tier |
|---|---|---|
| 1 | SOS pressed (latched until cleared/reset) | **CRITICAL** |
| 2 | Immersed **and** `still_duration ≥ 120 s` | **CRITICAL** |
| 3 | Immersed **and** battery ≤ 10 % **and** tier would otherwise be Warning | **CRITICAL** |
| 4 | Immersed **and** (`STRUGGLING` **or** `still_duration ≥ 30 s`) | **WARNING** |
| 5 | Immersed **and** battery ≤ 20 % | **WARNING** |
| 6 | Immersed, otherwise | **STABLE** |
| — | Not immersed and not SOS | *(Dormant — no tier transmitted)* |

Hysteresis: **escalation is immediate; de-escalation requires the lower condition to hold ≥ 30 s** (prevents flapping).
UI caveat string (always visible near tier chips): *"Motion-based status is a proxy signal, not a medical diagnosis."*

### 7.3 Priority tier encoding

`0 = Stable`, `1 = Warning`, `2 = Critical`. Colors: Stable = green, Warning = amber, Critical = red (and also use icon/shape, not color alone).

---

## 8. Packet format

Fields (keep the sim's byte count realistic so airtime is realistic).

| Field | Size | Description |
|---|---|---|
| `ver` | 4 bit | Protocol version |
| `type` | 4 bit | `0`=STATUS, `1`=RREQ, `2`=RREP, `3`=RERR, `4`=ACK, `5`=HELLO/beacon |
| `src` | 2 B | Originating node ID |
| `dst` | 2 B | Destination (gateway ID, or broadcast) |
| `prev` | 2 B | Previous hop (for link tracking) |
| `seq` | 2 B | Per-source message sequence (dedupe key = `src`+`seq`) |
| `ttl` / `hops` | 1 B | Hop budget / hops so far |
| `prio` | 2 bit | 0/1/2 tier |
| `flags` | 6 bit | `immersed`, `sos`, `no_fix`, `lowbat`, `struggle`, `still` |
| `lat`, `lon` | 4 B + 4 B | Fixed-point degrees × 1e-7 |
| `fix_age`, `sats`/`hdop` | 1 B + 1 B | Quality of position |
| `batt` | 1 B | State of charge % |
| `motion` | 1 B | Motion index 0–100 |
| `crc` | 2 B | Integrity |

≈ **24–28 bytes** total payload. The sim should compute time-on-air from the actual byte count (§10.3).

Gateway-side derived fields (not transmitted): `rssi_last_hop`, `snr_last_hop`, `hops`, `rx_time`, `latency`, `sf_used`.

---

## 9. Rescue Web mesh (modified AODV)

Traffic is **convergecast**: almost everything flows toward the single gateway. Use that: each node needs a route to the gateway, not general any-to-any routing.

### 9.1 Route discovery & maintenance (AODV-style)

- **RREQ** (broadcast) → neighbors rebroadcast with incremented hop count; dedupe by (`origin`,`rreq_id`).
- **RREP** unicast back along the reverse path; each node records `next_hop`, `hops`, `dest_seq`, `link_cost`, `expiry`.
- **RERR** when a next hop stops responding (missed ACKs / no HELLO); trigger local repair.
- **HELLO** beacons (low rate, jittered) provide neighbor RSSI/SNR and liveness.

### 9.2 Modifications (the thesis contribution)

1. **RSSI-based route selection** — choose among candidate next hops by a combined cost, not hop count alone:
   `cost = w_h · hops + w_r · f(RSSI/SNR margin) + w_b · (battery penalty)`
   where `f` penalizes links near the sensitivity floor (weak links fade under wave shadowing). Defaults [TUNABLE]: `w_h = 1.0`, `w_r = 2.0`, `w_b = 0.5`.
2. **Adaptive Spreading Factor (per link)** — pick the lowest SF whose margin ≥ `margin_target` (default 6 dB) over that SF's sensitivity; step **up** after `k` consecutive losses, step **down** after sustained good margin. Range SF7–SF12.
3. **Priority-aware forwarding** —
   - Forwarding queue ordered by tier: **Critical ≻ Warning ≻ Stable**, then age.
   - Critical packets get a **shorter random backoff window** and **more retransmission attempts**; they may pre-empt a queued lower-tier packet that hasn't started TX.
   - Optional: on congestion, drop/delay Stable first (and count it).
4. **Own-traffic vs relay fairness:** a node always sends its own Critical immediately; relays of other nodes' Critical take precedence over its own Stable.

### 9.3 Channel access

- Listen-before-talk (CAD) + random backoff. No true duty-cycle regulation modeled by default (display airtime utilization per node/channel; optional duty-cycle cap [TUNABLE]).
- Hidden-node and collision behavior: two overlapping transmissions on the same channel + same SF at a receiver → collision **unless** the stronger one is ≥ 6 dB above the other (capture effect). Different SFs are treated as quasi-orthogonal (small residual interference).
- Link-layer ACK (or implicit ACK by hearing the forward) with limited retries; end-to-end delivery is confirmed only by gateway reception (sim computes PDR from ground truth).

---

## 10. Channel / radio model for the simulator

> The Wokwi test showed there's no real RF model available there; **this HTML sim is where link behavior is modeled.** Keep it simple, explicit, and tunable. Real range and RSSI still must be measured in the field and used to recalibrate these parameters.

### 10.1 Radio parameters [TUNABLE]

| Parameter | Default | Notes |
|---|---|---|
| Band | **433 MHz (SX1278)** or **915 MHz (SX1276)** | Selectable per run (and per node group for comparison runs). Hardware on hand: 433 MHz SX1278 units were ordered; 915 MHz SX1276 also selected. |
| Bandwidth | 125 kHz | |
| Coding rate | 4/5 | |
| Preamble | 8 symbols | |
| TX power | 17 dBm | SX127x PA_BOOST up to +20 dBm; **legal limit for the chosen band in the PH is unconfirmed** (see §17) |
| Antenna gain (wearable spring antenna) | −2 dBi | [ASSUMED] |
| Body/vest loss | 3–6 dB | [ASSUMED] |
| Antenna height above waterline | 0.2–0.4 m | Strongly limits range |
| Antenna mismatch penalty | 0 dB matched / 3–6 dB if wrong band antenna | Hook for the 433/915 antenna mismatch |

### 10.2 Spreading-factor table (125 kHz, CR 4/5)

| SF | Sensitivity (dBm, typical) | Required SNR (dB) | Bit rate (kbps) | ≈ ToA, 24 B payload |
|---|---|---|---|---|
| 7 | −123 | −7.5 | 5.47 | ~ 62 ms |
| 8 | −126 | −10 | 3.12 | ~ 113 ms |
| 9 | −129 | −12.5 | 1.76 | ~ 206 ms |
| 10 | −132 | −15 | 0.98 | ~ 371 ms |
| 11 | −134.5 | −17.5 | 0.54 | ~ 823 ms |
| 12 | −137 | −20 | 0.29 | ~ 1.48 s |

### 10.3 Time-on-air (compute, don't hardcode)

```
Tsym      = 2^SF / BW
Tpreamble = (n_preamble + 4.25) · Tsym
n_payload = 8 + max( ceil( (8·PL − 4·SF + 28 + 16·CRC − 20·IH) / (4·(SF − 2·DE)) ) · (CR + 4), 0 )
ToA       = Tpreamble + n_payload · Tsym
```
`PL` = payload bytes, `CRC` = 1, `IH` = 0 (explicit header), `CR` = 1 for 4/5, `DE` = 1 if `Tsym > 16 ms` (SF11/SF12 at 125 kHz).

### 10.4 Path loss (low antennas over water)

```
PL(d) = max( FSPL(d, f), TwoRay(d) ) + Shadow + Fade + BodyLoss + Mismatch
FSPL  = 32.44 + 20·log10(d_km) + 20·log10(f_MHz)
TwoRay = 40·log10(d_m) − 20·log10(h_t · h_r)         (valid beyond breakpoint d_b = 4·h_t·h_r / λ)
Shadow ~ N(0, σ_s²),   σ_s = 3 + 1.5 · SeaState   dB      [ASSUMED]
Fade   ~ Rayleigh/Rician small-scale per packet            [ASSUMED]
RSSI   = P_tx + G_tx + G_rx − PL
Link OK if RSSI ≥ sensitivity(SF) and SNR ≥ SNR_min(SF)
```
Sanity check: with `h_t = h_r = 0.3 m`, `P_tx = 17 dBm`, total antenna gain ≈ −4 dBi, usable range at SF7 is on the order of **hundreds of meters to ~ 1 km**, longer at higher SF. If the sim gives 10+ km range, the model is wrong for wearable-height antennas.

### 10.5 Sea-state effects [TUNABLE]

- `SeaState` slider (e.g., Beaufort 0–6) sets wave height `Hs`, wave period, and shadowing spread.
- **Wave shadowing:** a node in a trough loses line-of-sight to others; model as a time-varying extra loss (period ≈ wave period).
- **Antenna dunking:** per node, with probability growing with `SeaState`, the antenna is briefly submerged (≈ 0.5–2 s) → **TX/RX fail and GPS may drop** during that window.
- **Immersion flicker:** probes alternate wet/dry with waves — exercises the debounce/latch logic in §6.1.

### 10.6 Submerged-antenna attenuation (parameter, not a hardcoded claim)

A field observation was reported that a **433 MHz link kept working while submerged in a lake**, better than other bands. Don't hardcode a physics formula for this; expose it as a **calibratable per-band penalty**:

| Parameter | Default [ASSUMED — replace with field data] |
|---|---|
| `submerged_loss_dB(433 MHz, freshwater)` | e.g. 20–30 dB |
| `submerged_loss_dB(915 MHz, freshwater)` | e.g. 30–45 dB |
| `submerged_loss_dB(433 MHz, seawater)` | very high (≥ 60 dB) — link effectively lost |
| `submerged_loss_dB(915 MHz, seawater)` | very high (≥ 70 dB) — link effectively lost |

Lake (freshwater) results **do not transfer** to seawater (conductivity differs by ~100×); the sim should have a **water type** selector (fresh / sea) and label results accordingly. This is also a good place for an A/B comparison view: "433 MHz vs 915 MHz under the same sea state."

---

## 11. Environment & scenario model

- **Map:** offline canvas, local meters (x east, y north), converted to lat/lon from a configurable origin (placeholder: any open-sea coordinate). No online tiles required.
- **Vessel (sinking) / SAR vessel:** the SAR vessel carries the gateway; it can be **stationary** or follow a **waypoint path** (draggable), approaching the survivor field.
- **Survivors:** `N` nodes [TUNABLE, default 20; range 2–60], initially clustered around the incident point (default radius 50–200 m), each with a small random walk.
- **Drift:** common current vector + wind leeway + per-node jitter. Default current 0.1–0.5 m/s; default heading configurable. Nodes in the same group drift mostly together but disperse over time (this is what stresses the mesh).
- **Survivor behavior scripts** (per node, so classification can be tested): `calm_floating`, `swimming`, `struggling`, `unresponsive` (goes still), `presses_sos_at(t)`, `battery_drain_fast`.
- **Time controls:** play/pause, speed 1×–600×, step, scrub, deterministic seed (so a run is reproducible and comparable).

---

## 12. Power model (per node)

Typical current draw [ASSUMED — datasheet/typical values; verify with your boards]:

| Block | State | ≈ Current |
|---|---|---|
| ESP32 (core) | Active CPU, radios off | 30–60 mA |
| ESP32 (core) | Light sleep / deep sleep (chip only) | ~ 0.8 mA / ~ 10 µA |
| **ESP32 DevKit board overhead** (USB-UART, LDO, power LED) | Always | **~ 1–5 mA — can dominate sleep current** |
| SX127x LoRa | TX +17 dBm | ~ 90–120 mA |
| SX127x LoRa | RX | ~ 10–12 mA |
| SX127x LoRa | Sleep | ~ 1 µA |
| NEO-M8N | Acquisition / tracking | ~ 25–70 mA (peak during acquisition) |
| NEO-M8N | Off (power-gated) | ~ 0 |
| MPU6050 | Active | ~ 4 mA |
| MAX17048 | Active | ~ 25 µA |
| Immersion sense | Pulsed | negligible |

Energy model:
- Battery default **2500 mAh @ 3.7 V**, usable ≈ 85–90 %. [TUNABLE]
- Solar input = `panel_W × irradiance(t) × tilt/shading factor × charge efficiency`, with a day/night cycle and a cloud factor. Default panel 1–2 W [TUNABLE]; solar is an **offset**, not a guarantee.
- The sim must show **estimated remaining runtime** and a **72-hour pass/fail** indicator, with the largest consumers listed (usually LoRa TX + continuous RX/listen + GPS).
- Key trade-off the sim should expose: **mesh relay needs the receiver on**. Continuous RX (~ 10–12 mA) alone is ~ 240–290 mAh/day; use a listen-duty-cycle / scheduled-listen setting [TUNABLE] and show its effect on both **battery life** and **latency/PDR**.

---

## 13. Gateway & rescuer dashboard (stand-in for the Flutter app)

### 13.1 Gateway logic
- Receive all packets in range; **dedupe** by (`src`,`seq`); keep the best copy (lowest hops/latency) for stats.
- Maintain a node table: last position, track history (trail), tier, battery, motion class, immersed/SOS flags, fix quality, hops, last-hop RSSI/SNR, last-seen.
- **Lost-contact:** if no packet for `3 ×` that node's current-tier interval → mark **LOST** (show last known position + age; keep it on the map, grayed/hatched).
- Priority ranking for the alert list: **tier desc → SOS first → time-since-last-report desc → battery asc**.

### 13.2 Screens / panels
1. **Map** — survivors as tier-colored markers (+ shape/icon, not color alone), drift trails, mesh links (optional toggle, line thickness/opacity by RSSI), gateway/SAR vessel marker, range rings, scale bar, north arrow.
2. **Priority alert list** — Critical first; new Critical raises a visible/audible alert; acknowledge button; tap to center the map.
3. **Node detail drawer** — position & fix age, tier + *why* (which rule fired), battery %, motion class, immersed/SOS flags, hops, RSSI/SNR, route path (hop chain), packet history.
4. **Mesh/network view** — graph of nodes/links, per-link SF, per-node queue depth, airtime utilization, collisions.
5. **Last-mile view (rescuer nearby)** — select a node; show **distance & bearing** from the rescuer's position (rescuer = draggable marker). Within local range, switch to a "closing-in" indicator (proxy for the offline BLE/Wi-Fi localization). Mark clearly: *last-mile only, not part of the mesh data path.*
6. **Gateway OLED mock** — 128×64 mock showing node count, Critical count, last packet.
7. **Metrics panel** — live and end-of-run summaries (§15).

---

## 14. Simulation controls (what the user can do)

- Add/remove/drag nodes; set per-node behavior script; set battery %; force SOS; force "unresponsive".
- Global: sea state, current vector, water type (fresh/sea), band (433/915), SF mode (fixed vs adaptive), TX power, listen duty, mesh algorithm toggles (**baseline** = plain hop-count AODV, fixed SF, FIFO queue **vs** **AGOS** = RSSI cost + adaptive SF + priority queue) — this toggle is what demonstrates the contribution.
- Fault injection: kill a relay node, jam a channel, drop GPS, sudden sea-state increase.
- Scenario presets (below), plus save/load of scenario JSON and export of metrics CSV.

### 14.1 Scenario presets

| Preset | What it shows |
|---|---|
| **Abandon ship** | 20 nodes, cluster, moderate sea, SAR vessel approaches from ~ 2 km: activation → mesh forms → gateway fills in |
| **Dispersal** | Strong current, nodes spread to > 1 km: multi-hop breaks, adaptive SF steps up, LOST detection |
| **Critical storm** | One unresponsive + one SOS in a Stable crowd: priority-first forwarding vs FIFO latency comparison |
| **Battery stress** | Mixed battery levels, 72 h fast-forward with day/night solar |
| **Band A/B** | Same seed, 433 vs 915 MHz (and fresh vs sea water): range, PDR, latency comparison |

---

## 15. Metrics to log (maps to the proposal's evaluation plan)

| Evaluation item | Metrics |
|---|---|
| **Immersion-trigger responsiveness** | Time from first sustained wet contact → ACTIVE → first packet queued → first received at gateway; false activations from splash (should be 0 at default `T_wet`) |
| **Mesh range & latency** | Max single-hop range per SF; end-to-end latency (mean / P95) by tier and hop count; hop-count distribution |
| **Reliability** | Packet delivery ratio per node and per tier; duplicates; collisions; retransmissions |
| **Routing behavior** | Route changes, RERR count, route stability, % of traffic on weak links |
| **Location/status reporting** | Position error vs ground truth; fix availability; report age distribution at gateway |
| **Classification accuracy** | Confusion matrix (computed tier vs scripted ground-truth tier); time-to-escalate |
| **Power sustainability** | mAh drained by block, remaining runtime, 72 h pass/fail, solar contribution |
| **Priority-forwarding benefit** | Critical latency & PDR under load: AGOS vs baseline |
| **Cost/feasibility** (informational) | Shared-gateway fleet scaling: nodes per gateway vs coverage |

---

## 16. Build tasks (suggested milestones)

**M1 — Core engine**
- [ ] Deterministic sim loop with seeded RNG, time scaling, pause/step/scrub.
- [ ] Entities: SurvivorNode, Gateway, Environment (current, wind, sea state).
- [ ] Coordinate system + lat/lon conversion; drift + random walk.

**M2 — Node model**
- [ ] Immersion sensing with pulsed sampling, `T_wet` debounce, latched ACTIVE, splash rejection.
- [ ] IMU motion synthesis per behavior script → motion class + `still_duration`.
- [ ] GPS model (error, TTFF, dropouts, fix age).
- [ ] Battery/power model + solar.
- [ ] Classification module (§7) with rule-fired explanation + hysteresis.
- [ ] Tier-based reporting intervals + SOS burst.

**M3 — Radio & channel**
- [ ] ToA calculator, SF table, sensitivity/SNR checks.
- [ ] Path loss (FSPL / two-ray), shadowing, fading, sea-state and antenna-dunk effects.
- [ ] Collision/capture model, CAD + backoff.
- [ ] Band selector (433/915) incl. antenna mismatch + submerged-loss parameters.

**M4 — Rescue Web**
- [ ] Baseline AODV (RREQ/RREP/RERR/HELLO).
- [ ] RSSI/SNR-aware cost; adaptive SF per link; priority queue + Critical backoff/retries.
- [ ] Toggle baseline vs AGOS for comparisons.

**M5 — Gateway + UI**
- [ ] Node table, dedupe, lost-contact logic, ranking.
- [ ] Map (canvas/SVG), markers, trails, link overlay, alert list, node drawer, last-mile view, OLED mock.
- [ ] Controls panel + scenario presets + JSON save/load.

**M6 — Metrics & polish**
- [ ] Metrics panel + CSV export; confusion matrix; latency/PDR charts.
- [ ] Optional "hardware view" tab: exploded node with module outlines at true dimensions (§4) and live signal activity (SPI/I2C/UART LEDs), enforcing the §5.4 wiring rules.
- [ ] Accessibility: color-independent tier indicators, keyboard operable, readable at phone width.

---

## 17. Open items & assumptions to resolve

1. **433 MHz regulatory status in the Philippines is unconfirmed.** The well-documented LoRa allocation used by the PH community is the 920–925 MHz (AS923) range; I could not confirm from NTC's circulars whether 433 MHz LoRa is license-free. The sim treats band as a **parameter** and makes no compliance claim. Confirm with the adviser/NTC before the paper states a deployed band.
2. **Submerged-antenna loss** values in §10.6 are placeholders. Replace with measured values from the lake/pool/sea tests; keep fresh vs sea water separate.
3. **Motion thresholds** (§7.1) and **report intervals** (§6.2) are starting points; tune with real MPU6050 logs and the 72 h power budget.
4. **GPS power-gating** (GPIO4 + P-MOSFET) is a proposed addition, not yet in the schematic; the 72 h target likely needs GPS duty-cycling.
5. **Antenna choice:** stock spring antennas are band-specific (433 vs 915) and not tuned for 920–925 MHz; the sim's mismatch penalty is a stand-in until measured.
6. **Duty-cycle / legal TX power** for the chosen band: not modeled as a hard limit by default.
7. **Dimensions** of the actual boards, solar panel, and enclosure should be measured and entered (§4) before building the hardware view.

---

## 18. Change log vs. the thesis proposal

| Item | Proposal | Now |
|---|---|---|
| GPS | NEO-6M | **NEO-M8N** (drop-in, same UART wiring) |
| LoRa | Ra-02 (SX1276/78) | **SX1278 433 MHz ordered**; SX1276 915 MHz also selected |
| Satellite IoT | (earlier drafts) | **Removed** per panel; proposal text is already satellite-free |
| Fuel gauge | "battery-level monitor" | **MAX17048** over I2C |
| Schematic tool | — | Autodesk Fusion (Electronics) |
| Simulation | Wokwi logic test (UART standing in for LoRa) | **HTML simulation** (this spec) for mesh/channel/dashboard behavior |

---

*Appendix — quick reference for the sim's data model (illustrative):*

```json
{
  "node": {
    "id": 7, "mode": "ACTIVE", "immersed": true, "sos": false,
    "motion": {"class": "STILL", "index": 4, "still_s": 134},
    "battery_pct": 62, "gps": {"lat": 10.6012, "lon": 124.2041, "fix_age_s": 3, "sats": 9, "hdop": 1.1},
    "tier": "CRITICAL", "rule_fired": "R2_immersed_still_120s",
    "radio": {"band_mhz": 433, "sf": 9, "tx_dbm": 17}
  },
  "packet": {
    "type": "STATUS", "src": 7, "dst": 0, "seq": 1042, "hops": 2, "prio": 2,
    "flags": ["immersed", "still"], "lat": 10.6012, "lon": 124.2041,
    "batt": 62, "motion": 4
  }
}
```
