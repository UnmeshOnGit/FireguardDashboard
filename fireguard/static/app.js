/* ==========================================================================
   FireGuard Monitor — Frontend Polling & Chart.js Controller
   Note: Browser never accesses serial ports; Python backend handles pyserial.
   ========================================================================== */
(function () {
  'use strict';

  const THEME_KEY = 'fireguard_theme';
  const LATEST_POLL_MS = 500;
  const HISTORY_POLL_MS = 2000;

  const state = {
    activeTab: 'live',
    rangeSec: 60,
    paused: false,
    muted: false,
    theme: localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark',

    latestData: null,
    lastRenderedState: null,
    lastEventsSignature: '',
    criticalAck: false,
    threshold: 380,
    criticalLevel: 580,
    settingsInitialized: false,

    latestTimer: null,
    historyTimer: null,
    latestInFlight: false,
    historyInFlight: false,
    reportInFlight: false
  };

  /* ------------------------------------------------------------------------
     Cached DOM References (No DOM rebuilds on 500ms ticks)
     ------------------------------------------------------------------------ */
  const dom = {};

  function cacheDom() {
    dom.hdrConnStatus = document.getElementById('hdr-conn-status');
    dom.hdrConnLabel = document.getElementById('hdr-conn-label');
    dom.btnMute = document.getElementById('btn-mute');
    dom.btnMuteLabel = document.getElementById('btn-mute-label');
    dom.btnTheme = document.getElementById('btn-theme');
    dom.btnThemeLabel = document.getElementById('btn-theme-label');

    dom.uptimeVal = document.getElementById('uptime-val');
    dom.dataRateVal = document.getElementById('data-rate-val');
    dom.lastUpdatedVal = document.getElementById('last-updated-val');

    dom.warmupBanner = document.getElementById('warmup-banner');
    dom.warmupText = document.getElementById('warmup-text');
    dom.warmupBar = document.getElementById('warmup-progress-bar');
    dom.errorBanner = document.getElementById('error-banner');
    dom.errorText = document.getElementById('error-text');

    dom.stateBanner = document.getElementById('state-banner');
    dom.stateIconBox = document.getElementById('state-icon-box');
    dom.stateName = document.getElementById('state-name');
    dom.stateMessage = document.getElementById('state-message');
    dom.stateDuration = document.getElementById('state-duration');

    dom.mq2Value = document.getElementById('mq2-value');
    dom.gasStatusText = document.getElementById('gas-status-text');
    dom.mq2Baseline = document.getElementById('mq2-baseline');
    dom.mq2Threshold = document.getElementById('mq2-threshold');
    dom.mq2Peak = document.getElementById('mq2-peak');
    dom.gaugeArcNormal = document.getElementById('gauge-arc-normal');
    dom.gaugeArcWarning = document.getElementById('gauge-arc-warning');
    dom.gaugeArcCritical = document.getElementById('gauge-arc-critical');
    dom.gaugeArcValue = document.getElementById('gauge-arc-value');
    dom.gaugeThresholdLine = document.getElementById('gauge-threshold-line');
    dom.gaugeNeedle = document.getElementById('gauge-needle');

    dom.servoNeedle = document.getElementById('servo-needle');
    dom.servoAngle = document.getElementById('servo-angle');
    dom.servoModeLabel = document.getElementById('servo-mode-label');

    dom.cardFlame = document.getElementById('card-flame');
    dom.flameLabel = document.getElementById('flame-label');
    dom.flameSub = document.getElementById('flame-sub');

    dom.cardMist = document.getElementById('card-mist');
    dom.mistLabel = document.getElementById('mist-label');
    dom.mistSub = document.getElementById('mist-sub');

    dom.cardAlarm = document.getElementById('card-alarm');
    dom.alarmLabel = document.getElementById('alarm-label');
    dom.alarmSub = document.getElementById('alarm-sub');

    dom.cardConnPort = document.getElementById('card-conn-port');
    dom.cardRateVal = document.getElementById('card-rate-val');
    dom.cardUpdatedVal = document.getElementById('card-updated-val');

    dom.tipsStateContext = document.getElementById('tips-state-context');
    dom.safetyTipsList = document.getElementById('safety-tips-list');
    dom.healthStatus = document.getElementById('health-status');
    dom.healthLabel = document.getElementById('health-label');
    dom.healthDetail = document.getElementById('health-detail');
    dom.chartMq2Legend = document.getElementById('chart-mq2-legend');

    dom.criticalOverlay = document.getElementById('critical-overlay');
    dom.overlayTelemetry = document.getElementById('overlay-telemetry');

    // Reports
    dom.printTimestamp = document.getElementById('print-timestamp');
    dom.repDuration = document.getElementById('rep-duration');
    dom.repReadings = document.getElementById('rep-readings');
    dom.repMq2Stats = document.getElementById('rep-mq2-stats');
    dom.repGasAlerts = document.getElementById('rep-gas-alerts');
    dom.repFlameEvents = document.getElementById('rep-flame-events');
    dom.repMistTime = document.getElementById('rep-mist-time');
    dom.repLongestCritical = document.getElementById('rep-longest-critical');
    dom.repLastIncident = document.getElementById('rep-last-incident');
    dom.repPctNormal = document.getElementById('rep-pct-normal');
    dom.repPctAlert = document.getElementById('rep-pct-alert');
    dom.eventFilter = document.getElementById('event-filter');
    dom.eventLogBody = document.getElementById('event-log-body');

    // Settings
    dom.setThreshold = document.getElementById('set-threshold');
    dom.setCritical = document.getElementById('set-critical');
    dom.settingsSaveMsg = document.getElementById('settings-save-msg');
  }

  /* ------------------------------------------------------------------------
     Formatting & Helpers
     ------------------------------------------------------------------------ */
  function formatDuration(totalSec) {
    const s = Math.max(0, Math.floor(totalSec || 0));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    return [hrs, mins, secs].map((n) => String(n).padStart(2, '0')).join(':');
  }

  function formatTimeFromMs(tsMs) {
    if (!tsMs) return '--:--:--';
    return new Date(tsMs).toLocaleTimeString([], { hour12: false });
  }

  /* ------------------------------------------------------------------------
     Web Audio Alert Synthesizer (Starts only after user gesture)
     ------------------------------------------------------------------------ */
  let audioCtx = null;
  let audioTimer = null;

  function unlockAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  }

  function beep(freq, ms, type, vol, delayMs) {
    if (!audioCtx) return;
    const t = audioCtx.currentTime + delayMs / 1000;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
  }

  function playWarningBeep() {
    if (state.muted || !audioCtx) return;
    beep(660, 140, 'triangle', 0.14, 0);
    beep(660, 140, 'triangle', 0.14, 210);
  }

  function playCriticalSiren() {
    if (state.muted || state.criticalAck || !audioCtx) return;
    beep(920, 170, 'sawtooth', 0.18, 0);
    beep(1220, 170, 'sawtooth', 0.18, 190);
    beep(920, 170, 'sawtooth', 0.18, 380);
  }

  function syncAudioLoop(sysState) {
    if (audioTimer) {
      clearInterval(audioTimer);
      audioTimer = null;
    }
    if (state.muted || !audioCtx) return;
    if (sysState === 'CRITICAL' && !state.criticalAck) {
      playCriticalSiren();
      audioTimer = setInterval(playCriticalSiren, 1500);
    } else if (sysState === 'WARNING') {
      playWarningBeep();
      audioTimer = setInterval(playWarningBeep, 3200);
    }
  }

  /* ------------------------------------------------------------------------
     SVG Gauge & Dial Helpers
     ------------------------------------------------------------------------ */
  function polar(cx, cy, r, deg) {
    const rad = (deg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function arcPath(cx, cy, r, startDeg, endDeg) {
    const s = polar(cx, cy, r, startDeg);
    const e = polar(cx, cy, r, endDeg);
    const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }

  function valToDeg(v) {
    const c = Math.max(0, Math.min(1023, v));
    return 180 + (c / 1023) * 180;
  }

  function updateGaugeZones(threshold, criticalLevel) {
    const tDeg = valToDeg(threshold);
    const cDeg = valToDeg(Math.max(threshold, criticalLevel));
    dom.gaugeArcNormal.setAttribute('d', arcPath(120, 120, 90, 180, tDeg));
    dom.gaugeArcWarning.setAttribute('d', arcPath(120, 120, 90, tDeg, cDeg));
    dom.gaugeArcCritical.setAttribute('d', arcPath(120, 120, 90, cDeg, 360));

    const p1 = polar(120, 120, 102, tDeg);
    const p2 = polar(120, 120, 78, tDeg);
    dom.gaugeThresholdLine.setAttribute('x1', p1.x.toFixed(1));
    dom.gaugeThresholdLine.setAttribute('y1', p1.y.toFixed(1));
    dom.gaugeThresholdLine.setAttribute('x2', p2.x.toFixed(1));
    dom.gaugeThresholdLine.setAttribute('y2', p2.y.toFixed(1));
  }

  function updateGaugeValue(mq2) {
    if (mq2 === null || mq2 === undefined) {
      dom.gaugeArcValue.setAttribute('d', '');
      dom.gaugeNeedle.setAttribute('transform', 'rotate(-90 120 120)');
      return;
    }
    const vDeg = valToDeg(mq2);
    dom.gaugeArcValue.setAttribute('d', mq2 > 0 ? arcPath(120, 120, 90, 180, vDeg) : '');
    let color = 'var(--status-normal)';
    if (mq2 >= state.criticalLevel) color = 'var(--status-critical)';
    else if (mq2 >= state.threshold) color = 'var(--status-warning)';
    dom.gaugeArcValue.setAttribute('stroke', color);
    const rot = -90 + (mq2 / 1023) * 180;
    dom.gaugeNeedle.setAttribute('transform', `rotate(${rot.toFixed(1)} 120 120)`);
  }

  /* ------------------------------------------------------------------------
     Chart.js Setup (Never recreated, updated via chart.update('none'))
     ------------------------------------------------------------------------ */
  let mq2Chart = null;
  let binaryChart = null;
  let servoChart = null;
  let doughnutChart = null;
  let barChart = null;

  const thresholdPlugin = {
    id: 'thresholdZones',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.y) return;
      const y = scales.y;
      const top = chartArea.top;
      const bot = chartArea.bottom;
      const yT = Math.max(top, Math.min(bot, y.getPixelForValue(state.threshold)));
      const yC = Math.max(top, Math.min(bot, y.getPixelForValue(state.criticalLevel)));

      ctx.save();
      ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
      ctx.fillRect(chartArea.left, yT, chartArea.width, bot - yT);
      ctx.fillStyle = 'rgba(245, 158, 11, 0.11)';
      ctx.fillRect(chartArea.left, yC, chartArea.width, yT - yC);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.12)';
      ctx.fillRect(chartArea.left, top, chartArea.width, yC - top);

      ctx.beginPath();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#d97706';
      ctx.moveTo(chartArea.left, yT);
      ctx.lineTo(chartArea.right, yT);
      ctx.stroke();

      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = '#dc2626';
      ctx.moveTo(chartArea.left, yC);
      ctx.lineTo(chartArea.right, yC);
      ctx.stroke();
      ctx.restore();
    }
  };

  function getChartColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
      grid: cs.getPropertyValue('--chart-grid').trim(),
      tick: cs.getPropertyValue('--chart-tick').trim()
    };
  }

  function initCharts() {
    if (typeof Chart === 'undefined') return;
    const c = getChartColors();

    mq2Chart = new Chart(document.getElementById('chart-mq2'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'MQ2',
          data: [],
          borderColor: '#3b82f6',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: c.grid }, ticks: { color: c.tick, maxTicksLimit: 8 } },
          y: { min: 0, max: 1023, grid: { color: c.grid }, ticks: { color: c.tick } }
        }
      },
      plugins: [thresholdPlugin]
    });

    binaryChart = new Chart(document.getElementById('chart-binary'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'Flame', data: [], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.2)', borderWidth: 2, stepped: true, pointRadius: 0, fill: true },
          { label: 'Mist', data: [], borderColor: '#0ea5e9', backgroundColor: 'rgba(14,165,233,0.18)', borderWidth: 2, stepped: true, pointRadius: 0, fill: true }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { labels: { color: c.tick, boxWidth: 12 } } },
        scales: {
          x: { grid: { color: c.grid }, ticks: { color: c.tick, maxTicksLimit: 6 } },
          y: { min: 0, max: 1.2, grid: { color: c.grid }, ticks: { color: c.tick, stepSize: 1 } }
        }
      }
    });

    servoChart = new Chart(document.getElementById('chart-servo'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{ label: 'Servo °', data: [], borderColor: '#818cf8', borderWidth: 2, pointRadius: 0, tension: 0.15 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: c.grid }, ticks: { color: c.tick, maxTicksLimit: 6 } },
          y: { min: 0, max: 180, grid: { color: c.grid }, ticks: { color: c.tick, stepSize: 45 } }
        }
      }
    });

    doughnutChart = new Chart(document.getElementById('chart-report-doughnut'), {
      type: 'doughnut',
      data: {
        labels: ['Normal', 'Warning', 'Critical'],
        datasets: [{ data: [100, 0, 0], backgroundColor: ['#10b981', '#f59e0b', '#ef4444'], borderWidth: 0 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { position: 'bottom', labels: { color: c.tick } } }
      }
    });

    barChart = new Chart(document.getElementById('chart-report-bar'), {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          { label: 'Gas Alerts', data: [], backgroundColor: '#f59e0b' },
          { label: 'Flame Events', data: [], backgroundColor: '#ef4444' }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { position: 'bottom', labels: { color: c.tick } } },
        scales: {
          x: { grid: { color: c.grid }, ticks: { color: c.tick } },
          y: { beginAtZero: true, grid: { color: c.grid }, ticks: { color: c.tick, precision: 0 } }
        }
      }
    });
  }

  function applyChartTheme() {
    const c = getChartColors();
    [mq2Chart, binaryChart, servoChart, barChart].forEach((ch) => {
      if (!ch) return;
      ch.options.scales.x.grid.color = c.grid;
      ch.options.scales.x.ticks.color = c.tick;
      ch.options.scales.y.grid.color = c.grid;
      ch.options.scales.y.ticks.color = c.tick;
      if (ch.options.plugins.legend && ch.options.plugins.legend.labels) {
        ch.options.plugins.legend.labels.color = c.tick;
      }
      ch.update('none');
    });
    if (doughnutChart) {
      doughnutChart.options.plugins.legend.labels.color = c.tick;
      doughnutChart.update('none');
    }
  }

  /* ------------------------------------------------------------------------
     State Icons & Safety Tips (Updated only on state transition)
     ------------------------------------------------------------------------ */
  const STATE_INFO = {
    NORMAL: {
      msg: 'All sensors within safe thresholds',
      icon: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
      tips: [
        'System nominal. Keep the mist reservoir topped up for fire readiness.',
        'Ensure IR flame sensor and gas intake remain unobstructed.'
      ]
    },
    WARNING: {
      msg: 'Elevated gas level detected — no flame',
      icon: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      tips: [
        'Ventilate the room immediately by opening doors and windows.',
        'Remove all open flames and ignition sources; do not toggle switches.',
        'Inspect gas valves, tubing, and appliances for leaks.'
      ]
    },
    CRITICAL: {
      msg: 'Flame detected — suppression & alarm active',
      icon: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>',
      tips: [
        'Evacuate the area immediately and alert nearby occupants.',
        'Call emergency fire services if the flame persists.',
        'Shut off main gas or power only if safe to reach.'
      ]
    },
    OFFLINE: {
      msg: 'No telemetry received for more than 3 seconds',
      icon: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>',
      tips: [
        'Verify the Arduino USB cable is plugged into the host running app.py.',
        'Confirm Arduino IDE Serial Monitor is closed so Python can open the port.'
      ]
    }
  };

  function updateTipsForState(sysState) {
    const info = STATE_INFO[sysState] || STATE_INFO.OFFLINE;
    dom.stateIconBox.innerHTML = info.icon;
    dom.tipsStateContext.textContent = `State: ${sysState}`;
    dom.safetyTipsList.textContent = '';
    for (const tip of info.tips) {
      const li = document.createElement('li');
      li.textContent = tip;
      dom.safetyTipsList.appendChild(li);
    }
  }

  /* ------------------------------------------------------------------------
     Render /api/latest Snapshot (Fast textContent & classList mutations only)
     ------------------------------------------------------------------------ */
  function renderLatest(data) {
    state.latestData = data;

    // Update threshold visuals if server settings changed
    if (
      !state.settingsInitialized ||
      data.threshold !== state.threshold ||
      data.critical_level !== state.criticalLevel
    ) {
      state.threshold = data.threshold;
      state.criticalLevel = data.critical_level;
      updateGaugeZones(state.threshold, state.criticalLevel);
      dom.chartMq2Legend.textContent = `Threshold: ${state.threshold} · Critical: ${state.criticalLevel}`;
      if (state.activeTab !== 'settings' || !state.settingsInitialized) {
        dom.setThreshold.value = state.threshold;
        dom.setCritical.value = state.criticalLevel;
      }
      state.settingsInitialized = true;
      if (mq2Chart) mq2Chart.update('none');
    }

    // Connection header & card
    const conn = data.connection || {};
    dom.hdrConnStatus.setAttribute('data-conn', conn.status || 'Disconnected');
    dom.hdrConnLabel.textContent = conn.port ? `${conn.status} (${conn.port})` : (conn.status || 'Disconnected');
    dom.cardConnPort.textContent = `Port: ${conn.port || '--'} @ ${conn.baud || 115200}`;

    // Toolbar telemetry
    dom.uptimeVal.textContent = formatDuration(data.uptime_sec);
    const rateText = `${Number(data.data_rate || 0).toFixed(1)} /s`;
    dom.dataRateVal.textContent = rateText;
    dom.cardRateVal.textContent = rateText;

    // Warm-up banner
    const wu = data.warm_up || {};
    if (wu.active && wu.remaining_sec > 0) {
      dom.warmupBanner.classList.add('visible');
      dom.warmupText.textContent = `Sensor warming up: ${wu.remaining_sec}s remaining`;
      const pct = wu.total_sec > 0 ? (wu.remaining_sec / wu.total_sec) * 100 : 0;
      dom.warmupBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    } else {
      dom.warmupBanner.classList.remove('visible');
    }

    // System state banner & transitions
    const sysState = data.state || 'OFFLINE';
    dom.stateBanner.setAttribute('data-state', sysState);
    dom.stateName.textContent = sysState;
    dom.stateDuration.textContent = formatDuration(data.state_duration_sec);

    if (sysState !== state.lastRenderedState) {
      if (sysState === 'CRITICAL') state.criticalAck = false;
      updateTipsForState(sysState);
      syncAudioLoop(sysState);
      state.lastRenderedState = sysState;
    }

    const r = data.reading;
    if (sysState === 'CRITICAL' && r) {
      dom.stateMessage.textContent = r.mist === 'ON'
        ? 'Flame detected — mist suppression active'
        : 'Flame detected — mist system standby';
    } else {
      dom.stateMessage.textContent = (STATE_INFO[sysState] || STATE_INFO.OFFLINE).msg;
    }

    // Critical Overlay
    if (sysState === 'CRITICAL' && !state.criticalAck) {
      dom.criticalOverlay.classList.add('visible');
      if (r) {
        const sTxt = r.servo === null || r.servo === undefined ? '--' : `${r.servo}°`;
        dom.overlayTelemetry.textContent = `MQ2: ${r.mq2} | SERVO: ${sTxt} | MIST: ${r.mist} | ALARM: ${r.alarm}`;
      }
    } else {
      dom.criticalOverlay.classList.remove('visible');
    }

    // Sensor Health
    const health = data.sensor_health || { healthy: true, message: 'All sensors nominal' };
    dom.healthStatus.className = `health-status ${health.healthy ? 'healthy' : 'fault'}`;
    dom.healthLabel.textContent = health.healthy ? 'Sensors Healthy' : 'Sensor Fault Suspected';
    dom.healthDetail.textContent = health.message;

    // Baseline / Threshold / Peak
    dom.mq2Baseline.textContent = data.baseline ?? 280;
    dom.mq2Threshold.textContent = data.threshold ?? 380;
    dom.mq2Peak.textContent = data.session_peak !== null && data.session_peak !== undefined ? data.session_peak : '--';

    if (!r) {
      dom.mq2Value.textContent = '--';
      dom.gasStatusText.textContent = '--';
      updateGaugeValue(null);
      return;
    }

    const updTime = formatTimeFromMs(r.ts);
    dom.lastUpdatedVal.textContent = updTime;
    dom.cardUpdatedVal.textContent = `Last: ${updTime}`;

    // Gas Card
    dom.mq2Value.textContent = r.mq2;
    dom.gasStatusText.textContent = r.gas;
    updateGaugeValue(r.mq2);

    // Servo Card
    if (r.servo === null || r.servo === undefined) {
      dom.servoAngle.textContent = '--';
      dom.servoNeedle.setAttribute('transform', 'rotate(0 120 120)');
      dom.servoModeLabel.textContent = 'Not connected';
      dom.servoModeLabel.classList.remove('locked');
    } else {
      dom.servoAngle.textContent = `${r.servo}°`;
      dom.servoNeedle.setAttribute('transform', `rotate(${(r.servo - 90).toFixed(1)} 120 120)`);
      dom.servoModeLabel.textContent = data.servo_mode || 'Sweeping';
      dom.servoModeLabel.classList.toggle('locked', data.servo_mode === 'Locked on flame');
    }

    // Flame Card
    const flameOn = r.ir === 'DETECTED';
    dom.cardFlame.classList.toggle('is-flame-detected', flameOn);
    dom.cardFlame.classList.toggle('is-flame-clear', !flameOn);
    dom.flameLabel.textContent = flameOn ? 'FLAME DETECTED' : 'NO FLAME';
    dom.flameSub.textContent = flameOn ? 'Active IR fire signature' : 'IR spectrum clear';

    // Mist Card
    const mistOn = r.mist === 'ON';
    dom.cardMist.classList.toggle('is-mist-on', mistOn);
    dom.mistLabel.textContent = r.mist;
    dom.mistSub.textContent = mistOn ? 'Water mist spraying' : 'Suppression standby';

    // Alarm Card
    const alarmOn = r.alarm === 'ACTIVE';
    dom.cardAlarm.classList.toggle('is-alarm-active', alarmOn);
    dom.cardAlarm.classList.toggle('is-alarm-clear', !alarmOn);
    dom.alarmLabel.textContent = r.alarm;
    dom.alarmSub.textContent = alarmOn ? 'Hardware buzzer active' : 'Buzzer silent';
  }

  /* ------------------------------------------------------------------------
     API Polling Functions (with Visibility Pause & Error Handling)
     ------------------------------------------------------------------------ */
  async function fetchLatest() {
    if (document.hidden || state.latestInFlight) return;
    state.latestInFlight = true;
    try {
      const res = await fetch('/api/latest', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      dom.errorBanner.classList.remove('visible');
      renderLatest(data);
    } catch (err) {
      dom.errorText.textContent = `Server connection issue: ${err.message}`;
      dom.errorBanner.classList.add('visible');
    } finally {
      state.latestInFlight = false;
    }
  }

  async function fetchHistory() {
    if (document.hidden || state.paused || state.historyInFlight) return;
    state.historyInFlight = true;
    try {
      const res = await fetch(`/api/history?seconds=${state.rangeSec}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const pts = (data.points || []).slice(-300);

      const labels = new Array(pts.length);
      const mq2Vals = new Array(pts.length);
      const flameVals = new Array(pts.length);
      const mistVals = new Array(pts.length);
      const servoVals = new Array(pts.length);

      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        labels[i] = formatTimeFromMs(p.ts);
        mq2Vals[i] = p.mq2;
        flameVals[i] = p.ir === 'DETECTED' ? 1 : 0;
        mistVals[i] = p.mist === 'ON' ? 1 : 0;
        servoVals[i] = p.servo === null || p.servo === undefined ? null : p.servo;
      }

      if (mq2Chart) {
        mq2Chart.data.labels = labels;
        mq2Chart.data.datasets[0].data = mq2Vals;
        mq2Chart.update('none');
      }
      if (binaryChart) {
        binaryChart.data.labels = labels;
        binaryChart.data.datasets[0].data = flameVals;
        binaryChart.data.datasets[1].data = mistVals;
        binaryChart.update('none');
      }
      if (servoChart) {
        servoChart.data.labels = labels;
        servoChart.data.datasets[0].data = servoVals;
        servoChart.update('none');
      }
    } catch (_) {
      // Latest poller handles connection error banner
    } finally {
      state.historyInFlight = false;
    }
  }

  async function fetchReportsAndEvents() {
    if (document.hidden || state.reportInFlight) return;
    state.reportInFlight = true;
    try {
      const filterVal = encodeURIComponent(dom.eventFilter.value || 'ALL');
      const [repRes, evRes] = await Promise.all([
        fetch('/api/report', { cache: 'no-store' }),
        fetch(`/api/events?limit=150&type=${filterVal}`, { cache: 'no-store' })
      ]);
      if (repRes.ok) {
        const rep = await repRes.json();
        renderReportSummary(rep);
      }
      if (evRes.ok) {
        const evData = await evRes.json();
        renderEventsTable(evData.events || []);
      }
    } catch (_) {
      // Handled gracefully
    } finally {
      state.reportInFlight = false;
    }
  }

  function renderReportSummary(rep) {
    dom.printTimestamp.textContent = `Generated on ${new Date().toLocaleString()}`;
    dom.repDuration.textContent = formatDuration(rep.session_duration_sec);
    dom.repReadings.textContent = (rep.total_readings || 0).toLocaleString();
    dom.repMq2Stats.textContent = rep.total_readings > 0
      ? `${rep.avg_mq2} / ${rep.min_mq2} / ${rep.max_mq2}`
      : '-- / -- / --';
    dom.repGasAlerts.textContent = (rep.gas_alerts_count || 0).toLocaleString();
    dom.repFlameEvents.textContent = (rep.flame_detections_count || 0).toLocaleString();
    dom.repMistTime.textContent = formatDuration(rep.mist_on_sec);
    dom.repLongestCritical.textContent = formatDuration(rep.longest_critical_sec);
    dom.repLastIncident.textContent = rep.last_incident_time || 'None';

    const tis = rep.time_in_state || {};
    const pN = tis.NORMAL ? tis.NORMAL.pct : 0;
    const pW = tis.WARNING ? tis.WARNING.pct : 0;
    const pC = tis.CRITICAL ? tis.CRITICAL.pct : 0;

    dom.repPctNormal.textContent = `${pN.toFixed(1)}%`;
    dom.repPctAlert.textContent = `${pW.toFixed(1)}% / ${pC.toFixed(1)}%`;

    if (doughnutChart) {
      const hasTime = (pN + pW + pC) > 0;
      doughnutChart.data.datasets[0].data = hasTime ? [pN, pW, pC] : [100, 0, 0];
      doughnutChart.update('none');
    }

    if (barChart) {
      const b = rep.buckets_5min || [];
      barChart.data.labels = b.map((item) => item.label);
      barChart.data.datasets[0].data = b.map((item) => item.gas);
      barChart.data.datasets[1].data = b.map((item) => item.flame);
      barChart.update('none');
    }
  }

  function renderEventsTable(events) {
    const sig = `${events.length}:${events[0] ? events[0].ts : 0}:${dom.eventFilter.value}`;
    if (sig === state.lastEventsSignature) return;
    state.lastEventsSignature = sig;

    dom.eventLogBody.textContent = '';
    if (events.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.className = 'empty-cell';
      td.textContent = 'No matching events recorded.';
      tr.appendChild(td);
      dom.eventLogBody.appendChild(tr);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const ev of events) {
      const tr = document.createElement('tr');
      const cells = [
        { text: ev.iso ? ev.iso.replace('T', ' ') : formatTimeFromMs(ev.ts), cls: 'mono' },
        { text: ev.type, cls: eventClass(ev.type) },
        { text: String(ev.mq2), cls: 'mono' },
        { text: ev.gas, cls: 'mono' },
        { text: ev.ir, cls: 'mono' },
        { text: ev.servo === null || ev.servo === undefined ? '--' : `${ev.servo}°`, cls: 'mono' },
        { text: ev.mist, cls: 'mono' },
        { text: ev.alarm, cls: 'mono' }
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        if (c.cls) td.className = c.cls;
        td.textContent = c.text;
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    dom.eventLogBody.appendChild(frag);
  }

  function eventClass(type) {
    if (type === 'Flame detected' || type === 'Alarm active') return 'ev-critical';
    if (type === 'Gas alert start') return 'ev-warning';
    if (type === 'Back to normal' || type === 'Flame cleared' || type === 'Gas alert end') return 'ev-normal';
    if (type === 'Mist ON' || type === 'Mist OFF') return 'ev-mist';
    return '';
  }

  /* ------------------------------------------------------------------------
     Polling Lifecycle & Visibility Pause
     ------------------------------------------------------------------------ */
  function startPolling() {
    stopPolling();
    fetchLatest();
    fetchHistory();
    if (state.activeTab === 'reports') fetchReportsAndEvents();

    state.latestTimer = setInterval(fetchLatest, LATEST_POLL_MS);
    state.historyTimer = setInterval(() => {
      fetchHistory();
      if (state.activeTab === 'reports') {
        fetchReportsAndEvents();
      }
    }, HISTORY_POLL_MS);
  }

  function stopPolling() {
    if (state.latestTimer) clearInterval(state.latestTimer);
    if (state.historyTimer) clearInterval(state.historyTimer);
    state.latestTimer = null;
    state.historyTimer = null;
  }

  /* ------------------------------------------------------------------------
     Theme, Tabs & User Interactions
     ------------------------------------------------------------------------ */
  function applyTheme(theme) {
    state.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    dom.btnThemeLabel.textContent = theme === 'dark' ? 'Light Theme' : 'Dark Theme';
    applyChartTheme();
  }

  function bindEvents() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopPolling();
      } else {
        startPolling();
      }
    });

    // Tab switching
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeTab = btn.dataset.tab;
        document.querySelectorAll('.nav-tab').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${state.activeTab}`));
        if (state.activeTab === 'reports') {
          fetchReportsAndEvents();
        } else if (state.activeTab === 'settings' && state.latestData) {
          dom.setThreshold.value = state.latestData.threshold;
          dom.setCritical.value = state.latestData.critical_level;
        }
      });
    });

    // Sound mute toggle
    dom.btnMute.addEventListener('click', () => {
      unlockAudio();
      state.muted = !state.muted;
      dom.btnMute.setAttribute('aria-pressed', String(state.muted));
      dom.btnMuteLabel.textContent = state.muted ? 'Sound: Muted' : 'Sound: On';
      syncAudioLoop(state.lastRenderedState);
    });

    // Theme toggle
    dom.btnTheme.addEventListener('click', () => {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    });

    // Acknowledge critical overlay
    document.getElementById('btn-acknowledge').addEventListener('click', () => {
      unlockAudio();
      state.criticalAck = true;
      dom.criticalOverlay.classList.remove('visible');
      syncAudioLoop('CRITICAL');
    });

    // Chart range buttons
    document.querySelectorAll('[data-range]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-range]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.rangeSec = parseInt(btn.dataset.range, 10) || 60;
        fetchHistory();
      });
    });

    // Chart pause button
    const pauseBtn = document.getElementById('btn-pause-charts');
    const pauseLbl = document.getElementById('btn-pause-label');
    pauseBtn.addEventListener('click', () => {
      state.paused = !state.paused;
      pauseLbl.textContent = state.paused ? 'Resume' : 'Pause';
      pauseBtn.classList.toggle('btn-active-toggle', state.paused);
      if (!state.paused) fetchHistory();
    });

    // Report filter, PDF print, Clear data
    dom.eventFilter.addEventListener('change', () => {
      state.lastEventsSignature = '';
      fetchReportsAndEvents();
    });

    document.getElementById('btn-print-pdf').addEventListener('click', () => {
      fetchReportsAndEvents().then(() => window.print());
    });

    let clearArmTimer = null;
    const clearBtn = document.getElementById('btn-clear-data');
    clearBtn.addEventListener('click', async () => {
      if (clearBtn.dataset.armed === 'true') {
        clearBtn.dataset.armed = 'false';
        clearBtn.textContent = 'Clear data';
        if (clearArmTimer) clearTimeout(clearArmTimer);
        try {
          const res = await fetch('/api/clear', { method: 'POST' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          state.lastEventsSignature = '';
          fetchLatest();
          fetchHistory();
          fetchReportsAndEvents();
        } catch (err) {
          dom.errorText.textContent = `Failed to clear data: ${err.message}`;
          dom.errorBanner.classList.add('visible');
        }
      } else {
        clearBtn.dataset.armed = 'true';
        clearBtn.textContent = 'Confirm clear?';
        clearArmTimer = setTimeout(() => {
          clearBtn.dataset.armed = 'false';
          clearBtn.textContent = 'Clear data';
        }, 3500);
      }
    });

    // Settings form -> POST /api/settings
    document.getElementById('settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const threshold = parseInt(dom.setThreshold.value, 10);
      const critical_level = parseInt(dom.setCritical.value, 10);
      dom.settingsSaveMsg.textContent = 'Saving...';
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threshold, critical_level })
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Failed to save');
        dom.settingsSaveMsg.textContent = 'Saved on server';
        fetchLatest();
      } catch (err) {
        dom.settingsSaveMsg.textContent = err.message;
      }
    });

    document.getElementById('btn-test-warning').addEventListener('click', () => {
      unlockAudio();
      const prev = state.muted;
      state.muted = false;
      playWarningBeep();
      state.muted = prev;
    });

    document.getElementById('btn-test-critical').addEventListener('click', () => {
      unlockAudio();
      const prevMuted = state.muted;
      const prevAck = state.criticalAck;
      state.muted = false;
      state.criticalAck = false;
      playCriticalSiren();
      state.muted = prevMuted;
      state.criticalAck = prevAck;
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    cacheDom();
    initCharts();
    applyTheme(state.theme);
    updateGaugeZones(state.threshold, state.criticalLevel);
    updateTipsForState('OFFLINE');
    bindEvents();
    startPolling();
  });
})();
