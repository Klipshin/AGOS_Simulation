/* ==========================================================================
   AGOS SIMULATION — MAIN APPLICATION ENTRY POINT
   ========================================================================== */

import { Simulation } from './simulation.js';
import { SimulationUI } from './ui.js';
import { loadEnv } from './config.js';

window.addEventListener("DOMContentLoaded", async () => {
  // Load Mapbox token from .env or localStorage
  await loadEnv();

  const sim = new Simulation();
  const ui = new SimulationUI(sim);

  window.agosSim = sim;
  window.agosSimUI = ui;

  let lastTime = performance.now();

  function animLoop(currentTime) {
    const realDt = (currentTime - lastTime) / 1000.0;
    lastTime = currentTime;

    // Tick simulation logic
    sim.tick(realDt);

    // Render visual views
    ui.render();

    requestAnimationFrame(animLoop);
  }

  requestAnimationFrame(animLoop);
  console.log("AGOS Simulation Engine Initialized.");
});
