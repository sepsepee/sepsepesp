// ============================================================================
// espresso.js — CERA+ PCM03S Max 제어 · 에스프레소 추출 · 샷 기록 모듈
// ============================================================================
window.EspressoApp = (function () {
  function build7FCommand(payloadBytes) {
    const len = 4 + payloadBytes.length;
    const sumPayload = payloadBytes.reduce((a, b) => a + (b & 0xff), 0);
    const cs = (0x7f + 0x00 + len + sumPayload) & 0xff;
    return [0x7f, 0x00, len, cs, ...payloadBytes.map(b => b & 0xff)];
  }

  function buildSetTempHex(tempC) {
    const clampedC = Math.max(80, Math.min(96, Math.round(tempC)));
    const tempF = Math.round(clampedC * 1.8 + 32);
    return window.AppCore.bytesToHex(build7FCommand([0x16, tempF]));
  }

  function buildSetProfileHex(flow, preSec, soakSec, extSec) {
    const f = Math.max(1, Math.min(15, Math.round(flow)));
    const p = Math.max(0, Math.min(10, Math.round(preSec)));
    const s = Math.max(0, Math.min(10, Math.round(soakSec)));
    const e = Math.max(30, Math.min(250, Math.round(extSec)));
    return window.AppCore.bytesToHex(build7FCommand([0x18, f, p, s, e]));
  }

  const DEFAULT_MACHINE_CFG = {
    serviceUuid: '0000fff0-0000-1000-8000-00805f9b34fb',
    writeUuid: '0000fff2-0000-1000-8000-00805f9b34fb',
    writeMode: 'withoutResponse',
    cmdStart: '7F 00 07 8B 02 02 01',
    cmdStop: '7F 00 07 8A 02 02 00',
    cmdHeatBrewStart: '7F 00 07 8A 02 01 01',
    cmdHeatBrewStop: '7F 00 07 89 02 01 00',
    cmdHeatOn: '7F 00 07 89 02 00 01',
    cmdHeatOff: '7F 00 07 88 02 00 00'
  };

  let machineCfg = { ...DEFAULT_MACHINE_CFG };
  try {
    const saved = JSON.parse(localStorage.getItem('cera_cm03smax_ble_cfg_v6') || 'null');
    if (saved) machineCfg = { ...DEFAULT_MACHINE_CFG, ...saved };
  } catch (e) {}

  let machineDevice = null;
  let machineWriteChar = null;
  let machineCharRegistry = new Map();
  let isMachineConnected = false;
  let isHeaterOn = false;
  let currentMachineTemp = 25;
  let brewMode = 'immediate';
  let isMachineSynced = false;
  let isMachineCfgCollapsed = false;

  let currentWeight = 0.0;
  let targetYield = 36.0;
  let doseWeight = 18.0;
  let dripOffset = -1.2;
  let targetTemp = 92;
  let flowSpeed = 7;
  let preInfuseSec = 3;
  let soakSec = 1;
  let extractTimeSec = 50;

  let isBrewing = false;
  let isWaitingForHeat = false;
  let isWaitingFirstDrop = false;
  let firstDropSec = null;
  let flowSamples = [];
  let autoStopTriggered = false;
  let brewStartTime = null;
  let elapsedSec = 0;
  let timerInterval = null;
  let simInterval = null;
  let lastWeight = 0.0;
  let lastWeightTime = Date.now();
  let currentFlow = 0.0;
  let chartPoints = [];

  const CUSTOM_PRESETS_KEY = 'sepsep_custom_presets_v1';
  let activePresetIdx = null;
  let editingPresetIdx = 0;
  let customPresets = [null, null, null];
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || 'null');
    if (Array.isArray(raw) && raw.length === 3) customPresets = raw;
  } catch (e) {}

  const SHOT_LOG_KEY = 'cera_pcm03smax_dot_shots_v1';
  let lastAutoSavedShotId = null;

  function setMachineSyncState(synced) {
    isMachineSynced = synced;
    const badge = document.getElementById('machineSyncBadge');
    const dot = document.getElementById('machineSyncDot');
    if (synced) {
      badge.className = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/40 text-[10px] font-bold text-emerald-300 whitespace-nowrap';
      dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399] shrink-0';
    } else {
      badge.className = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-gray-800/80 border border-gray-700/70 text-[10px] font-semibold text-gray-500 whitespace-nowrap';
      dot.className = 'w-1.5 h-1.5 rounded-full bg-gray-600 shrink-0';
    }
  }

  function markManualEdit(affectsMachineCfg = true) {
    if (activePresetIdx !== null) {
      activePresetIdx = null;
      renderCustomPresets();
    }
    if (affectsMachineCfg) setMachineSyncState(false);
  }

  function updateBrewModeUi() {
    const modeImmediateBtn = document.getElementById('modeImmediateBtn');
    const modeHeatBrewBtn = document.getElementById('modeHeatBrewBtn');
    const tempCard = document.getElementById('targetTempCard');
    const tempHint = document.getElementById('tempModeHint');
    if (brewMode === 'immediate') {
      modeImmediateBtn.className = 'py-1 px-2 rounded-lg bg-orange-500/20 text-orange-300 border border-orange-500/40 text-[11px] font-bold whitespace-nowrap btn-press';
      modeHeatBrewBtn.className = 'py-1 px-2 rounded-lg text-gray-400 hover:text-gray-200 border border-transparent text-[11px] font-semibold whitespace-nowrap btn-press';
      tempCard.classList.add('opacity-55');
      tempHint.textContent = '현재수온(미적용)';
      tempHint.className = 'text-[9px] px-1 rounded bg-gray-800 text-gray-400 whitespace-nowrap';
    } else {
      modeHeatBrewBtn.className = 'py-1 px-2 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[11px] font-bold whitespace-nowrap btn-press';
      modeImmediateBtn.className = 'py-1 px-2 rounded-lg text-gray-400 hover:text-gray-200 border border-transparent text-[11px] font-semibold whitespace-nowrap btn-press';
      tempCard.classList.remove('opacity-55');
      tempHint.textContent = '도달 후 추출';
      tempHint.className = 'text-[9px] px-1 rounded bg-amber-500/20 text-amber-300 whitespace-nowrap';
    }
  }

  function renderCustomPresets() {
    const grid = document.getElementById('customPresetsGrid');
    grid.innerHTML = customPresets.map((p, idx) => {
      const isSaved = Boolean(p);
      const isActive = isSaved && activePresetIdx === idx;
      if (!isSaved) {
        return `<button type="button" onclick="window.EspressoApp.openPresetModal(${idx})" class="rounded-xl border border-dashed border-gray-700 bg-[#0c0e12]/70 px-2 py-1.5 flex items-center justify-between gap-1 min-w-0 btn-press"><span class="text-[10px] font-bold text-gray-400">P${idx + 1}</span><span class="text-[10px] text-gray-500">+ 저장</span></button>`;
      }
      return `<div class="rounded-xl border ${isActive ? 'border-orange-500 bg-orange-500/15' : 'border-emerald-500/40 bg-[#0e1319]'} px-1.5 py-1 flex items-center justify-between gap-1 min-w-0 transition"><button type="button" onclick="window.EspressoApp.applyPreset(${idx})" class="flex items-center gap-1 min-w-0 flex-1 text-left"><span class="w-1.5 h-1.5 rounded-full ${isActive ? 'bg-orange-400' : 'bg-emerald-400'} shrink-0"></span><span class="text-[10px] font-bold ${isActive ? 'text-orange-200' : 'text-white'} truncate">${p.name}</span></button><button type="button" onclick="window.EspressoApp.openPresetModal(${idx})" class="text-[9px] px-1 py-0.5 rounded bg-gray-800/90 hover:bg-gray-700 text-amber-300 font-semibold shrink-0">저장</button></div>`;
    }).join('');
  }

  function updateAllDisplays() {
    const safeWeight = Math.max(0, currentWeight);
    document.getElementById('weightDisplay').textContent = safeWeight.toFixed(1);
    document.getElementById('targetYieldDisplay').textContent = `${targetYield.toFixed(1)}g`;
    document.getElementById('doseDisplay').textContent = `${doseWeight.toFixed(1)}g`;
    document.getElementById('dripOffsetDisplay').textContent = `${dripOffset > 0 ? '+' : ''}${dripOffset.toFixed(1)}g`;
    document.getElementById('targetTempDisplay').textContent = `${targetTemp}°C`;
    document.getElementById('flowSpeedDisplay').textContent = `${flowSpeed} / 15`;
    document.getElementById('flowSpeedSlider').value = flowSpeed;
    document.getElementById('preInfuseDisplay').textContent = `${preInfuseSec}초`;
    document.getElementById('soakDisplay').textContent = `${soakSec}초`;
    document.getElementById('extTimeDisplay').textContent = `${extractTimeSec}초`;
    document.getElementById('flowDisplay').textContent = `${Math.max(0, currentFlow).toFixed(1)} g/s`;

    const ratio = doseWeight > 0 ? (safeWeight / doseWeight).toFixed(1) : '0.0';
    document.getElementById('ratioDisplay').textContent = `1:${ratio}`;
    const pct = targetYield > 0 ? Math.min(100, (safeWeight / targetYield) * 100) : 0;
    document.getElementById('targetProgressBar').style.width = `${pct}%`;

    if (isMachineConnected) {
      document.getElementById('machineTempBadge').textContent = `${Math.round(currentMachineTemp)}°C`;
    }
  }

  function resizeChart() {
    const canvas = document.getElementById('shotChart');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawChart();
  }

  function drawChart() {
    const canvas = document.getElementById('shotChart');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (w === 0 || h === 0) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 2; i++) {
      const y = (h / 3) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    const maxW = Math.max(targetYield * 1.15, 45);
    const targetY = h - (targetYield / maxW) * (h - 12) - 6;
    ctx.strokeStyle = 'rgba(249, 115, 22, 0.45)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, targetY); ctx.lineTo(w, targetY); ctx.stroke();
    ctx.setLineDash([]);

    if (chartPoints.length < 2) return;
    const maxFlow = 6;
    ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2; ctx.beginPath();
    chartPoints.forEach((pt, idx) => {
      const x = (idx / Math.max(chartPoints.length - 1, 1)) * w;
      const y = h - (Math.min(pt.f, maxFlow) / maxFlow) * (h - 12) - 6;
      idx === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.strokeStyle = '#fb923c'; ctx.lineWidth = 2.5; ctx.beginPath();
    chartPoints.forEach((pt, idx) => {
      const x = (idx / Math.max(chartPoints.length - 1, 1)) * w;
      const y = h - (Math.min(pt.w, maxW) / maxW) * (h - 12) - 6;
      idx === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function handleWeight(newW, reportedFlow = null) {
    const now = Date.now();
    if (reportedFlow !== null) {
      currentFlow = Math.max(0, reportedFlow);
    } else {
      const dt = (now - lastWeightTime) / 1000;
      if (dt >= 0.15) {
        const rawFlow = (newW - lastWeight) / dt;
        currentFlow = rawFlow > 0.05 ? rawFlow : 0.0;
        lastWeight = newW;
        lastWeightTime = now;
      }
    }
    currentWeight = newW;
    updateAllDisplays();

    if (isBrewing) {
      if (isWaitingForHeat && newW >= 0.3) {
        isWaitingForHeat = false;
        brewStartTime = Date.now();
      }
      if (isWaitingFirstDrop && !isWaitingForHeat && newW >= 0.3) {
        isWaitingFirstDrop = false;
        brewStartTime = Date.now();
        firstDropSec = 0;
        window.AppCore.playAlert('step');
      } else if (!isWaitingForHeat && firstDropSec === null && newW >= 0.3) {
        firstDropSec = elapsedSec;
      }
      if (!isWaitingForHeat && !isWaitingFirstDrop && currentFlow > 0.05) {
        flowSamples.push(currentFlow);
      }
      chartPoints.push({ t: elapsedSec, w: Math.max(0, currentWeight), f: currentFlow });
      if (chartPoints.length > 180) chartPoints.shift();
      drawChart();

      const autoStopEnabled = document.getElementById('autoStopToggle').checked;
      const stopThreshold = Math.max(1.0, targetYield + dripOffset);
      if (autoStopEnabled && !autoStopTriggered && currentWeight >= stopThreshold) {
        autoStopTriggered = true;
        window.AppCore.playAlert('done');
        window.AppCore.logPacket('AUTO-STOP', `목표 도달 (${currentWeight.toFixed(1)}g >= ${stopThreshold.toFixed(1)}g)`);
        stopExtraction(true);
      }
    }
  }

  function parseMachineStatusRx(bytes) {
    if (bytes.length >= 11 && bytes[0] === 0x7e && bytes[1] === 0x00 && bytes[4] === 0x00 && bytes[5] === 0x01) {
      const bat = bytes[6], tempC = bytes[8], state = bytes[9];
      if (tempC > 0 && tempC < 120) {
        currentMachineTemp = tempC;
        document.getElementById('machineTempBadge').textContent = `${tempC}°C`;
      }
      if (bat >= 0 && bat <= 100) document.getElementById('machineBatteryBadge').textContent = `${bat}%`;
      if (isBrewing && isWaitingForHeat && state === 0x03) {
        isWaitingForHeat = false;
        brewStartTime = Date.now();
        elapsedSec = 0;
      }
      const heatBtn = document.getElementById('heaterToggleBtn');
      if (state === 0x05 && !isHeaterOn) {
        isHeaterOn = true;
        heatBtn.textContent = '🔥 가열 중지';
        heatBtn.className = 'px-2.5 py-1 rounded-xl bg-rose-500/25 text-rose-300 border border-rose-500/50 text-[11px] font-bold whitespace-nowrap shrink-0 btn-press';
      } else if (state === 0x00 && isHeaterOn) {
        isHeaterOn = false;
        heatBtn.textContent = '🔥 가열 시작';
        heatBtn.className = 'px-2.5 py-1 rounded-xl bg-orange-500/20 hover:bg-orange-500/30 text-orange-300 border border-orange-500/40 text-[11px] font-bold whitespace-nowrap shrink-0 btn-press';
      }
      const mCard = document.getElementById('connectMachineBtn');
      mCard.style.borderColor = state === 0x05 ? 'rgba(249,115,22,0.7)' : state === 0x03 ? 'rgba(34,211,238,0.7)' : 'rgba(52,211,153,0.45)';
    }
    if (bytes.length >= 13 && bytes[0] === 0x7e && bytes[4] === 0x17) {
      const f = bytes[5], p = bytes[6], s = bytes[9], e = bytes[12];
      if (f >= 1 && f <= 15) flowSpeed = f;
      if (p >= 0 && p <= 10) preInfuseSec = p;
      if (s >= 0 && s <= 10) soakSec = s;
      if (e >= 30 && e <= 250) extractTimeSec = e;
      setMachineSyncState(true);
      updateAllDisplays();
    }
    if (bytes.length >= 8 && bytes[0] === 0x7e && bytes[4] === 0x15) {
      const tempC = Math.round((bytes[7] - 32) / 1.8);
      if (tempC >= 80 && tempC <= 96) {
        targetTemp = tempC;
        updateAllDisplays();
      }
    }
  }

  async function sendMachineCommand(hexStr, label) {
    const bytes = window.AppCore.hexStringToBytes(hexStr);
    if (!bytes) return false;
    window.AppCore.logPacket('TX -> MACHINE', `${label}: ${window.AppCore.bytesToHex(bytes)}`);
    if (!isMachineConnected || !machineWriteChar) {
      window.AppCore.showToast('⚠️ PCM03S Max 머신이 연결되지 않았습니다.');
      return false;
    }
    try {
      const mode = machineCfg.writeMode || 'withoutResponse';
      if (mode === 'withResponse' && machineWriteChar.properties.write) await machineWriteChar.writeValueWithResponse(bytes);
      else if (mode === 'withoutResponse' && machineWriteChar.properties.writeWithoutResponse) await machineWriteChar.writeValueWithoutResponse(bytes);
      else if (machineWriteChar.properties.writeWithoutResponse) await machineWriteChar.writeValueWithoutResponse(bytes);
      else await machineWriteChar.writeValueWithResponse(bytes);
      return true;
    } catch (err) {
      window.AppCore.showToast(`신호 전송 오류: ${err.message}`);
      return false;
    }
  }

  async function scanGatt(server) {
    const services = await server.getPrimaryServices();
    machineCharRegistry.clear();
    let autoWrite = null, autoSvc = '';
    for (const svc of services) {
      try {
        const chars = await svc.getCharacteristics();
        for (const c of chars) {
          const props = [];
          if (c.properties.write) props.push('WRITE');
          if (c.properties.writeWithoutResponse) props.push('W_NO_RESP');
          if (c.properties.notify) props.push('NOTIFY');
          if (c.properties.indicate) props.push('INDICATE');
          if (c.properties.read) props.push('READ');
          let notifying = false;
          if (c.properties.notify || c.properties.indicate) {
            try {
              await c.startNotifications();
              c.addEventListener('characteristicvaluechanged', (ev) => {
                const b = new Uint8Array(ev.target.value.buffer);
                parseMachineStatusRx(b);
                window.AppCore.logPacket(`RX <- ${c.uuid.slice(4, 8).toUpperCase()}`, window.AppCore.bytesToHex(b));
              });
              notifying = true;
            } catch (e) {}
          }
          machineCharRegistry.set(c.uuid, { char: c, serviceUuid: svc.uuid, props: props.length ? props : ['NONE'], notifying });
          if (machineCfg.writeUuid && c.uuid.toLowerCase() === machineCfg.writeUuid.trim().toLowerCase() && (c.properties.write || c.properties.writeWithoutResponse)) {
            autoWrite = c; autoSvc = svc.uuid;
          } else if (!autoWrite && (c.properties.write || c.properties.writeWithoutResponse) && !svc.uuid.startsWith('00001800') && !svc.uuid.startsWith('00001801')) {
            autoWrite = c; autoSvc = svc.uuid;
          }
        }
      } catch (e) {}
    }
    if (autoWrite) {
      machineWriteChar = autoWrite;
      machineCfg.serviceUuid = autoSvc;
      machineCfg.writeUuid = autoWrite.uuid;
    }
    renderGattList();
  }

  function renderGattList() {
    const box = document.getElementById('discoveredUuidList');
    if (machineCharRegistry.size === 0) { box.textContent = '검색된 특성 없음'; return; }
    box.innerHTML = Array.from(machineCharRegistry.entries()).map(([uuid, entry]) => {
      const sel = machineWriteChar && machineWriteChar.uuid === uuid;
      const canW = entry.props.includes('WRITE') || entry.props.includes('W_NO_RESP');
      return `<div class="p-2 rounded-lg bg-[#0d1016] border ${sel ? 'border-orange-500/70' : 'border-gray-800'} flex items-center justify-between gap-2"><div class="min-w-0"><div class="mono-num text-[10px] font-bold ${sel ? 'text-orange-300' : 'text-gray-200'} truncate">${uuid.slice(4, 8).toUpperCase()}</div><div class="text-[9px] text-cyan-300">${entry.props.join(' · ')} ${entry.notifying ? '· 🔔구독' : ''}</div></div>${canW ? `<button type="button" onclick="window.EspressoApp.selectWriteChar('${uuid}')" class="px-2 py-0.5 rounded ${sel ? 'bg-orange-500 text-gray-950 font-bold' : 'bg-gray-800 text-orange-300'} text-[9px]">${sel ? '선택됨' : '선택'}</button>` : ''}</div>`;
    }).join('');
  }

  async function connectMachine(smartFilter = true) {
    if (isMachineConnected && machineDevice) { machineDevice.gatt.disconnect(); return; }
    if (!window.AppCore.checkBluetoothAvailability()) return;
    const opts = [0xfff0, 0xffe0, 0xffe5, 0xff00, 0x180a, 0x180f, '0000fff0-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb'];
    try {
      const req = smartFilter
        ? { filters: [{ namePrefix: 'Hi-t-' }, { namePrefix: 'CM03' }, { namePrefix: 'PCM03' }, { namePrefix: 'CERA' }], optionalServices: opts }
        : { acceptAllDevices: true, optionalServices: opts };
      machineDevice = await navigator.bluetooth.requestDevice(req);
      document.getElementById('machineStatusText').textContent = '연결 중...';
      const server = await machineDevice.gatt.connect();
      await scanGatt(server);
      isMachineConnected = true;
      document.getElementById('machineDot').className = 'w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399] shrink-0';
      document.getElementById('machineStatusText').textContent = machineDevice.name || '연결됨';
      document.getElementById('connectMachineBtn').style.borderColor = 'rgba(52, 211, 153, 0.45)';
      window.AppCore.showToast(`${machineDevice.name || '머신'} 연결 완료`);
      await sendMachineCommand('7F 00 05 99 15', '목표 온도 조회');
      await sendMachineCommand('7F 00 05 9B 17', '추출 프로파일 조회');
      await sendMachineCommand('7F 00 05 84 00', '실시간 상태 조회');

      machineDevice.addEventListener('gattserverdisconnected', () => {
        isMachineConnected = false; machineWriteChar = null;
        document.getElementById('machineDot').className = 'w-2 h-2 rounded-full bg-gray-600 shrink-0';
        document.getElementById('machineStatusText').textContent = '연결 끊김';
        document.getElementById('machineTempBadge').textContent = '--°C';
        document.getElementById('machineBatteryBadge').textContent = '--%';
        document.getElementById('connectMachineBtn').style.borderColor = '';
        setMachineSyncState(false);
      });
    } catch (err) {
      if (err.name !== 'NotFoundError') window.AppCore.showToast(`머신 연결 실패: ${err.message}`);
    }
  }

  function setCollapsed(collapsed) {
    isMachineCfgCollapsed = collapsed;
    const body = document.getElementById('machineCfgBody');
    const btn = document.getElementById('toggleMachineCfgBtn');
    const summary = document.getElementById('machineCfgSummary');
    if (collapsed) {
      body.classList.add('hidden'); summary.classList.remove('hidden');
      summary.textContent = `${targetTemp}°C · 유량${flowSpeed} · 프리${preInfuseSec}s`;
      btn.textContent = '▼ 펼치기';
    } else {
      body.classList.remove('hidden'); summary.classList.add('hidden');
      btn.textContent = '▲ 접기';
    }
    setTimeout(resizeChart, 50);
  }

  async function startExtraction(isSim = false) {
    if (isBrewing) return;
    isBrewing = true; autoStopTriggered = false; lastAutoSavedShotId = null;
    document.getElementById('saveShotBtn').textContent = '샷 저장';
    chartPoints = [];
    setCollapsed(true);
    if (window.TimemoreDot.isConnected()) await window.TimemoreDot.tare();
    currentWeight = 0.0; lastWeight = 0.0;

    firstDropSec = null; flowSamples = [];
    isWaitingForHeat = (!isSim && brewMode === 'heatBrew' && isMachineConnected && currentMachineTemp < targetTemp - 1);
    isWaitingFirstDrop = document.getElementById('espFirstDropToggle').checked;
    brewStartTime = Date.now(); elapsedSec = 0;

    const btn = document.getElementById('brewActionBtn');
    const labelEl = document.getElementById('brewActionLabel');
    btn.className = 'col-span-6 py-2 px-2 rounded-2xl bg-rose-600 hover:bg-rose-500 text-white font-extrabold text-xs sm:text-sm shadow-lg shadow-rose-600/30 transition btn-press flex items-center justify-center min-w-0 overflow-hidden whitespace-nowrap';
    labelEl.innerHTML = isWaitingForHeat
      ? `<span>🔥 가열 중</span><span class="text-[11px] font-bold opacity-90">${Math.round(currentMachineTemp)}/${targetTemp}°C</span>`
      : isWaitingFirstDrop
        ? `<span>💧 첫방울 대기</span><span class="text-[11px] font-bold opacity-90">00:00</span>`
        : `<span>⏹ 정지</span><span class="text-[11px] font-bold opacity-90">00:00</span>`;

    if (!isSim) {
      await sendMachineCommand(brewMode === 'heatBrew' ? machineCfg.cmdHeatBrewStart : machineCfg.cmdStart, '추출 시작');
    }

    timerInterval = setInterval(() => {
      const badge = document.getElementById('brewPhaseBadge');
      if (isWaitingForHeat) {
        labelEl.innerHTML = `<span>🔥 가열 중</span><span class="text-[11px] font-bold opacity-90">${Math.round(currentMachineTemp)}/${targetTemp}°C</span>`;
        badge.textContent = `목표 온도 가열 중 (${Math.round(currentMachineTemp)}°C)`;
        return;
      }
      if (isWaitingFirstDrop) {
        labelEl.innerHTML = `<span>💧 첫방울 대기</span><span class="text-[11px] font-bold opacity-90">00:00</span>`;
        badge.textContent = '첫 방울(0.3g) 대기 중...';
        return;
      }
      elapsedSec = Math.floor((Date.now() - brewStartTime) / 1000);
      labelEl.innerHTML = `<span>⏹ 정지</span><span class="text-[11px] font-bold opacity-90">${window.AppCore.formatTime(elapsedSec)}</span>`;
      if (elapsedSec < preInfuseSec) badge.textContent = `프리인퓨전 (${elapsedSec + 1}/${preInfuseSec}초)`;
      else if (elapsedSec < preInfuseSec + soakSec) badge.textContent = `블루밍 대기 (${elapsedSec - preInfuseSec + 1}/${soakSec}초)`;
      else badge.textContent = '본 추출 진행 중';
    }, 250);
  }

  async function stopExtraction(byAutoStop = false) {
    if (!isBrewing) return;
    isBrewing = false; isWaitingForHeat = false; isWaitingFirstDrop = false;
    clearInterval(timerInterval); clearInterval(simInterval); simInterval = null;
    if (isMachineConnected) {
      await sendMachineCommand(brewMode === 'heatBrew' ? machineCfg.cmdHeatBrewStop : machineCfg.cmdStop, '추출 정지');
    }
    const btn = document.getElementById('brewActionBtn');
    btn.className = 'col-span-6 py-2 px-2 rounded-2xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-gray-950 font-extrabold text-xs sm:text-sm shadow-lg shadow-orange-500/25 transition btn-press flex items-center justify-center min-w-0 overflow-hidden whitespace-nowrap';
    document.getElementById('brewActionLabel').textContent = '▶ 추출 시작';

    const autoSaved = maybeAutoSaveShot();
    const badge = document.getElementById('brewPhaseBadge');
    badge.textContent = byAutoStop ? '🎯 목표 도달 자동 정지됨' : '추출 정지됨';
    window.AppCore.showToast(byAutoStop
      ? `🎯 목표 도달 자동 정지 (${currentWeight.toFixed(1)}g)${autoSaved ? ' · 샷 자동 저장됨' : ''}`
      : `추출 정지 (${currentWeight.toFixed(1)}g)${autoSaved ? ' · 샷 자동 저장됨' : ''}`);
  }

  function buildShotEntry(isAuto) {
    const yieldVal = Math.max(0, +currentWeight.toFixed(1));
    const note = document.getElementById('shotNoteInput').value.trim() ||
      (activePresetIdx !== null && customPresets[activePresetIdx] ? customPresets[activePresetIdx].name : '') ||
      (isAuto ? '자동 기록 샷' : '에스프레소 샷');
    return {
      id: Date.now(), type: 'espresso',
      date: new Date().toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      note, dose: doseWeight, yield: yieldVal, target: targetYield,
      timeStr: window.AppCore.formatTime(elapsedSec),
      ratio: doseWeight > 0 ? `1:${(yieldVal / doseWeight).toFixed(1)}` : '1:0.0',
      temp: targetTemp, flowSpeed, preInfuse: preInfuseSec, soak: soakSec,
      firstDropSec: firstDropSec !== null ? firstDropSec : undefined,
      avgFlow: flowSamples.length ? +(flowSamples.reduce((a, b) => a + b, 0) / flowSamples.length).toFixed(2) : undefined
    };
  }

  function maybeAutoSaveShot() {
    if (!window.AppCore.isAutoSaveEnabled()) return false;
    if (currentWeight < 0.5 && elapsedSec < 2) return false;
    const entry = buildShotEntry(true);
    const logs = window.AppCore.getLogs(SHOT_LOG_KEY);
    logs.unshift(entry);
    window.AppCore.setLogs(SHOT_LOG_KEY, logs);
    lastAutoSavedShotId = entry.id;
    document.getElementById('saveShotBtn').textContent = '메모 반영';
    return true;
  }

  function saveManualOrUpdateShot() {
    const input = document.getElementById('shotNoteInput');
    const note = input.value.trim();
    if (lastAutoSavedShotId !== null) {
      const logs = window.AppCore.getLogs(SHOT_LOG_KEY);
      const idx = logs.findIndex(x => x.id === lastAutoSavedShotId);
      if (idx !== -1) {
        if (!note) { window.AppCore.showToast('수정할 메모를 입력해 주세요.'); return; }
        logs[idx].note = note;
        window.AppCore.setLogs(SHOT_LOG_KEY, logs);
        input.value = '';
        window.AppCore.showToast(`✏️ 샷 메모를 '${note}'로 반영했습니다.`);
        return;
      }
    }
    if (currentWeight <= 0.3 && elapsedSec === 0) { window.AppCore.showToast('저장할 추출 데이터가 없습니다.'); return; }
    const entry = buildShotEntry(false);
    const logs = window.AppCore.getLogs(SHOT_LOG_KEY);
    logs.unshift(entry);
    window.AppCore.setLogs(SHOT_LOG_KEY, logs);
    input.value = '';
    window.AppCore.showToast(`✅ '${entry.note}' 저장 완료`);
  }

  function init() {
    window.TimemoreDot.onWeight((w, f) => {
      if (window.AppCore.getActiveTab() === 'espresso') handleWeight(w, f);
    });

    document.getElementById('connectMachineBtn').addEventListener('click', () => connectMachine(true));
    document.getElementById('toggleMachineCfgBtn').addEventListener('click', () => setCollapsed(!isMachineCfgCollapsed));
    document.getElementById('modeImmediateBtn').addEventListener('click', () => { brewMode = 'immediate'; updateBrewModeUi(); });
    document.getElementById('modeHeatBrewBtn').addEventListener('click', () => { brewMode = 'heatBrew'; updateBrewModeUi(); });

    document.getElementById('targetMinusBtn').addEventListener('click', () => { targetYield = Math.max(5, +(targetYield - 0.5).toFixed(1)); markManualEdit(false); updateAllDisplays(); drawChart(); });
    document.getElementById('targetPlusBtn').addEventListener('click', () => { targetYield = Math.min(200, +(targetYield + 0.5).toFixed(1)); markManualEdit(false); updateAllDisplays(); drawChart(); });
    document.getElementById('doseMinusBtn').addEventListener('click', () => { doseWeight = Math.max(5, +(doseWeight - 0.5).toFixed(1)); markManualEdit(false); updateAllDisplays(); });
    document.getElementById('dosePlusBtn').addEventListener('click', () => { doseWeight = Math.min(40, +(doseWeight + 0.5).toFixed(1)); markManualEdit(false); updateAllDisplays(); });
    document.getElementById('espApplyDoseBtn').addEventListener('click', () => {
      if (currentWeight < 3 || currentWeight > 45) { window.AppCore.showToast('원두 무게(3~45g)를 저울에 올려주세요.'); return; }
      doseWeight = +currentWeight.toFixed(1);
      markManualEdit(false); updateAllDisplays();
      window.AppCore.playAlert('step');
      window.AppCore.showToast(`🫘 원두 도징 ${doseWeight.toFixed(1)}g 적용됨`);
    });
    document.getElementById('offsetMinusBtn').addEventListener('click', () => { dripOffset = Math.max(-5, +(dripOffset - 0.2).toFixed(1)); updateAllDisplays(); });
    document.getElementById('offsetPlusBtn').addEventListener('click', () => { dripOffset = Math.min(2, +(dripOffset + 0.2).toFixed(1)); updateAllDisplays(); });

    document.getElementById('tempMinusBtn').addEventListener('click', () => { targetTemp = Math.max(80, targetTemp - 1); markManualEdit(true); updateAllDisplays(); });
    document.getElementById('tempPlusBtn').addEventListener('click', () => { targetTemp = Math.min(96, targetTemp + 1); markManualEdit(true); updateAllDisplays(); });
    document.getElementById('flowSpeedSlider').addEventListener('input', (e) => { flowSpeed = Number(e.target.value); document.getElementById('flowSpeedDisplay').textContent = `${flowSpeed} / 15`; markManualEdit(true); });
    document.getElementById('preMinusBtn').addEventListener('click', () => { preInfuseSec = Math.max(0, preInfuseSec - 1); markManualEdit(true); updateAllDisplays(); });
    document.getElementById('prePlusBtn').addEventListener('click', () => { preInfuseSec = Math.min(10, preInfuseSec + 1); markManualEdit(true); updateAllDisplays(); });
    document.getElementById('soakMinusBtn').addEventListener('click', () => { soakSec = Math.max(0, soakSec - 1); markManualEdit(true); updateAllDisplays(); });
    document.getElementById('soakPlusBtn').addEventListener('click', () => { soakSec = Math.min(10, soakSec + 1); markManualEdit(true); updateAllDisplays(); });
    document.getElementById('extMinusBtn').addEventListener('click', () => { extractTimeSec = Math.max(30, extractTimeSec - 5); markManualEdit(true); updateAllDisplays(); });
    document.getElementById('extPlusBtn').addEventListener('click', () => { extractTimeSec = Math.min(250, extractTimeSec + 5); markManualEdit(true); updateAllDisplays(); });

    document.getElementById('syncMachineCfgBtn').addEventListener('click', async () => {
      activePresetIdx = null; renderCustomPresets();
      const ok1 = await sendMachineCommand(buildSetTempHex(targetTemp), `온도(${targetTemp}°C)`);
      const ok2 = await sendMachineCommand(buildSetProfileHex(flowSpeed, preInfuseSec, soakSec, extractTimeSec), '프로파일');
      if (ok1 && ok2) { setMachineSyncState(true); window.AppCore.showToast(`✅ 머신 저장 완료`); }
    });

    document.getElementById('heaterToggleBtn').addEventListener('click', async () => {
      isHeaterOn = !isHeaterOn;
      const btn = document.getElementById('heaterToggleBtn');
      btn.textContent = isHeaterOn ? '🔥 가열 중지' : '🔥 가열 시작';
      btn.className = isHeaterOn
        ? 'px-2.5 py-1 rounded-xl bg-rose-500/25 text-rose-300 border border-rose-500/50 text-[11px] font-bold whitespace-nowrap shrink-0 btn-press'
        : 'px-2.5 py-1 rounded-xl bg-orange-500/20 hover:bg-orange-500/30 text-orange-300 border border-orange-500/40 text-[11px] font-bold whitespace-nowrap shrink-0 btn-press';
      await sendMachineCommand(isHeaterOn ? machineCfg.cmdHeatOn : machineCfg.cmdHeatOff, isHeaterOn ? '가열 시작' : '가열 중지');
    });

    document.getElementById('tareScaleBtn').addEventListener('click', () => {
      currentWeight = 0; lastWeight = 0; currentFlow = 0; updateAllDisplays();
      window.TimemoreDot.tare();
      window.AppCore.showToast('저울 영점(0.0g) 조절됨');
    });
    document.getElementById('brewActionBtn').addEventListener('click', () => isBrewing ? stopExtraction(false) : startExtraction(false));
    document.getElementById('resetAllBtn').addEventListener('click', () => {
      if (isBrewing) stopExtraction(false);
      elapsedSec = 0; currentFlow = 0; autoStopTriggered = false; lastAutoSavedShotId = null; chartPoints = [];
      document.getElementById('saveShotBtn').textContent = '샷 저장';
      document.getElementById('brewActionLabel').textContent = '▶ 추출 시작';
      document.getElementById('brewPhaseBadge').textContent = '대기 중';
      updateAllDisplays(); drawChart();
    });

    document.getElementById('simEspressoBtn').addEventListener('click', () => {
      if (isBrewing) { stopExtraction(false); return; }
      window.AppCore.showToast('에스프레소 시뮬레이션 시작');
      startExtraction(true);
      simInterval = setInterval(() => {
        if (!isBrewing) { clearInterval(simInterval); return; }
        handleWeight(+(currentWeight + (elapsedSec < preInfuseSec + soakSec ? 0.05 : 0.35)).toFixed(1));
      }, 200);
    });
    document.getElementById('saveShotBtn').addEventListener('click', saveManualOrUpdateShot);

    // Preset modal
    const pm = document.getElementById('presetSaveModal');
    document.getElementById('closePresetModalBtn').addEventListener('click', () => pm.classList.add('hidden'));
    document.getElementById('confirmPresetSaveBtn').addEventListener('click', () => {
      const name = document.getElementById('presetNameInput').value.trim() || `레시피 ${editingPresetIdx + 1}`;
      customPresets[editingPresetIdx] = { name, temp: targetTemp, flow: flowSpeed, pre: preInfuseSec, soak: soakSec, ext: extractTimeSec, target: targetYield, dose: doseWeight };
      activePresetIdx = editingPresetIdx;
      try { localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(customPresets)); } catch (e) {}
      renderCustomPresets(); pm.classList.add('hidden');
      window.AppCore.showToast(`✅ 프리셋 P${editingPresetIdx + 1} [${name}] 저장 완료`);
    });
    document.getElementById('clearPresetSlotBtn').addEventListener('click', () => {
      customPresets[editingPresetIdx] = null;
      if (activePresetIdx === editingPresetIdx) activePresetIdx = null;
      try { localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(customPresets)); } catch (e) {}
      renderCustomPresets(); pm.classList.add('hidden');
    });

    // BLE Config modal bindings
    document.getElementById('allDeviceScanBtn').addEventListener('click', () => { document.getElementById('bleConfigModal').classList.add('hidden'); connectMachine(false); });
    document.getElementById('rescanGattBtn').addEventListener('click', async () => { if (machineDevice && machineDevice.gatt.connected) await scanGatt(machineDevice.gatt); });
    document.getElementById('sendTestHexBtn').addEventListener('click', () => {
      const hx = document.getElementById('testHexInput').value.trim();
      if (hx) sendMachineCommand(hx, '수동 테스트');
    });
    document.querySelectorAll('.cs-append-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('testHexInput');
        const bytes = window.AppCore.hexStringToBytes(input.value.trim());
        if (!bytes) return;
        if (btn.dataset.mode === '7f') input.value = window.AppCore.bytesToHex(build7FCommand(Array.from(bytes)));
        else if (btn.dataset.mode === 'sum8') input.value = window.AppCore.bytesToHex([...bytes, bytes.reduce((a, b) => (a + b) & 0xff, 0)]);
      });
    });

    updateBrewModeUi();
    setMachineSyncState(false);
    renderCustomPresets();
    updateAllDisplays();
    resizeChart();
    window.addEventListener('resize', resizeChart);
  }

  return {
    init,
    resizeChart,
    getLogKey: () => SHOT_LOG_KEY,
    getCfg: () => machineCfg,
    setCfg: (next) => { machineCfg = { ...DEFAULT_MACHINE_CFG, ...next }; try { localStorage.setItem('cera_cm03smax_ble_cfg_v6', JSON.stringify(machineCfg)); } catch (e) {} },
    resetCfg: () => { machineCfg = { ...DEFAULT_MACHINE_CFG }; try { localStorage.removeItem('cera_cm03smax_ble_cfg_v6'); } catch (e) {} return machineCfg; },
    applyPreset: (idx) => {
      const p = customPresets[idx];
      if (!p) return;
      activePresetIdx = idx; targetTemp = p.temp; flowSpeed = p.flow; preInfuseSec = p.pre; soakSec = p.soak; extractTimeSec = p.ext; targetYield = p.target; doseWeight = p.dose;
      setMachineSyncState(false); updateAllDisplays(); drawChart(); renderCustomPresets();
      window.AppCore.showToast(`프리셋 [${p.name}] 불러옴`);
    },
    openPresetModal: (idx) => {
      editingPresetIdx = idx;
      document.getElementById('presetModalTitle').textContent = `프리셋 P${idx + 1} 저장`;
      document.getElementById('presetSummaryBox').textContent = `온도 ${targetTemp}°C · 유량 ${flowSpeed} · 프리 ${preInfuseSec}s · 대기 ${soakSec}s · 추출 ${extractTimeSec}s · 도징 ${doseWeight}g → 목표 ${targetYield}g`;
      document.getElementById('presetNameInput').value = customPresets[idx] ? customPresets[idx].name : `레시피 ${idx + 1}`;
      document.getElementById('presetSaveModal').classList.remove('hidden');
    },
    selectWriteChar: (uuid) => {
      const entry = machineCharRegistry.get(uuid);
      if (entry) { machineWriteChar = entry.char; machineCfg.writeUuid = uuid; renderGattList(); }
    }
  };
})();
