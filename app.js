// ToyDeck — control several Bluetooth toys at once (JoyHub-protocol toys).
//
// Protocol (from analysing the official app):
//   Service 0xFFA0; send every command to EVERY write-without-response characteristic in it.
//   Intensity:  A0 03 <slot1> <slot2> <slot3> <slot4> AA   (each 0-255; toys ignore shorter commands)
//   Stop all:   A0 03 00 00 00 00 AA
//   Extras:     A0 <fn> 01 00 01 FF = on, A0 <fn> 00 00 00 00 = off
//               fn: 04 heat, 14 lights, 07 suction, 0D squeeze, 25 wiggle, 24 squirt

const SERVICE = 0xffa0;
const TICK_MS = 100;            // how often patterns update
const KEEPALIVE_MS = 1000;      // resend the current level this often even if unchanged
const MIN_SLOTS = 4;            // toys expect at least 4 motor slots
const REC_STEP_MS = 100;        // recording resolution
const REC_MAX_MS = 30 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 10000;
const STOP_BYTES = new Uint8Array([0xa0, 0x03, 0, 0, 0, 0, 0xaa]);
// Heat is on/off only. Suction takes a level: A0 07 01 00 <level> FF (level count depends on the toy).
const HEAT_ON = 'a004010001ff';
const HEAT_OFF = 'a00400000000';
const SUCK_OFF = 'a00700000000';
const suckCmd = (level) => (level > 0 ? `a0070100${level.toString(16).padStart(2, '0')}ff` : SUCK_OFF);
const BATTERY_POLL_MS = 60000;
const EXTRAS = {
  light:   { on: 'a014010001ff', off: 'a01400000000' },
  squeeze: { on: 'a00d000001ff', off: 'a00d00000000' },
  wiggle:  { on: 'a025010001ff', off: 'a02500000000' },
  squirt:  { on: 'a024010001ff', off: 'a02400000000' },
};

// ---------- small helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hexToBytes = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('timed out'); })]);
const fmtTime = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};
const statusEl = $('#status');
let statusTimer;
function say(msg, sticky = false) {
  statusEl.textContent = msg;
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 6000);
}
// Two-tap confirm for destructive buttons (no browser dialogs).
function confirmTap(btn, label, action) {
  if (btn.dataset.armed) {
    delete btn.dataset.armed;
    btn.classList.remove('danger-confirm');
    action();
    return;
  }
  const original = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = label;
  btn.classList.add('danger-confirm');
  setTimeout(() => {
    if (!btn.dataset.armed) return;
    delete btn.dataset.armed;
    btn.textContent = original;
    btn.classList.remove('danger-confirm');
  }, 3000);
}

// ---------- patterns ----------
// Shared pattern: { id, name, stepMs, steps: [0..1, ...], builtin? }
// Recorded pattern (one toy only): { id, name, stepMs, tracks: [[motor1...], [motor2...]], toyKey, recorded: true }
function gen(n, f) { return Array.from({ length: n }, (_, i) => +clamp(f(i, n), 0, 1).toFixed(3)); }
function seeded(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }
const rnd = seeded(42);
const BUILTIN = [
  { id: 'steady', name: 'Steady', stepMs: 100, steps: [1] },
  { id: 'pulse', name: 'Pulse', stepMs: 100, steps: [1, 1, 1, 1, 1, 0, 0, 0, 0, 0] },
  { id: 'wave', name: 'Wave', stepMs: 100, steps: gen(30, (i, n) => 0.55 - 0.45 * Math.cos((2 * Math.PI * i) / n)) },
  { id: 'climb', name: 'Climb', stepMs: 100, steps: gen(50, (i, n) => 0.1 + (0.9 * i) / (n - 1)) },
  { id: 'heartbeat', name: 'Heartbeat', stepMs: 100, steps: [1, 0.3, 0.9, 0.2, 0, 0, 0, 0, 0, 0] },
  { id: 'stairs', name: 'Stairs', stepMs: 100, steps: gen(32, (i) => 0.25 * (Math.floor(i / 8) + 1)) },
  { id: 'tease', name: 'Tease', stepMs: 100, steps: gen(60, (i) => (i < 45 ? 0.15 + 0.6 * (i / 45) : i < 50 ? 1 : 0.05)) },
  { id: 'flutter', name: 'Flutter', stepMs: 50, steps: [0.9, 0.4, 0.9, 0.4, 0.9, 0.4, 0.7, 0.2] },
  { id: 'surge', name: 'Surge', stepMs: 100, steps: gen(40, (i, n) => Math.pow(Math.sin((Math.PI * i) / n), 3)) },
  { id: 'random', name: 'Random', stepMs: 150, steps: gen(64, () => 0.2 + 0.8 * rnd()) },
].map((p) => ({ ...p, builtin: true }));
let customPatterns = store.get('toydeck.patterns', []);
let recordings = store.get('toydeck.recordings', []);

const sharedPatterns = () => [...BUILTIN, ...customPatterns];
const patternsFor = (toy) => [...sharedPatterns(), ...recordings.filter((r) => r.toyKey === toy.key)];
const findPattern = (id) => [...sharedPatterns(), ...recordings].find((p) => p.id === id) ?? BUILTIN[0];
const patternLength = (p) => (p.tracks ? p.tracks[0].length : p.steps.length);
const patternValue = (p, motor, i) => {
  const track = p.tracks ? p.tracks[motor % p.tracks.length] : p.steps;
  return track[i % track.length];
};
function savePatterns() { store.set('toydeck.patterns', customPatterns); refreshPatternSelects(); }
function saveRecordings() {
  const ok = store.set('toydeck.recordings', recordings);
  refreshPatternSelects();
  return ok;
}

// ---------- toys: state + persistence ----------
const toys = new Map();   // key -> toy (saved toys too, even when not connected)
let masterLevel = 1;
const toySettings = store.get('toydeck.toys', {});

function fitSlots(slots, n) {
  const out = (slots ?? []).slice(0, n);
  for (let s = 1; out.length < n; s++) if (!out.includes(s)) out.push(s);
  return out;
}
function saveToySettings(toy) {
  toySettings[toy.key] = {
    motors: toy.motors, slots: toy.slots, minPower: toy.minPower, linked: toy.linked, levels: toy.levels, name: toy.name,
    hasHeat: toy.hasHeat, hasSuck: toy.hasSuck, suckLevels: toy.suckLevels,
  };
  store.set('toydeck.toys', toySettings);
}

function makeToy(key, saved = {}) {
  const motors = saved.motors ?? 1;
  return {
    key,
    device: null,
    name: saved.name || 'Toy',
    motors,
    slots: fitSlots(saved.slots, motors),
    minPower: saved.minPower ?? 0,
    // Slider positions are remembered; motors always start Off so nothing runs on connect.
    levels: Array.from({ length: 4 }, (_, i) => saved.levels?.[i] ?? 0),
    enabled: [true, true, true, true],   // per-motor On/Off; the card's Start/Stop is the main switch
    running: false,                      // always starts stopped: press Start
    strengthOn: true,
    speedOn: true,
    linked: saved.linked ?? true,
    mode: 'manual',
    patternId: 'wave',
    pStrength: 0.7,
    pSpeed: 1,
    offset: false,
    phase: 0,
    hasHeat: saved.hasHeat ?? false,
    hasSuck: saved.hasSuck ?? false,
    suckLevels: saved.suckLevels ?? 5,
    heat: false,      // heat/suction always start off
    suck: 0,
    battery: null,    // % if the toy has the standard battery service
    batteryTimer: null,
    connected: false,
    connecting: false,
    writeChars: [],
    queue: [],        // one-off commands (stop, heat, suction...) sent in order
    charInfo: '',
    writing: false,
    pending: null,
    lastHex: '',
    lastSentAt: 0,
    lastRx: '',
    lastError: '',
    manualStop: false,
    rec: null,        // active recording
    recDraft: null,   // finished recording waiting for a name
    collapsed: false, // card shows only picture + name; saved toys start this way
  };
}

const watchedDevices = new WeakSet();
function attachDevice(toy, device) {
  toy.device = device;
  if (device.name) toy.name = device.name;
  if (!watchedDevices.has(device)) {
    watchedDevices.add(device);
    device.addEventListener('gattserverdisconnected', () => onDisconnected(toy));
  }
  renderToyName(toy);
}

// Find the saved toy a picked device belongs to: same id first, then same name.
function toyForDevice(device) {
  if (toys.has(device.id)) return toys.get(device.id);
  return [...toys.values()].find((t) => !t.connected && t.name === device.name && (!t.device || t.device.id === device.id));
}

// ---------- Bluetooth ----------
async function addToy() {
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SERVICE, 'battery_service'] });
  } catch (err) {
    if (err.name !== 'NotFoundError') say(`Couldn't open the Bluetooth picker: ${err.message}`);
    return; // NotFoundError = user closed the picker
  }
  let toy = toyForDevice(device);
  if (toy?.connected) { say(`${toy.name} is already connected.`); return; }
  if (!toy) {
    toy = makeToy(device.id, toySettings[device.id] ?? { name: device.name });
    toys.set(toy.key, toy);
    buildToyCard(toy);
  }
  attachDevice(toy, device);
  saveToySettings(toy);
  await connectToy(toy);
}

// "Connect" on a saved toy: reuse the remembered device if Chrome gave it back,
// otherwise open the picker filtered to just this toy's name (one tap).
async function connectSaved(toy) {
  toy.manualStop = false;
  if (toy.device) {
    const ok = await connectToy(toy, { quiet: true });
    if (ok) return;
  }
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({ filters: [{ name: toy.name }], optionalServices: [SERVICE, 'battery_service'] });
  } catch (err) {
    if (err.name === 'NotFoundError') say(`${toy.name} wasn't picked. Make sure it's switched on and nearby.`);
    else say(`Couldn't open the Bluetooth picker: ${err.message}`);
    return;
  }
  attachDevice(toy, device);
  await connectToy(toy);
}

async function connectToy(toy, { quiet = false } = {}) {
  if (toy.connecting || !toy.device) return false;
  toy.connecting = true;
  setBadge(toy, 'Connecting…', '');
  try {
    const server = await withTimeout(toy.device.gatt.connect(), CONNECT_TIMEOUT_MS);
    const service = await server.getPrimaryService(SERVICE);
    const chars = await service.getCharacteristics();
    toy.writeChars = chars.filter((c) => c.properties.writeWithoutResponse);
    if (!toy.writeChars.length) toy.writeChars = chars.filter((c) => c.properties.write);
    if (!toy.writeChars.length) throw new Error('no writable characteristic in service FFA0');
    toy.charInfo = chars.map((c) => {
      const p = c.properties;
      const flags = [p.read && 'R', p.write && 'W', p.writeWithoutResponse && 'Wnr', p.notify && 'N', p.indicate && 'I'].filter(Boolean).join('/');
      return `${c.uuid.slice(4, 8)}(${flags})`;
    }).join(' ');
    const notify = chars.find((c) => c.properties.notify);
    if (notify) {
      try {
        await notify.startNotifications();
        notify.addEventListener('characteristicvaluechanged', (e) => {
          toy.lastRx = toHex(new Uint8Array(e.target.value.buffer));
          updateDebug(toy);
        });
      } catch { /* notifications are optional */ }
    }
    toy.connected = true;
    toy.manualStop = false;
    toy.lastHex = '';
    toy.queue = [];
    toy.heat = false;
    toy.suck = 0;
    if (toy.ui) renderFeatures(toy);
    readBattery(toy, server);
    say(`${toy.name} connected.`);
    return true;
  } catch (err) {
    toy.connected = false;
    try { toy.device.gatt.disconnect(); } catch { /* not connected */ }
    if (!quiet) {
      if (err.name === 'NotFoundError' || /FFA0|service/i.test(err.message)) {
        say(`${toy.name} doesn't look like a supported toy (no FFA0 service).`, true);
      } else {
        say(`Couldn't connect to ${toy.name}: ${err.message}. Is it on and nearby?`, true);
      }
    }
    return false;
  } finally {
    toy.connecting = false;
    refreshToyState(toy);
  }
}

// Standard Bluetooth battery service (0x180F), if the toy has it. The official app never reads battery.
async function readBattery(toy, server) {
  clearInterval(toy.batteryTimer);
  toy.battery = null;
  toy.batteryNote = '';
  try {
    const service = await server.getPrimaryService('battery_service');
    const level = await service.getCharacteristic('battery_level');
    const read = async () => {
      try { toy.battery = (await level.readValue()).getUint8(0); updateBattery(toy); } catch { /* toy busy */ }
    };
    await read();
    try {
      await level.startNotifications();
      level.addEventListener('characteristicvaluechanged', (e) => { toy.battery = e.target.value.getUint8(0); updateBattery(toy); });
    } catch {
      toy.batteryTimer = setInterval(() => { if (toy.connected) read(); }, BATTERY_POLL_MS);
    }
  } catch (err) {
    // SecurityError = permission from before battery support; reconnecting through the picker fixes it.
    toy.batteryNote = err.name === 'SecurityError' ? 'battery: tap Disconnect, then Connect, to allow it' : 'battery: not reported by this toy';
  }
  updateBattery(toy);
  updateDebug(toy);
}

async function onDisconnected(toy) {
  toy.connected = false;
  toy.writing = false;
  toy.pending = null;
  toy.queue = [];
  clearInterval(toy.batteryTimer);
  toy.battery = null;
  updateBattery(toy);
  if (toy.rec) finishRecording(toy);
  if (!toys.has(toy.key)) return;
  refreshToyState(toy);
  if (toy.manualStop) return;
  // try to get it back a few times (toys drop out when they go out of range)
  for (let i = 0; i < 3 && toys.has(toy.key) && !toy.connected && !toy.manualStop; i++) {
    await sleep(1500 * (i + 1));
    if (toys.has(toy.key) && !toy.connected && !toy.manualStop) await connectToy(toy, { quiet: i < 2 });
  }
}

// Reconnect toys Chrome still has permission for, without any taps (where Chrome supports it).
async function autoReconnect() {
  if (typeof navigator.bluetooth?.getDevices !== 'function') return;
  let devices = [];
  try { devices = await navigator.bluetooth.getDevices(); } catch { return; }
  for (const device of devices) {
    const toy = toyForDevice(device);
    if (!toy) continue;
    attachDevice(toy, device);
    refreshToyState(toy);
    connectToy(toy, { quiet: true }).then((ok) => {
      if (ok || typeof device.watchAdvertisements !== 'function') return;
      // Not in range yet: connect as soon as the toy is switched on.
      const onAdvert = () => {
        device.removeEventListener('advertisementreceived', onAdvert);
        if (!toy.connected) connectToy(toy, { quiet: true });
      };
      device.addEventListener('advertisementreceived', onAdvert);
      device.watchAdvertisements().catch(() => {});
    });
  }
}

// One write in flight per toy. Every write characteristic gets every command.
// Motor levels: only the newest matters (pending). One-off commands (queued) are all sent, in order, first.
function send(toy, bytes, queued = false) {
  if (!toy.connected || !toy.writeChars.length) return;
  if (queued) toy.queue.push(bytes); else toy.pending = bytes;
  pump(toy);
}
function pump(toy) {
  if (toy.writing || !toy.connected) return;
  let bytes;
  if (toy.queue.length) bytes = toy.queue.shift();
  else if (toy.pending) { bytes = toy.pending; toy.pending = null; }
  else return;
  toy.writing = true;
  (async () => {
    for (const c of toy.writeChars) {
      try {
        if (c.properties.writeWithoutResponse) await c.writeValueWithoutResponse(bytes);
        else await c.writeValue(bytes);
        toy.lastError = '';
      } catch (err) {
        toy.lastError = `${c.uuid.slice(4, 8)}: ${err.message}`;
      }
    }
  })().finally(() => {
    toy.writing = false;
    pump(toy);
  });
}

function motorByte(toy, level) {
  if (level <= 0.001) return 0;
  return Math.round(clamp(toy.minPower + (255 - toy.minPower) * level, 1, 255));
}

// Levels from the sliders, before the master level (what recordings capture).
// A motor that's switched Off sends 0 but keeps its slider position.
// Nothing runs until the card's Start button is pressed (toy.running).
function manualLevels(toy) {
  return Array.from({ length: toy.motors }, (_, m) => {
    const i = toy.linked ? 0 : m;
    return toy.running && toy.enabled[i] ? toy.levels[i] : 0;
  });
}

function currentLevels(toy) {
  let out;
  if (toy.mode === 'pattern') {
    const p = findPattern(toy.patternId);
    const len = patternLength(p);
    const n = toy.motors;
    const strength = toy.running && toy.strengthOn ? toy.pStrength : 0;
    out = Array.from({ length: n }, (_, m) => {
      const shift = toy.offset && n > 1 && !p.tracks ? Math.floor((len * m) / n) : 0;
      return patternValue(p, m, Math.floor(toy.phase) + shift) * strength;
    });
  } else {
    out = manualLevels(toy);
  }
  return out.map((v) => clamp(v * masterLevel, 0, 1));
}

function buildCommand(toy) {
  const values = Array(Math.max(MIN_SLOTS, ...toy.slots)).fill(0);
  currentLevels(toy).forEach((l, m) => {
    const i = toy.slots[m] - 1;
    values[i] = Math.max(values[i], motorByte(toy, l));
  });
  return new Uint8Array([0xa0, 0x03, ...values, 0xaa]);
}

// ---------- main loop ----------
let lastTick = performance.now();
function tick() {
  const now = performance.now();
  const dt = now - lastTick;
  lastTick = now;
  for (const toy of toys.values()) {
    // Speed Off freezes the pattern on its current step.
    if (toy.mode === 'pattern' && toy.running && toy.speedOn) {
      const p = findPattern(toy.patternId);
      toy.phase = (toy.phase + (dt * toy.pSpeed) / p.stepMs) % patternLength(p);
    }
    if (toy.rec) captureRecording(toy, now);
    if (!toy.connected) continue;
    const bytes = buildCommand(toy);
    const hex = toHex(bytes);
    if (hex !== toy.lastHex || now - toy.lastSentAt > KEEPALIVE_MS) {
      toy.lastHex = hex;
      toy.lastSentAt = now;
      send(toy, bytes);
      updateDebug(toy);
    }
  }
}
setInterval(tick, TICK_MS);

// ---------- recording (per toy) ----------
function startRecording(toy) {
  if (toy.mode !== 'manual') { toy.mode = 'manual'; syncToyUI(toy); }
  setRunning(toy, true);   // recording what you feel, so the toy runs while recording
  const now = performance.now();
  toy.recDraft = null;
  toy.rec = { start: now, last: now, tracks: Array.from({ length: toy.motors }, () => []) };
  captureRecording(toy, now, true);
  refreshRecUI(toy);
  say(`Recording ${toy.name}. Move the sliders, then press Stop.`);
}
function captureRecording(toy, now, first = false) {
  const rec = toy.rec;
  const steps = first ? 1 : Math.floor((now - rec.last) / REC_STEP_MS);
  if (steps <= 0) return;
  if (!first) rec.last += steps * REC_STEP_MS;
  const levels = manualLevels(toy);
  for (let s = 0; s < steps; s++) rec.tracks.forEach((t, m) => t.push(+levels[m].toFixed(2)));
  toy.ui.recTime.textContent = `${fmtTime(now - rec.start)} recorded`;
  if (now - rec.start >= REC_MAX_MS) { finishRecording(toy); say('Recording stopped at the 30-minute limit.'); }
}
function finishRecording(toy) {
  const rec = toy.rec;
  toy.rec = null;
  if (!rec || rec.tracks[0].length < 5) {
    toy.ui.recTime.textContent = '';
    say('Recording was too short to save.');
    refreshRecUI(toy);
    return;
  }
  // One track if every motor did the same thing.
  const same = rec.tracks.every((t) => t.every((v, i) => v === rec.tracks[0][i]));
  toy.recDraft = { tracks: same ? [rec.tracks[0]] : rec.tracks, ms: rec.tracks[0].length * REC_STEP_MS };
  const count = recordings.filter((r) => r.toyKey === toy.key).length + 1;
  toy.ui.recName.value = `${toy.name} ${count}`;
  toy.ui.recTime.textContent = `${fmtTime(toy.recDraft.ms)} recorded`;
  refreshRecUI(toy);
  toy.ui.recName.focus();
  toy.ui.recName.select();
}
function keepRecording(toy) {
  const name = toy.ui.recName.value.trim();
  if (!name) { toy.ui.recName.focus(); return; }
  const p = { id: `r${Date.now().toString(36)}`, name, stepMs: REC_STEP_MS, tracks: toy.recDraft.tracks, toyKey: toy.key, recorded: true };
  recordings.push(p);
  if (!saveRecordings()) {
    recordings.pop();
    say('Not enough browser storage to save this recording. Try a shorter one or delete old ones.', true);
    return;
  }
  toy.recDraft = null;
  toy.ui.recTime.textContent = '';
  refreshRecUI(toy);
  // Switch to it, stopped: press Start to play it.
  toy.mode = 'pattern';
  toy.patternId = p.id;
  toy.phase = 0;
  toy.running = false;
  setStrength(toy, 100);
  syncToyUI(toy);
  say(`Saved “${name}” for ${toy.name}. It's selected under Pattern (marked ●) — press Start to play it.`);
}
function discardRecording(toy) {
  toy.recDraft = null;
  toy.ui.recTime.textContent = '';
  refreshRecUI(toy);
}
function refreshRecUI(toy) {
  const { ui } = toy;
  ui.rec.textContent = toy.rec ? '■ Stop recording' : '● Record pattern';
  ui.rec.classList.toggle('recording', !!toy.rec);
  ui.recSave.hidden = !toy.recDraft;
}

// ---------- start / stop ----------
function setRunning(toy, on) {
  toy.running = on;
  refreshRunUI(toy);
}
function refreshRunUI(toy) {
  const btn = toy.ui?.run;
  if (!btn) return;
  btn.textContent = toy.running ? 'Stop' : 'Start';
  btn.setAttribute('aria-pressed', String(toy.running));
  toy.ui.running.hidden = !toy.running;
}
// Full stop (STOP ALL, leaving the app): motors, suction and heat.
function stopToy(toy) {
  if (toy.rec) finishRecording(toy);
  toy.running = false;   // keeps mode, sliders and motor On/Off as they were; Start carries on
  const heatWasOn = toy.heat;
  const suckWasOn = toy.suck > 0;
  toy.heat = false;
  toy.suck = 0;
  syncToyUI(toy);
  renderFeatures(toy);
  if (!toy.connected) return;
  toy.lastHex = toHex(STOP_BYTES);
  toy.lastSentAt = performance.now();
  send(toy, STOP_BYTES, true);
  if (suckWasOn) sendRepeated(toy, SUCK_OFF);
  if (heatWasOn) sendRepeated(toy, HEAT_OFF);
}
function stopAll() {
  for (const toy of toys.values()) stopToy(toy);
  say('All toys stopped.');
}
// Best effort: stop everything if the page is closed.
window.addEventListener('pagehide', () => {
  for (const toy of toys.values()) {
    if (!toy.connected) continue;
    for (const c of toy.writeChars) {
      try {
        c.writeValueWithoutResponse(STOP_BYTES);
        if (toy.suck) c.writeValueWithoutResponse(hexToBytes(SUCK_OFF));
        if (toy.heat) c.writeValueWithoutResponse(hexToBytes(HEAT_OFF));
      } catch { /* page is going away */ }
    }
  }
});

// Switch-type commands are sent 3 times, like the official app does.
function sendRepeated(toy, hex) {
  const bytes = hexToBytes(hex);
  for (let i = 0; i < 3; i++) send(toy, bytes, true);
}
function sendExtra(toy, name, on) { sendRepeated(toy, on ? EXTRAS[name].on : EXTRAS[name].off); }
function setHeat(toy, on) {
  toy.heat = on;
  sendRepeated(toy, on ? HEAT_ON : HEAT_OFF);
  renderFeatures(toy);
}
function setSuction(toy, level) {
  toy.suck = level;
  sendRepeated(toy, suckCmd(level));
  renderFeatures(toy);
}

function disconnectToy(toy) {
  toy.manualStop = true;
  if (toy.rec) finishRecording(toy);
  const done = () => { try { toy.device?.gatt.disconnect(); } catch { /* already gone */ } };
  if (toy.connected) {
    const cmds = [STOP_BYTES];
    if (toy.suck) cmds.push(hexToBytes(SUCK_OFF));
    if (toy.heat) cmds.push(hexToBytes(HEAT_OFF));
    toy.heat = false;
    toy.suck = 0;
    (async () => {
      for (const bytes of cmds) {
        await Promise.allSettled(toy.writeChars.map((c) => c.writeValueWithoutResponse(bytes)));
      }
    })().finally(done);
  } else {
    done();
  }
  toy.connected = false;
  refreshToyState(toy);
}

function forgetToy(toy) {
  disconnectToy(toy);
  try { toy.device?.forget?.(); } catch { /* optional API */ }
  toys.delete(toy.key);
  delete toySettings[toy.key];
  store.set('toydeck.toys', toySettings);
  recordings = recordings.filter((r) => r.toyKey !== toy.key);
  saveRecordings();
  toy.ui.el.remove();
  $('#empty').hidden = toys.size > 0;
  updateCount();
  say(`Forgot ${toy.name} and its recordings.`);
}

// ---------- UI ----------
const toysEl = $('#toys');
const tpl = $('#toy-tpl');

function setStrength(toy, pct) {
  toy.pStrength = pct / 100;
  toy.ui.pstrength.value = String(pct);
  toy.ui.pstrengthOut.value = `${pct}%`;
}

// Toy pictures, looked up by the toy's Bluetooth name. To add one: put the image in toys/
// (and in FILES in sw.js) and add a line here. The key is the name lowercased with only letters and digits.
const TOY_PICS = {
  jphantom: 'toys/j-phantom.webp',
  jpinhead: 'toys/j-pinhead.webp',
};
const FALLBACK_PIC = 'icons/icon.svg';
function toyPicture(name) {
  const n = String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (TOY_PICS[n]) return TOY_PICS[n];
  // Names sometimes carry a suffix ("J-Phantom-2", "J-Phantom 01"): longest key the name starts with wins.
  const key = Object.keys(TOY_PICS).filter((k) => n.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? TOY_PICS[key] : null;
}

function renderToyName(toy) {
  const { ui } = toy;
  if (!ui) return;
  ui.name.textContent = toy.name;
  const pic = toyPicture(toy.name);
  const src = pic ?? FALLBACK_PIC;
  if (ui.pic.getAttribute('src') !== src) ui.pic.src = src;
  ui.el.classList.toggle('no-pic', !pic);
  if (ui.head) setCollapsed(toy, toy.collapsed);   // refresh the tooltip with the new name
}

function setCollapsed(toy, collapsed) {
  toy.collapsed = collapsed;
  const { ui } = toy;
  if (!ui) return;
  ui.el.classList.toggle('collapsed', collapsed);
  ui.body.hidden = collapsed;
  ui.head.setAttribute('aria-expanded', String(!collapsed));
  ui.head.title = collapsed ? `Open ${toy.name}'s controls` : `Minimize ${toy.name}`;
  ui.hint.textContent = collapsed ? 'Tap to open controls' : '';
}

function buildToyCard(toy) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const ui = {
    el,
    head: $('.toy-head', el),
    body: $('.toy-body', el),
    pic: $('.toy-pic', el),
    hint: $('.toy-hint', el),
    running: $('.running', el),
    name: $('.toy-name', el),
    badge: $('.badge', el),
    radios: el.querySelectorAll('.seg input'),
    manual: $('.manual-ui', el),
    pattern: $('.pattern-ui', el),
    link: $('.link', el),
    sliders: $('.motor-sliders', el),
    rec: $('.rec', el),
    recTime: $('.rec-time', el),
    recSave: $('.rec-save', el),
    recName: $('.rec-name', el),
    patternSel: $('.pattern', el),
    pdelete: $('.pdelete', el),
    preview: $('.preview', el),
    pstrength: $('.pstrength', el),
    pstrengthOut: $('.pstrength-out', el),
    pspeed: $('.pspeed', el),
    pspeedOut: $('.pspeed-out', el),
    offset: $('.offset', el),
    motors: $('.motors', el),
    minpower: $('.minpower', el),
    minOut: $('.min-out', el),
    debug: $('.debug', el),
    connect: $('.connect', el),
    disconnect: $('.disconnect', el),
    battery: $('.battery', el),
    features: $('.features', el),
    heatRow: $('.heat-row', el),
    heatBtn: $('.heat-toggle', el),
    suckRow: $('.suck-row', el),
    levels: $('.levels', el),
    hasHeat: $('.has-heat', el),
    hasSuck: $('.has-suck', el),
    suckLevels: $('.suck-levels', el),
    run: $('.run', el),
    strengthRow: $('.strength-row', el),
    strengthBtn: $('.pstrength-toggle', el),
    speedRow: $('.speed-row', el),
    speedBtn: $('.pspeed-toggle', el),
  };
  toy.ui = ui;
  ui.run.addEventListener('click', () => setRunning(toy, !toy.running));
  ui.strengthBtn.addEventListener('click', () => { toy.strengthOn = !toy.strengthOn; refreshPatternToggles(toy); });
  ui.speedBtn.addEventListener('click', () => { toy.speedOn = !toy.speedOn; refreshPatternToggles(toy); });
  ui.heatBtn.addEventListener('click', () => setHeat(toy, !toy.heat));
  ui.hasHeat.checked = toy.hasHeat;
  ui.hasSuck.checked = toy.hasSuck;
  ui.suckLevels.value = String(toy.suckLevels);
  ui.hasHeat.addEventListener('change', () => {
    toy.hasHeat = ui.hasHeat.checked;
    if (!toy.hasHeat && toy.heat) setHeat(toy, false);
    saveToySettings(toy);
    renderFeatures(toy);
  });
  ui.hasSuck.addEventListener('change', () => {
    toy.hasSuck = ui.hasSuck.checked;
    if (!toy.hasSuck && toy.suck) setSuction(toy, 0);
    saveToySettings(toy);
    renderFeatures(toy);
  });
  ui.suckLevels.addEventListener('change', () => {
    toy.suckLevels = +ui.suckLevels.value;
    if (toy.suck > toy.suckLevels) setSuction(toy, toy.suckLevels);
    saveToySettings(toy);
    renderFeatures(toy);
  });
  renderToyName(toy);
  ui.pic.addEventListener('error', () => {
    if (!ui.pic.src.endsWith(FALLBACK_PIC)) { ui.pic.src = FALLBACK_PIC; ui.el.classList.add('no-pic'); }
  });
  ui.head.addEventListener('click', () => setCollapsed(toy, !toy.collapsed));
  const group = `mode-${toy.key}`;
  ui.radios.forEach((r) => {
    r.name = group;
    r.addEventListener('change', () => {
      if (toy.rec) finishRecording(toy);
      toy.mode = r.value;
      toy.phase = 0;
      toy.running = false;   // switching Manual/Pattern always starts stopped
      syncToyUI(toy);
    });
  });
  ui.link.checked = toy.linked;
  ui.link.addEventListener('change', () => { toy.linked = ui.link.checked; saveToySettings(toy); renderSliders(toy); });
  ui.rec.addEventListener('click', () => (toy.rec ? finishRecording(toy) : startRecording(toy)));
  $('.rec-keep', el).addEventListener('click', () => keepRecording(toy));
  $('.rec-discard', el).addEventListener('click', () => discardRecording(toy));
  ui.recName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); keepRecording(toy); } });
  fillPatternSelect(ui.patternSel, toy);
  ui.patternSel.addEventListener('change', () => {
    toy.patternId = ui.patternSel.value;
    toy.phase = 0;
    if (findPattern(toy.patternId).recorded) setStrength(toy, 100);
    syncToyUI(toy);
  });
  ui.pdelete.addEventListener('click', () => confirmTap(ui.pdelete, 'Tap again to delete', () => {
    const p = findPattern(toy.patternId);
    recordings = recordings.filter((r) => r.id !== p.id);
    toy.patternId = BUILTIN[0].id;
    saveRecordings();
    syncToyUI(toy);
    say(`Deleted “${p.name}”.`);
  }));
  ui.pstrength.addEventListener('input', () => setStrength(toy, +ui.pstrength.value));
  ui.pspeed.addEventListener('input', () => { toy.pSpeed = ui.pspeed.value / 100; ui.pspeedOut.value = `${toy.pSpeed.toFixed(2)}×`; });
  ui.offset.addEventListener('change', () => { toy.offset = ui.offset.checked; });
  ui.motors.value = String(toy.motors);
  ui.motors.addEventListener('change', () => {
    if (toy.rec) finishRecording(toy);
    toy.motors = +ui.motors.value;
    toy.slots = fitSlots(toy.slots, toy.motors);
    saveToySettings(toy);
    syncToyUI(toy);
  });
  ui.minpower.value = String(toy.minPower);
  ui.minOut.value = String(toy.minPower);
  ui.minpower.addEventListener('input', () => { toy.minPower = +ui.minpower.value; ui.minOut.value = ui.minpower.value; });
  ui.minpower.addEventListener('change', () => saveToySettings(toy));
  el.querySelectorAll('[data-extra]').forEach((cb) => {
    cb.addEventListener('change', () => sendExtra(toy, cb.dataset.extra, cb.checked));
  });
  ui.connect.addEventListener('click', () => connectSaved(toy));
  ui.disconnect.addEventListener('click', () => disconnectToy(toy));
  const forgetBtn = $('.forget', el);
  forgetBtn.addEventListener('click', () => confirmTap(forgetBtn, 'Tap again — also deletes its recordings', () => forgetToy(toy)));
  $('#empty').hidden = true;
  toysEl.append(el);
  setCollapsed(toy, toy.collapsed);
  syncToyUI(toy);
  renderFeatures(toy);
  refreshToyState(toy);
}

function renderFeatures(toy) {
  const { ui } = toy;
  if (!ui) return;
  ui.features.hidden = !toy.hasHeat && !toy.hasSuck;
  ui.heatRow.hidden = !toy.hasHeat;
  ui.heatBtn.textContent = toy.heat ? 'On' : 'Off';
  ui.heatBtn.setAttribute('aria-pressed', String(toy.heat));
  ui.suckRow.hidden = !toy.hasSuck;
  const buttons = Array.from({ length: toy.suckLevels + 1 }, (_, level) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = level === 0 ? 'Off' : String(level);
    b.setAttribute('aria-pressed', String(toy.suck === level));
    b.setAttribute('aria-label', level === 0 ? 'Suction off' : `Suction level ${level}`);
    b.addEventListener('click', () => setSuction(toy, level));
    return b;
  });
  ui.levels.replaceChildren(...buttons);
  const disabled = !toy.connected;
  ui.heatBtn.disabled = disabled;
  buttons.forEach((b) => { b.disabled = disabled; });
}

function updateBattery(toy) {
  const el = toy.ui?.battery;
  if (!el) return;
  const known = toy.connected && toy.battery != null;
  el.hidden = !known;
  if (!known) return;
  el.textContent = `Battery ${toy.battery}%`;
  el.classList.toggle('low', toy.battery < 20);
}

function renderSliders(toy) {
  const count = toy.linked ? 1 : toy.motors;
  toy.ui.sliders.replaceChildren();
  for (let m = 0; m < count; m++) {
    const row = document.createElement('div');
    row.className = 'motor-row';
    const label = document.createElement('label');
    label.className = 'slider-label';
    const title = toy.linked ? (toy.motors > 1 ? 'All motors' : 'Intensity') : `Motor ${m + 1}`;
    const pct = Math.round(toy.levels[m] * 100);
    label.innerHTML = `<span>${title} <output>${pct}%</output></span><input type="range" min="0" max="100" value="${pct}">`;
    const input = $('input', label);
    const out = $('output', label);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'motor-toggle';
    btn.setAttribute('aria-label', `${title} on or off`);
    const setOn = (on) => {
      if (toy.linked) toy.enabled.fill(on); else toy.enabled[m] = on;
      btn.textContent = on ? 'On' : 'Off';
      btn.setAttribute('aria-pressed', String(on));
      row.classList.toggle('off', !on);
    };
    setOn(toy.enabled[m]);
    btn.addEventListener('click', () => setOn(!toy.enabled[m]));
    input.addEventListener('input', () => {
      const v = input.value / 100;
      if (toy.linked) toy.levels.fill(v); else toy.levels[m] = v;
      out.value = `${input.value}%`;
      if (!toy.enabled[m]) setOn(true);   // moving a slider switches its motor on
    });
    input.addEventListener('change', () => saveToySettings(toy));
    row.append(label, btn);
    toy.ui.sliders.append(row);
  }
  toy.ui.link.closest('label').hidden = toy.motors < 2;
}

function renderSlotMap(toy) {
  const box = $('.slot-map', toy.ui.el);
  box.replaceChildren(...toy.slots.map((slot, m) => {
    const label = document.createElement('label');
    label.className = 'inline';
    label.textContent = `Motor ${m + 1} channel `;
    const sel = document.createElement('select');
    for (let s = 1; s <= 4; s++) sel.append(new Option(String(s), String(s)));
    sel.value = String(slot);
    sel.addEventListener('change', () => { toy.slots[m] = +sel.value; saveToySettings(toy); });
    label.append(sel);
    return label;
  }));
}

function refreshPatternToggles(toy) {
  const { ui } = toy;
  for (const [row, btn, on] of [[ui.strengthRow, ui.strengthBtn, toy.strengthOn], [ui.speedRow, ui.speedBtn, toy.speedOn]]) {
    btn.textContent = on ? 'On' : 'Off';
    btn.setAttribute('aria-pressed', String(on));
    row.classList.toggle('off', !on);
  }
}

function syncToyUI(toy) {
  const { ui } = toy;
  ui.radios.forEach((r) => { r.checked = r.value === toy.mode; });
  ui.manual.hidden = toy.mode !== 'manual';
  ui.pattern.hidden = toy.mode !== 'pattern';
  const p = findPattern(toy.patternId);
  ui.offset.closest('label').hidden = toy.motors < 2 || !!p.tracks;
  fillPatternSelect(ui.patternSel, toy);
  ui.pdelete.hidden = !p.recorded;
  renderSliders(toy);
  renderSlotMap(toy);
  refreshRecUI(toy);
  refreshRunUI(toy);
  refreshPatternToggles(toy);
  drawPreview(toy);
}

function refreshToyState(toy) {
  if (!toy.ui) return;
  const { ui } = toy;
  if (toy.connecting) setBadge(toy, 'Connecting…', '');
  else if (toy.connected) setBadge(toy, 'Connected', 'on');
  else setBadge(toy, toy.device ? 'Not connected' : 'Saved', 'off');
  ui.connect.hidden = toy.connected || toy.connecting;
  ui.disconnect.hidden = !toy.connected;
  ui.el.classList.toggle('offline', !toy.connected);
  renderFeatures(toy);
  updateBattery(toy);
  updateDebug(toy);
  updateCount();
}

function setBadge(toy, text, cls) {
  toy.ui.badge.textContent = text;
  toy.ui.badge.className = `badge ${cls}`;
}
function updateDebug(toy) {
  if (!toy.ui) return;
  toy.ui.debug.textContent = [
    `chars ${toy.charInfo || '—'}`,
    `sent ${toy.lastHex || '—'}`,
    toy.lastRx && `received ${toy.lastRx}`,
    toy.lastError && `error ${toy.lastError}`,
    toy.connected && toy.batteryNote,
  ].filter(Boolean).join(' · ');
}
function updateCount() {
  const all = [...toys.values()];
  const n = all.filter((t) => t.connected).length;
  $('#toy-count').textContent = all.length ? `${n} of ${all.length} connected` : 'No toys yet';
  $('#connect-all').hidden = !all.some((t) => !t.connected);
  updateWakeLock();
}

// ---------- phone behaviour ----------
// Keep the screen on while toys are connected: a sleeping phone pauses the page,
// and a toy would keep running its last command with nothing to stop it.
let wakeLock = null;
async function updateWakeLock() {
  if (!('wakeLock' in navigator)) return;
  const want = document.visibilityState === 'visible' && [...toys.values()].some((t) => t.connected);
  if (want && !wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* battery saver or not allowed */ }
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
// On phones/tablets the page is frozen in the background, so stop the toys before that happens.
const isTouchDevice = matchMedia('(pointer: coarse)').matches;
let stoppedInBackground = false;
document.addEventListener('visibilitychange', () => {
  const connected = [...toys.values()].some((t) => t.connected);
  if (document.visibilityState === 'hidden' && isTouchDevice && connected) {
    for (const toy of toys.values()) stopToy(toy);
    stoppedInBackground = true;
  } else if (document.visibilityState === 'visible' && stoppedInBackground) {
    stoppedInBackground = false;
    say('Toys were stopped while ToyDeck was in the background. Tap Start to carry on.');
  }
  updateWakeLock();
});

function drawPreview(toy) {
  const c = toy.ui.preview;
  const ctx = c.getContext('2d');
  const p = findPattern(toy.patternId);
  const len = patternLength(p);
  const tracks = p.tracks ?? [p.steps];
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1f6feb';
  ctx.clearRect(0, 0, c.width, c.height);
  // Long recordings: draw at most one bar per pixel column.
  const cols = Math.min(Math.max(len, 2), c.width);
  const w = c.width / cols;
  tracks.forEach((track, t) => {
    ctx.fillStyle = accent;
    ctx.globalAlpha = t === 0 ? 1 : 0.45;
    for (let x = 0; x < cols; x++) {
      const i = Math.floor((x * len) / cols);
      const v = track[i % track.length];
      const h = Math.max(2, v * (c.height - 4));
      ctx.fillRect(x * w + (cols > 150 ? 0 : 1), c.height - h, Math.max(1, w - (cols > 150 ? 0 : 2)), h);
    }
  });
  ctx.globalAlpha = 1;
}

function fillPatternSelect(sel, toy = null) {
  const own = toy ? recordings.filter((r) => r.toyKey === toy.key) : [];
  const groups = [
    ['Built-in', BUILTIN.filter((p) => p.id !== '__try' || !toy || toy.patternId === '__try')],
    ['My patterns', customPatterns],
    [toy ? `Recorded on ${toy.name}` : '', own],
  ];
  sel.replaceChildren(...groups.filter(([, list]) => list.length).map(([label, list]) => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...list.map((p) => new Option(p.recorded ? `● ${p.name}` : p.builtin ? p.name : `★ ${p.name}`, p.id)));
    return g;
  }));
  const valid = toy ? patternsFor(toy) : sharedPatterns();
  const want = toy ? toy.patternId : sel.dataset.value || 'wave';
  sel.value = valid.some((p) => p.id === want) ? want : BUILTIN[0].id;
  if (toy) toy.patternId = sel.value;
}
function refreshPatternSelects() {
  fillPatternSelect($('#all-pattern'));
  for (const toy of toys.values()) {
    if (!toy.ui) continue;
    fillPatternSelect(toy.ui.patternSel, toy);
    toy.ui.pdelete.hidden = !findPattern(toy.patternId).recorded;
    drawPreview(toy);
  }
}

// ---------- master controls ----------
const master = $('#master');
master.addEventListener('input', () => { masterLevel = master.value / 100; $('#master-out').value = `${master.value}%`; });
$('#stop-all').addEventListener('click', stopAll);
$('#all-pattern').addEventListener('change', (e) => { e.target.dataset.value = e.target.value; });
$('#apply-all').addEventListener('click', () => {
  const id = $('#all-pattern').value;
  for (const toy of toys.values()) {
    if (toy.rec) finishRecording(toy);
    toy.mode = 'pattern'; toy.patternId = id; toy.phase = 0; toy.running = true; syncToyUI(toy);
  }
  say(`Playing “${findPattern(id).name}” on all toys.`);
});
$('#sync-all').addEventListener('click', () => { for (const toy of toys.values()) toy.phase = 0; say('Patterns synced.'); });
$('#connect-all').addEventListener('click', async () => {
  const waiting = [...toys.values()].filter((t) => !t.connected);
  const withDevice = waiting.filter((t) => t.device);
  await Promise.all(withDevice.map((t) => { t.manualStop = false; return connectToy(t, { quiet: true }); }));
  const still = waiting.filter((t) => !t.connected);
  if (still.length) say(`Tap Connect on: ${still.map((t) => t.name).join(', ')}. Make sure they're switched on.`, true);
});
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.target.closest('input:not([type="range"]), select, textarea, button, dialog')) {
    e.preventDefault();
    stopAll();
  }
});
$('#all-pattern').dataset.value = 'wave';
fillPatternSelect($('#all-pattern'));

// ---------- backup / restore (move settings between PC and phone) ----------
$('#backup').addEventListener('click', () => {
  const data = { app: 'ToyDeck', version: 1, saved: new Date().toISOString(), toys: toySettings, patterns: customPatterns, recordings };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `toydeck-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  say('Backup saved. Open it with Restore on your other device.');
});
$('#restore').addEventListener('click', () => $('#restore-file').click());
$('#restore-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { say("That file isn't a ToyDeck backup.", true); return; }
  if (data?.app !== 'ToyDeck') { say("That file isn't a ToyDeck backup.", true); return; }
  // Merge: backup entries win, nothing already here is deleted.
  Object.assign(toySettings, data.toys ?? {});
  const mergeById = (mine, theirs) => [...mine.filter((p) => !theirs.some((t) => t.id === p.id)), ...theirs];
  customPatterns = mergeById(customPatterns, data.patterns ?? []);
  recordings = mergeById(recordings, data.recordings ?? []);
  const ok = store.set('toydeck.toys', toySettings) && store.set('toydeck.patterns', customPatterns) && store.set('toydeck.recordings', recordings);
  if (!ok) { say('Not enough browser storage to restore everything.', true); return; }
  for (const [key, saved] of Object.entries(toySettings)) {
    if (toys.has(key)) continue;
    const toy = makeToy(key, saved);
    toys.set(key, toy);
    buildToyCard(toy);
  }
  refreshPatternSelects();
  updateCount();
  say(`Restored ${Object.keys(data.toys ?? {}).length} toys, ${(data.patterns ?? []).length} patterns and ${(data.recordings ?? []).length} recordings. Tap Connect on each toy.`, true);
});

// ---------- pattern editor (shared patterns) ----------
const dlg = $('#pattern-dialog');
const pd = {
  select: $('#pd-select'), name: $('#pd-name'), bars: $('#pd-bars'), steps: $('#pd-steps'),
  stepMs: $('#pd-step-ms'), msg: $('#pd-msg'),
};
let editing = null; // { id, name, stepMs, steps }

function openEditor() {
  fillEditorSelect();
  if (customPatterns.length) loadIntoEditor(customPatterns[0]);
  else newPattern();
  pd.msg.textContent = '';
  dlg.showModal();
}
function fillEditorSelect() {
  pd.select.replaceChildren(
    new Option('— new pattern —', ''),
    ...customPatterns.map((p) => new Option(p.name, p.id)),
    ...BUILTIN.filter((p) => p.id !== '__try').map((p) => new Option(`${p.name} (copy)`, `copy:${p.id}`)),
  );
}
function newPattern() {
  editing = { id: '', name: 'My pattern', stepMs: 100, steps: Array(24).fill(0.5) };
  pd.select.value = '';
  renderEditor();
}
function loadIntoEditor(p, asCopy = false) {
  editing = { id: asCopy ? '' : p.id, name: asCopy ? `${p.name} copy` : p.name, stepMs: p.stepMs, steps: [...p.steps] };
  if (editing.steps.length < 8) editing.steps = Array(8).fill(editing.steps[0]);
  renderEditor();
}
function renderEditor() {
  pd.name.value = editing.name;
  const n = editing.steps.length;
  if (![...pd.steps.options].some((o) => +o.value === n)) pd.steps.append(new Option(String(n)));
  pd.steps.value = String(n);
  if (![...pd.stepMs.options].some((o) => +o.value === editing.stepMs)) pd.stepMs.append(new Option(`${editing.stepMs} ms`, editing.stepMs));
  pd.stepMs.value = String(editing.stepMs);
  pd.bars.replaceChildren(...editing.steps.map((v) => {
    const d = document.createElement('div');
    d.style.blockSize = `${Math.max(1, v * 100)}%`;
    return d;
  }));
}
let lastPaint = null; // previous {i, v} while dragging, so fast swipes fill every bar in between
function setBar(i, v) {
  editing.steps[i] = v < 0.04 ? 0 : +v.toFixed(2);
  pd.bars.children[i].style.blockSize = `${Math.max(1, editing.steps[i] * 100)}%`;
}
function paintAt(e) {
  const r = pd.bars.getBoundingClientRect();
  const i = clamp(Math.floor(((e.clientX - r.left) / r.width) * editing.steps.length), 0, editing.steps.length - 1);
  const v = clamp(1 - (e.clientY - r.top - 4) / (r.height - 8), 0, 1);
  if (lastPaint && lastPaint.i !== i) {
    const dir = Math.sign(i - lastPaint.i);
    for (let j = lastPaint.i + dir; j !== i; j += dir) {
      setBar(j, lastPaint.v + ((v - lastPaint.v) * (j - lastPaint.i)) / (i - lastPaint.i));
    }
  }
  setBar(i, v);
  lastPaint = { i, v };
}
pd.bars.addEventListener('pointerdown', (e) => { pd.bars.setPointerCapture(e.pointerId); lastPaint = null; paintAt(e); });
pd.bars.addEventListener('pointerup', () => { lastPaint = null; });
pd.bars.addEventListener('pointermove', (e) => { if (pd.bars.hasPointerCapture(e.pointerId)) paintAt(e); });
pd.select.addEventListener('change', () => {
  const v = pd.select.value;
  if (!v) newPattern();
  else if (v.startsWith('copy:')) loadIntoEditor(findPattern(v.slice(5)), true);
  else loadIntoEditor(customPatterns.find((p) => p.id === v));
});
pd.steps.addEventListener('change', () => {
  const n = +pd.steps.value;
  const old = editing.steps;
  editing.steps = Array.from({ length: n }, (_, i) => old[Math.floor((i * old.length) / n)]);
  renderEditor();
});
pd.stepMs.addEventListener('change', () => { editing.stepMs = +pd.stepMs.value; });
pd.name.addEventListener('input', () => { editing.name = pd.name.value; });
$('#pd-new').addEventListener('click', newPattern);
$('#pd-clear').addEventListener('click', () => { editing.steps.fill(0); renderEditor(); });
$('#pd-save').addEventListener('click', () => {
  const name = pd.name.value.trim();
  if (!name) { pd.msg.textContent = 'Give the pattern a name first.'; pd.name.focus(); return; }
  if (!editing.id) editing.id = `c${Date.now().toString(36)}`;
  const saved = { id: editing.id, name, stepMs: editing.stepMs, steps: [...editing.steps] };
  const i = customPatterns.findIndex((p) => p.id === saved.id);
  if (i >= 0) customPatterns[i] = saved; else customPatterns.push(saved);
  savePatterns();
  fillEditorSelect();
  pd.select.value = saved.id;
  pd.msg.textContent = `Saved “${name}”. It's now in every toy's pattern list (marked ★).`;
});
$('#pd-delete').addEventListener('click', () => {
  if (!editing.id) { newPattern(); return; }
  customPatterns = customPatterns.filter((p) => p.id !== editing.id);
  savePatterns();
  fillEditorSelect();
  pd.msg.textContent = 'Pattern deleted.';
  newPattern();
});
$('#pd-try').addEventListener('click', () => {
  const tmp = { id: '__try', name: 'Preview', stepMs: editing.stepMs, steps: [...editing.steps], builtin: true };
  const i = BUILTIN.findIndex((p) => p.id === '__try');
  if (i >= 0) BUILTIN[i] = tmp; else BUILTIN.push(tmp);
  for (const toy of toys.values()) { toy.mode = 'pattern'; toy.patternId = '__try'; toy.phase = 0; toy.running = true; syncToyUI(toy); }
  refreshPatternSelects();
  pd.msg.textContent = toys.size ? 'Playing on all toys. Press STOP ALL to stop.' : 'Connect a toy to try it.';
});
$('#patterns-btn').addEventListener('click', openEditor);

// ---------- startup ----------
// Show every toy connected before, so it's one tap (or zero) to get it back.
for (const [key, saved] of Object.entries(toySettings)) {
  const toy = makeToy(key, saved);
  toy.collapsed = true;   // toys already in the system open minimized: tap the card to open it
  toys.set(key, toy);
  buildToyCard(toy);
}
updateCount();

if (!('bluetooth' in navigator)) {
  $('#unsupported').hidden = false;
  $('#add-toy').disabled = true;
} else {
  $('#add-toy').addEventListener('click', addToy);
  autoReconnect();
}

// Install button (Chrome / Edge). Hidden unless the browser can actually install.
const installBtn = $('#install-app');
const supportsWebInstall = typeof Navigator.prototype.install === 'function';
let deferredPrompt;
if (supportsWebInstall) installBtn.hidden = false;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!supportsWebInstall) installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (installBtn.getAttribute('aria-disabled') === 'true') return;
  installBtn.setAttribute('aria-disabled', 'true');
  try {
    if (supportsWebInstall) {
      await navigator.install();
      installBtn.hidden = true;
    } else if (deferredPrompt) {
      const ev = deferredPrompt;
      deferredPrompt = undefined;
      await ev.prompt();
      const { outcome } = await ev.userChoice;
      say(outcome === 'accepted' ? 'ToyDeck installed.' : 'Install canceled.');
      if (!deferredPrompt) installBtn.hidden = true;
    }
  } catch (err) {
    say(err.name === 'AbortError' ? 'Install canceled.' : 'Install could not start.');
  } finally {
    installBtn.removeAttribute('aria-disabled');
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
