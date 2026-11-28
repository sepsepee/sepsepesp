// ============================================================================
// timemore-dot.js — Timemore Dot (TES017) 공식 BLE 드라이버 (open-scale-protocol v1.0.3)
// ============================================================================
window.TimemoreDot = (function () {
  const SERVICE_UUID = 0xfff0;
  const CMD = {
    TARE: new Uint8Array([0xa5, 0x5a, 0x03, 0x0d, 0x00, 0x00, 0x64, 0xd1]),
    TIMER_START: new Uint8Array([0xa5, 0x5a, 0x03, 0x02, 0x00, 0x01, 0x01, 0x18, 0x67]),
    TIMER_STOP: new Uint8Array([0xa5, 0x5a, 0x03, 0x02, 0x00, 0x01, 0x02, 0x19, 0x27]),
    TIMER_RESET: new Uint8Array([0xa5, 0x5a, 0x03, 0x02, 0x00, 0x01, 0x03, 0xd9, 0xe6]),
    INIT_UNIT_G: new Uint8Array([0xa5, 0x5a, 0x03, 0x06, 0x00, 0x01, 0x00, 0xe8, 0xa7]),
    INIT_MODE_STD: new Uint8Array([0xa5, 0x5a, 0x03, 0x08, 0x00, 0x02, 0x01, 0x00, 0xeb, 0x31]),
    REQ_BATTERY: new Uint8Array([0xa5, 0x5a, 0x02, 0x05, 0x00, 0x00, 0x5a, 0x51])
  };

  let device = null;
  let cmdChar = null;
  let isConnected = false;
  let rxBuffer = [];
  const weightListeners = new Set();

  function emitWeight(weightG, flowGs, hwTimerSec) {
    weightListeners.forEach((fn) => {
      try { fn(weightG, flowGs, hwTimerSec); } catch (e) {}
    });
  }

  function parseDotStream(chunk) {
    for (const b of chunk) rxBuffer.push(b);
    while (rxBuffer.length >= 8) {
      const hdrIdx = rxBuffer.findIndex((_, i) => i + 1 < rxBuffer.length && rxBuffer[i] === 0xa5 && rxBuffer[i + 1] === 0x5a);
      if (hdrIdx === -1) {
        rxBuffer = rxBuffer.slice(-1);
        return;
      }
      if (hdrIdx > 0) rxBuffer = rxBuffer.slice(hdrIdx);
      if (rxBuffer.length < 8) return;

      const opcode = rxBuffer[2];
      const cmd = rxBuffer[3];
      const payloadLen = (rxBuffer[4] << 8) | rxBuffer[5];
      const frameLen = 6 + payloadLen + 2;
      if (rxBuffer.length < frameLen) return;

      const frame = rxBuffer.slice(0, frameLen);
      rxBuffer = rxBuffer.slice(frameLen);

      if ((opcode === 0x01 || opcode === 0x02) && cmd === 0x01 && payloadLen >= 9) {
        const dv = new DataView(new Uint8Array(frame).buffer);
        const weightRaw = dv.getInt32(6, false);
        const flowRaw = dv.getInt16(10, false);
        const timerSec = dv.getUint16(12, false);
        emitWeight(weightRaw / 10.0, flowRaw / 10.0, timerSec);
      } else if ((opcode === 0x01 || opcode === 0x02) && cmd === 0x05 && payloadLen >= 2) {
        const pct = frame[7];
        if (pct >= 0 && pct <= 100) {
          const badge = document.getElementById('scaleBatteryBadge');
          if (badge) badge.textContent = `${pct}%`;
        }
      }
    }
  }

  async function writeCmd(packet, label) {
    if (!isConnected || !cmdChar) return false;
    try {
      await cmdChar.writeValueWithoutResponse(packet);
      if (window.AppCore) window.AppCore.logPacket('TX -> DOT', label);
      return true;
    } catch (e) {
      if (window.AppCore) window.AppCore.logPacket('DOT ERR', `${label}: ${e.message}`);
      return false;
    }
  }

  async function connect() {
    if (isConnected && device) {
      device.gatt.disconnect();
      return;
    }
    if (!window.AppCore || !window.AppCore.checkBluetoothAvailability()) return;

    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'TIMEMORE' },
          { namePrefix: 'Timemore' },
          { services: [SERVICE_UUID] }
        ],
        optionalServices: [SERVICE_UUID]
      });

      document.getElementById('scaleStatusText').textContent = '연결 중...';
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      const chars = await service.getCharacteristics();

      const notifyChar = chars.find(c => c.uuid.includes('fff1')) || chars.find(c => c.uuid.includes('fff4'));
      const writeChar = chars.find(c => c.uuid.includes('fff2')) || chars.find(c => c.uuid.includes('fff1') && (c.properties.write || c.properties.writeWithoutResponse));
      const isDotProtocol = Boolean(chars.find(c => c.uuid.includes('fff2')));

      if (!notifyChar) throw new Error('저울 Notify 채널을 찾지 못했습니다.');
      cmdChar = writeChar || null;
      rxBuffer = [];

      await notifyChar.startNotifications();
      notifyChar.addEventListener('characteristicvaluechanged', (e) => {
        const data = new Uint8Array(e.target.value.buffer);
        if (data.length >= 8 && data[0] === 0xa5 && data[1] === 0x5a) {
          parseDotStream(data);
        } else if (isDotProtocol && rxBuffer.length > 0) {
          parseDotStream(data);
        } else if (data.length >= 5) {
          let raw = data[1] | (data[2] << 8) | (data[3] << 16);
          if (raw & 0x800000) raw -= 0x1000000;
          emitWeight(raw / 10.0, null, null);
          if (data.length >= 6 && data[5] > 0 && data[5] <= 100) {
            document.getElementById('scaleBatteryBadge').textContent = `${data[5]}%`;
          }
        }
      });

      if (cmdChar && isDotProtocol) {
        try {
          await cmdChar.writeValueWithoutResponse(CMD.INIT_UNIT_G);
          await cmdChar.writeValueWithoutResponse(CMD.INIT_MODE_STD);
          await cmdChar.writeValueWithoutResponse(CMD.REQ_BATTERY);
        } catch (e) {}
      }

      isConnected = true;
      document.getElementById('scaleDot').className = 'w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399] shrink-0';
      document.getElementById('connectScaleBtn').style.borderColor = 'rgba(52, 211, 153, 0.45)';
      document.getElementById('scaleStatusText').textContent = device.name || '연결됨';
      window.AppCore.logPacket('DOT', `Timemore Dot 연결 성공 (${isDotProtocol ? 'Dot A55A' : 'Legacy'})`);
      window.AppCore.showToast('Timemore Dot 저울이 연결되었습니다.');

      device.addEventListener('gattserverdisconnected', () => {
        isConnected = false;
        cmdChar = null;
        document.getElementById('scaleDot').className = 'w-2 h-2 rounded-full bg-gray-600 shrink-0';
        document.getElementById('scaleStatusText').textContent = '연결 끊김';
        document.getElementById('scaleBatteryBadge').textContent = '--%';
        document.getElementById('connectScaleBtn').style.borderColor = '';
        window.AppCore.logPacket('DOT', '저울 연결 해제됨');
      });
    } catch (err) {
      if (err.name !== 'NotFoundError') window.AppCore.showToast(`저울 연결 실패: ${err.message}`);
    }
  }

  return {
    connect,
    isConnected: () => isConnected,
    tare: () => writeCmd(CMD.TARE, '영점(TARE)'),
    timerStart: () => writeCmd(CMD.TIMER_START, '타이머 시작'),
    timerStop: () => writeCmd(CMD.TIMER_STOP, '타이머 정지'),
    timerReset: () => writeCmd(CMD.TIMER_RESET, '타이머 초기화'),
    onWeight: (fn) => weightListeners.add(fn)
  };
})();
