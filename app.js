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
// On/off extras. "Ripple" is JoyHub's separate wiggle/ripple command (A0 25), not a motor: a motor that
// wiggles is set up as motor Type "Wiggle" instead.
const EXTRAS = {
  light:   { label: 'Lights',  on: 'a014010001ff', off: 'a01400000000' },
  squeeze: { label: 'Squeeze', on: 'a00d000001ff', off: 'a00d00000000' },
  ripple:  { label: 'Ripple',  on: 'a025010001ff', off: 'a02500000000' },
  squirt:  { label: 'Squirt',  on: 'a024010001ff', off: 'a02400000000' },
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
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { return false; }
    onStoreSet?.(key);   // device sync watches its keys
    return true;
  },
};
let onStoreSet = null;
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
// What each motor does. The All toys panel can switch one kind on/off across every toy.
// "Suction" here is a motor channel (A0 03): JoyHub drives a toy's suction that way when the toy's suction has
// no level steps (e.g. J-Rosella 2). Toys whose suction takes levels use "Suction levels" (A0 07) instead.
// "Flipper" = a motor that flips/flicks (tapping tongue or flap): an ordinary motor channel, named for what it does.
const MOTOR_TYPES = { vibe: 'Vibe', thrust: 'Thrust', wiggle: 'Wiggle', flip: 'Flipper', suction: 'Suction' };
// Panel rows for motors are per numbered motor: "vibe1" = every toy's 1st vibe motor, "vibe2" its 2nd, ...
const MOTOR_FN = /^(vibe|thrust|wiggle|flip|suction)([1-4])$/;
const isMotorFn = (fn) => MOTOR_FN.test(fn);
const groupLevels = {};   // panel level per row ("vibe1", "thrust1"...)
const groupLevel = (fn) => groupLevels[fn] ?? 0.5;
// Override on: the panel's levels drive every motor on every toy. Off (the default): each toy uses its own sliders.
// New key 'toydeck.overrideOn' (was 'toydeck.override', default on) so every device starts Off once after the change.
let overrideOn = store.get('toydeck.overrideOn', false) === true;
// Panel off: the All toys panel has no effect on any toy (no override, no master level, no group switches).
let panelOn = store.get('toydeck.panelOn', true) !== false;
const panelOverrides = () => panelOn && overrideOn;
let groupSig = '';                                // which function rows the panel currently shows

// Name shown in the app. Every JoyHub toy's Bluetooth name starts with "J-" (J-Phantom, J-Pinhead...),
// so it's left off on screen. toy.name keeps the real name: reconnecting and pictures match on it.
function shownName(toy) {
  return String(toy.name ?? '').replace(/^J[-_ ]+(?=\S)/i, '') || toy.name;
}
function fitSlots(slots, n) {
  const out = (slots ?? []).slice(0, n);
  for (let s = 1; out.length < n; s++) if (!out.includes(s)) out.push(s);
  return out;
}
// Minimum power per motor (0-200 raw). Older saves (and older app versions) have one number for the whole toy.
const readMinPowers = (s) => Array.from({ length: 4 }, (_, i) => clamp(Math.round(
  (Array.isArray(s?.minPowers) ? s.minPowers[i] : s?.minPower) ?? 0) || 0, 0, 200));
// Slider limits per motor, in % ([low, high]): the motor's slider can't be moved outside them (the [ ] brackets).
const readLimits = (s) => Array.from({ length: 4 }, (_, i) => {
  const l = s?.limits?.[i];
  const lo = clamp(Math.round(+l?.[0] || 0), 0, 99);
  const hi = clamp(Math.round(l?.[1] == null ? 100 : +l[1] || 0), lo + 1, 100);
  return [lo, hi];
});
const readLimitLocks = (s) => Array.from({ length: 4 }, (_, i) => s?.limitLocks?.[i] === true);   // 🔒: brackets can't move
const limitLevel = (toy, m, v) => clamp(v, toy.limits[m][0] / 100, toy.limits[m][1] / 100);
function saveToySettings(toy) {
  toySettings[toy.key] = {
    motors: toy.motors, slots: toy.slots, minPowers: toy.minPowers, minPower: toy.minPowers[0], limits: toy.limits, limitLocks: toy.limitLocks, linked: toy.linked, levels: toy.levels, name: toy.name,
    hasHeat: toy.hasHeat, hasSuck: toy.hasSuck, suckLevels: toy.suckLevels, motorTypes: toy.motorTypes,
    extras: Object.keys(EXTRAS).filter((k) => toy.hasExtra[k]),
  };
  store.set('toydeck.toys', toySettings);
  renderGroups();
}

function makeToy(key, saved = {}) {
  const motors = saved.motors ?? 1;
  return {
    key,
    device: null,
    name: saved.name || 'Toy',
    motors,
    slots: fitSlots(saved.slots, motors),
    motorTypes: Array.from({ length: 4 }, (_, i) => (saved.motorTypes?.[i] in MOTOR_TYPES ? saved.motorTypes[i] : 'vibe')),
    minPowers: readMinPowers(saved),   // per motor
    limits: readLimits(saved),         // per motor slider [low, high] %
    limitLocks: readLimitLocks(saved), // per motor: limits locked
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
    hasExtra: Object.fromEntries(Object.keys(EXTRAS).map((k) => [k, (saved.extras ?? []).includes(k)])),
    extraOn: Object.fromEntries(Object.keys(EXTRAS).map((k) => [k, false])),   // extras always start off
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
  if (toy?.connected) { say(`${shownName(toy)} is already connected.`); return; }
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
    if (err.name === 'NotFoundError') say(`${shownName(toy)} wasn't picked. Make sure it's switched on and nearby.`);
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
    for (const k of Object.keys(EXTRAS)) toy.extraOn[k] = false;
    toy.suck = 0;
    if (toy.ui) renderFeatures(toy);
    readBattery(toy, server);
    say(`${shownName(toy)} connected.`);
    return true;
  } catch (err) {
    toy.connected = false;
    try { toy.device.gatt.disconnect(); } catch { /* not connected */ }
    if (!quiet) {
      if (err.name === 'NotFoundError' || /FFA0|service/i.test(err.message)) {
        say(`${shownName(toy)} doesn't look like a supported toy (no FFA0 service).`, true);
      } else {
        say(`Couldn't connect to ${shownName(toy)}: ${err.message}. Is it on and nearby?`, true);
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

function motorByte(toy, level, m) {
  if (level <= 0.001) return 0;
  const min = toy.minPowers[m] ?? 0;
  return Math.round(clamp(min + (255 - min) * level, 1, 255));
}

// Levels from the sliders, before the master level (what recordings capture).
// A motor that's switched Off sends 0 but keeps its slider position.
// Nothing runs until the card's Start button is pressed (toy.running).
function manualLevels(toy) {
  return Array.from({ length: toy.motors }, (_, m) => {
    const i = toy.linked ? 0 : m;
    return toy.running && toy.enabled[i] ? effectiveLevel(toy, m) : 0;
  });
}
// A motor's level: the All toys panel's level for its type when that type is on Override, else its own slider.
function effectiveLevel(toy, m) {
  if (panelOverrides()) return groupLevel(slotKey(toy, m));
  const i = toy.linked ? 0 : m;
  return limitLevel(toy, i, toy.levels[i]);   // a level saved before its limits were set still obeys them
}
function overridden() { return panelOverrides(); }

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
  return out.map((v) => clamp(v * (panelOn ? masterLevel : 1), 0, 1));
}

function buildCommand(toy) {
  const values = Array(Math.max(MIN_SLOTS, ...toy.slots)).fill(0);
  currentLevels(toy).forEach((l, m) => {
    const i = toy.slots[m] - 1;
    values[i] = Math.max(values[i], motorByte(toy, l, m));
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
    if (!toy.connected || toy.motors === 0) continue;   // 0 motors (e.g. suction only): no motor commands
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
  say(`Recording ${shownName(toy)}. Move the sliders, then press Stop.`);
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
  toy.ui.recName.value = `${shownName(toy)} ${count}`;
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
  say(`Saved “${name}” for ${shownName(toy)}. It's selected under Pattern (marked ●) — press Start to play it.`);
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
  toy.ui.running.hidden = !toy.running || toy.motors === 0;
}
// Full stop (STOP ALL, leaving the app): motors, suction and heat.
function stopToy(toy) {
  if (toy.rec) finishRecording(toy);
  toy.running = false;   // keeps mode, sliders and motor On/Off as they were; Start carries on
  const heatWasOn = toy.heat;
  const suckWasOn = toy.suck > 0;
  const extrasWereOn = extrasOn(toy);
  toy.heat = false;
  toy.suck = 0;
  for (const k of extrasWereOn) toy.extraOn[k] = false;
  syncToyUI(toy);
  renderFeatures(toy);
  if (!toy.connected) return;
  toy.lastHex = toHex(STOP_BYTES);
  toy.lastSentAt = performance.now();
  if (toy.motors > 0) send(toy, STOP_BYTES, true);
  if (suckWasOn) sendRepeated(toy, SUCK_OFF);
  if (heatWasOn) sendRepeated(toy, HEAT_OFF);
  for (const k of extrasWereOn) sendRepeated(toy, EXTRAS[k].off);
}
function extrasOn(toy) { return Object.keys(EXTRAS).filter((k) => toy.extraOn[k]); }
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
        if (toy.motors > 0) c.writeValueWithoutResponse(STOP_BYTES);
        if (toy.suck) c.writeValueWithoutResponse(hexToBytes(SUCK_OFF));
        if (toy.heat) c.writeValueWithoutResponse(hexToBytes(HEAT_OFF));
        for (const k of extrasOn(toy)) c.writeValueWithoutResponse(hexToBytes(EXTRAS[k].off));
      } catch { /* page is going away */ }
    }
  }
});

// Switch-type commands are sent 3 times, like the official app does.
function sendRepeated(toy, hex) {
  const bytes = hexToBytes(hex);
  for (let i = 0; i < 3; i++) send(toy, bytes, true);
}
function setExtra(toy, name, on) {
  toy.extraOn[name] = on;
  sendRepeated(toy, on ? EXTRAS[name].on : EXTRAS[name].off);
  renderFeatures(toy);
}
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
    const cmds = toy.motors > 0 ? [STOP_BYTES] : [];
    if (toy.suck) cmds.push(hexToBytes(SUCK_OFF));
    if (toy.heat) cmds.push(hexToBytes(HEAT_OFF));
    for (const k of extrasOn(toy)) { cmds.push(hexToBytes(EXTRAS[k].off)); toy.extraOn[k] = false; }
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
  say(`Forgot ${shownName(toy)} and its recordings.`);
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
  jfaunus: 'toys/j-faunus.webp',
  jflamewing: 'toys/j-flamewing.webp',
  jphantom: 'toys/j-phantom.webp',
  jpetalwish: 'toys/j-petalwish.webp',   // J-Petalwish2 etc. match by prefix
  jpinhead: 'toys/j-pinhead.webp',
  jpunch: 'toys/j-punch.webp',
  jrhythmic3: 'toys/j-rhythmic3.webp',
  jrosella: 'toys/j-rosella.webp',       // J-ROSELLA2 matches by prefix
  jroyaleye: 'toys/j-royaleye.webp',
  jviele: 'toys/j-viele.webp',
  jvividwings: 'toys/j-vividwings.webp',
};
const FALLBACK_PIC = 'icons/icon.svg';
function toyPicture(name) {
  let n = String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!TOY_PICS[n] && !Object.keys(TOY_PICS).some((k) => n.startsWith(k))) n = 'j' + n;   // named without "J-" ("Petalwish2")
  if (TOY_PICS[n]) return TOY_PICS[n];
  // Names sometimes carry a suffix ("J-Phantom-2", "J-Phantom 01"): longest key the name starts with wins.
  const key = Object.keys(TOY_PICS).filter((k) => n.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? TOY_PICS[key] : null;
}

function renderToyName(toy) {
  const { ui } = toy;
  if (!ui) return;
  ui.name.textContent = shownName(toy);
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
  ui.head.title = collapsed ? `Open ${shownName(toy)}'s controls` : `Minimize ${shownName(toy)}`;
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
    minpowers: $('.minpowers', el),
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
    if (+ui.motors.value === 0 && toy.motors > 0) {   // no motors left: stop the ones that may be running
      toy.running = false;
      if (toy.connected) send(toy, STOP_BYTES, true);
    }
    toy.motors = +ui.motors.value;
    toy.slots = fitSlots(toy.slots, toy.motors);
    saveToySettings(toy);
    syncToyUI(toy);
  });
  el.querySelectorAll('[data-has-extra]').forEach((cb) => {
    const k = cb.dataset.hasExtra;
    cb.checked = toy.hasExtra[k];
    cb.addEventListener('change', () => {
      toy.hasExtra[k] = cb.checked;
      if (!cb.checked && toy.extraOn[k]) setExtra(toy, k, false);
      saveToySettings(toy);
      renderFeatures(toy);
    });
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
  const extras = Object.keys(EXTRAS).filter((k) => toy.hasExtra[k]);
  ui.features.hidden = !toy.hasHeat && !toy.hasSuck && !extras.length;
  const extraButtons = extras.map((k) => {
    const row = document.createElement('div');
    row.className = 'feature';
    const name = document.createElement('span');
    name.textContent = EXTRAS[k].label;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'motor-toggle';
    b.textContent = toy.extraOn[k] ? 'On' : 'Off';
    b.setAttribute('aria-pressed', String(toy.extraOn[k]));
    b.setAttribute('aria-label', `${EXTRAS[k].label} on or off`);
    b.addEventListener('click', () => setExtra(toy, k, !toy.extraOn[k]));
    row.append(name, b);
    return row;
  });
  $('.extra-rows', ui.el).replaceChildren(...extraButtons.map((r) => r));
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
  extraButtons.forEach((r) => { $('button', r).disabled = disabled; });
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
  const count = toy.motors === 0 ? 0 : toy.linked ? 1 : toy.motors;
  toy.ui.sliders.replaceChildren();
  for (let m = 0; m < count; m++) {
    const row = document.createElement('div');
    row.className = 'motor-row';
    const types = toy.linked ? new Set(toy.motorTypes.slice(0, toy.motors)) : new Set([toy.motorTypes[m]]);
    if (types.size === 1) row.classList.add(`type-${[...types][0]}`);   // slider colour: vibe green, thrust orange...
    const label = document.createElement('label');
    label.className = 'slider-label';
    const title = toy.linked ? linkedTitle(toy) : motorTitle(toy, m);
    const locked = overridden(toy, m);
    const motor = toy.linked ? 0 : m;
    const pct = Math.round((locked ? effectiveLevel(toy, motor) : limitLevel(toy, m, toy.levels[m])) * 100);
    label.innerHTML = `<span><span class="motor-name">${title}</span><output>${locked ? `All toys ${pct}%` : `${pct}%`}</output></span>`
      + `<div class="range-wrap"><input type="range" min="0" max="100" value="${pct}"></div>`;
    const input = $('input', label);
    const out = $('output', label);
    const lockBtn = locked ? null : addLimitBrackets(toy, m, $('.range-wrap', label), input, out, title);
    if (locked) {
      input.disabled = true;   // the All toys panel sets this level (Override); turn Override off to use this slider
      row.classList.add('overridden');
      row.title = 'Set by the All toys panel (Override is on)';
    }
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
      const [lo, hi] = toy.limits[m];
      if (+input.value < lo || +input.value > hi) input.value = String(clamp(+input.value, lo, hi));   // never past a bracket
      const v = input.value / 100;
      if (toy.linked) toy.levels.fill(v); else toy.levels[m] = v;
      out.value = `${input.value}%`;
      if (!toy.enabled[m]) setOn(true);   // moving a slider switches its motor on
    });
    input.addEventListener('change', () => saveToySettings(toy));
    row.append(label, btn);
    if (lockBtn) { row.append(lockBtn); row.classList.add('has-lock'); }   // right of On/Off: away from the slider
    toy.ui.sliders.append(row);
  }
  toy.ui.link.closest('label').hidden = toy.motors < 2;
}

// The [ and ] on a motor slider: drag them in to set the lowest and highest level that slider can reach,
// so a slip of the finger can't go past them (handy while recording). Linked sliders set every motor's limits.
const THUMB_PX = 16;   // native range thumb width: brackets sit just outside the thumb at each limit
const LOCK_SVG = (closed) => `<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><rect x="3" y="7" width="10" height="8" rx="1.5" fill="currentColor"/>`
  + `<path d="${closed ? 'M5 7V5a3 3 0 0 1 6 0v2' : 'M5 7V5a3 3 0 0 1 5.8-1'}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
function addLimitBrackets(toy, m, wrap, input, out, title) {
  // Lock: once the limits are right, lock them so the brackets can't be moved by accident. The slider still works.
  const lockBtn = document.createElement('button');
  lockBtn.type = 'button';
  lockBtn.className = 'lim-lock';
  const isLocked = () => toy.limitLocks[m];
  const drawLock = () => {
    const on = isLocked();
    lockBtn.innerHTML = LOCK_SVG(on);
    lockBtn.setAttribute('aria-pressed', String(on));
    lockBtn.setAttribute('aria-label', `${title} limits ${on ? 'locked: tap to unlock' : 'unlocked: tap to lock'}`);
    lockBtn.title = on ? 'Limits locked — tap to unlock' : 'Lock these limits';
    wrap.classList.toggle('lim-locked', on);
    for (const h of Object.values(handles)) {
      h.tabIndex = on ? -1 : 0;
      h.setAttribute('aria-disabled', String(on));
    }
  };
  lockBtn.addEventListener('click', (e) => {
    e.preventDefault();   // inside the label: don't hand the tap to the slider
    const on = !isLocked();
    if (toy.linked) toy.limitLocks.fill(on); else toy.limitLocks[m] = on;
    hideTip();
    drawLock();
    saveToySettings(toy);
  });
  const shade = [document.createElement('i'), document.createElement('i')];
  shade[0].className = 'lim-shade lo';
  shade[1].className = 'lim-shade hi';
  const mk = (side) => {
    const h = document.createElement('span');
    h.className = `lim lim-${side}`;
    h.tabIndex = 0;
    h.setAttribute('role', 'slider');
    h.setAttribute('aria-label', `${title} ${side === 'lo' ? 'lowest' : 'highest'} level`);
    h.setAttribute('aria-valuemin', '0');
    h.setAttribute('aria-valuemax', '100');
    return h;
  };
  const handles = { lo: mk('lo'), hi: mk('hi') };
  const pos = (p) => `calc(${THUMB_PX / 2}px + (100% - ${THUMB_PX}px) * ${p / 100})`;
  // Number bubble above the slider while it's held: "Min 30%" / "Max 70%" on a bracket, the level on the thumb.
  const tip = document.createElement('b');
  tip.className = 'lim-tip';
  tip.setAttribute('aria-hidden', 'true');
  let tipFor = null;   // 'lo' | 'hi' | 'level' while shown
  let tipTimer = 0;
  const updateTip = () => {
    if (!tipFor) return;
    const [lo, hi] = toy.limits[m];
    const p = tipFor === 'lo' ? lo : tipFor === 'hi' ? hi : clamp(+input.value, lo, hi);
    tip.textContent = tipFor === 'lo' ? `Min ${p}%` : tipFor === 'hi' ? `Max ${p}%` : `${p}%`;
    const edge = tipFor === 'lo' ? ` - ${THUMB_PX / 2}px` : tipFor === 'hi' ? ` + ${THUMB_PX / 2}px` : '';
    tip.style.left = `calc(${pos(p)}${edge})`;
    tip.style.translate = `${-p}% 0`;   // centred mid-track, kept inside the slider at either end
  };
  const showTip = (kind, ms = 0) => {
    clearTimeout(tipTimer);
    tipFor = kind;
    updateTip();
    tip.classList.add('show');
    if (ms) tipTimer = setTimeout(hideTip, ms);
  };
  const hideTip = () => { clearTimeout(tipTimer); tipFor = null; tip.classList.remove('show'); };
  input.addEventListener('pointerdown', () => {
    showTip('level');
    addEventListener('pointerup', hideTip, { once: true });
    addEventListener('pointercancel', hideTip, { once: true });
  });
  input.addEventListener('input', updateTip);
  input.addEventListener('change', () => { if (tipFor === 'level') hideTip(); });
  const draw = () => {
    const [lo, hi] = toy.limits[m];
    handles.lo.style.left = `calc(${pos(lo)} - ${THUMB_PX / 2}px)`;
    handles.hi.style.left = `calc(${pos(hi)} + ${THUMB_PX / 2}px)`;
    handles.lo.setAttribute('aria-valuenow', String(lo));
    handles.hi.setAttribute('aria-valuenow', String(hi));
    shade[0].style.width = `calc(${pos(lo)} - ${THUMB_PX / 2}px)`;
    shade[1].style.left = `calc(${pos(hi)} + ${THUMB_PX / 2}px)`;
    wrap.classList.toggle('limited', lo > 0 || hi < 100);
    wrap.title = lo > 0 || hi < 100 ? `Limited to ${lo}–${hi}%` : '';
    updateTip();
  };
  const set = (side, p) => {
    const l = [...toy.limits[m]];
    if (side === 'lo') l[0] = clamp(Math.round(p), 0, l[1] - 1); else l[1] = clamp(Math.round(p), l[0] + 1, 100);
    if (toy.linked) toy.limits.forEach((_, i) => { toy.limits[i] = [...l]; }); else toy.limits[m] = l;
    // the level follows a bracket that's pushed past it
    const v = clamp(+input.value, l[0], l[1]);
    if (v !== +input.value) {
      input.value = String(v);
      if (toy.linked) toy.levels.fill(v / 100); else toy.levels[m] = v / 100;
      out.value = `${v}%`;
    }
    draw();
  };
  for (const [side, h] of Object.entries(handles)) {
    h.addEventListener('click', (e) => e.preventDefault());   // inside the label: don't hand the tap to the slider
    h.addEventListener('pointerdown', (e) => {
      if (isLocked()) return;
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      h.classList.add('dragging');
      showTip(side);
      const move = (ev) => {
        const r = input.getBoundingClientRect();
        const x = ev.clientX - r.left + (side === 'lo' ? THUMB_PX / 2 : -THUMB_PX / 2);   // the bracket is beside the thumb
        set(side, ((x - THUMB_PX / 2) / (r.width - THUMB_PX)) * 100);
      };
      move(e);
      const up = () => {
        h.classList.remove('dragging');
        hideTip();
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        saveToySettings(toy);
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
    h.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 }[e.key];
      if (!step || isLocked()) return;
      e.preventDefault();
      showTip(side, 1200);
      set(side, toy.limits[m][side === 'lo' ? 0 : 1] + step * (e.shiftKey ? 10 : 1));
      saveToySettings(toy);
    });
  }
  wrap.append(shade[0], shade[1], handles.lo, handles.hi, tip);
  drawLock();
  draw();
  return lockBtn;   // the caller puts it at the end of the row
}

// Slider names: "Vibe" / "Thrust", numbered when a toy has two of the same kind.
function motorTitle(toy, m) {
  const type = toy.motorTypes[m];
  const same = Array.from({ length: toy.motors }, (_, i) => i).filter((i) => toy.motorTypes[i] === type);
  return same.length > 1 ? `${MOTOR_TYPES[type]} ${same.indexOf(m) + 1}` : MOTOR_TYPES[type];
}
function linkedTitle(toy) {
  const types = new Set(toy.motorTypes.slice(0, toy.motors));
  return types.size === 1 ? MOTOR_TYPES[[...types][0]] : 'All motors';
}

function renderSlotMap(toy) {
  const box = $('.slot-map', toy.ui.el);
  box.replaceChildren(...toy.slots.map((slot, m) => {
    const row = document.createElement('div');
    row.className = 'row wrap';
    const name = document.createElement('strong');
    name.textContent = `Motor ${m + 1}`;
    const typeLabel = document.createElement('label');
    typeLabel.className = 'inline';
    typeLabel.textContent = 'Type ';
    const typeSel = document.createElement('select');
    for (const [value, text] of Object.entries(MOTOR_TYPES)) typeSel.append(new Option(text, value));
    typeSel.value = toy.motorTypes[m];
    typeSel.addEventListener('change', () => {
      toy.motorTypes[m] = typeSel.value;
      saveToySettings(toy);
      renderSliders(toy);
      renderMinPowers(toy);   // names and colours follow the type
    });
    typeLabel.append(typeSel);
    const chLabel = document.createElement('label');
    chLabel.className = 'inline';
    chLabel.textContent = 'Channel ';
    const sel = document.createElement('select');
    for (let s = 1; s <= 4; s++) sel.append(new Option(String(s), String(s)));
    sel.value = String(slot);
    sel.addEventListener('change', () => { toy.slots[m] = +sel.value; saveToySettings(toy); });
    chLabel.append(sel);
    row.append(name, typeLabel, chLabel);
    return row;
  }));
  renderMinPowers(toy);
}

// Minimum power: one slider per motor, named and coloured like its level slider ("Vibe", "Thrust 2"...).
// Motors on one toy can stall at different levels, so each gets its own floor.
function renderMinPowers(toy) {
  const box = toy.ui.minpowers;
  box.hidden = toy.motors === 0;
  box.replaceChildren(...Array.from({ length: toy.motors }, (_, m) => {
    const row = document.createElement('div');
    row.className = `type-${toy.motorTypes[m]}`;
    const label = document.createElement('label');
    label.className = 'slider-label';
    label.innerHTML = `<span>${motorTitle(toy, m)} minimum <output>${toy.minPowers[m]}</output></span><input type="range" min="0" max="200" value="${toy.minPowers[m]}">`;
    const input = $('input', label);
    const out = $('output', label);
    input.setAttribute('aria-label', `${motorTitle(toy, m)} minimum power`);
    input.addEventListener('input', () => { toy.minPowers[m] = +input.value; out.value = input.value; });
    input.addEventListener('change', () => saveToySettings(toy));
    row.append(label);
    return row;
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
  const noMotors = toy.motors === 0;   // e.g. a suction-only toy: just its feature controls
  $('.mode-row', ui.el).hidden = noMotors;
  ui.manual.hidden = noMotors || toy.mode !== 'manual';
  ui.pattern.hidden = noMotors || toy.mode !== 'pattern';
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
  renderGroups();
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
    [toy ? `Recorded on ${shownName(toy)}` : '', own],
  ];
  sel.replaceChildren(...groups.filter(([, list]) => list.length).map(([label, list]) => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...list.map((p) => new Option(p.recorded ? `● ${p.name}` : p.builtin ? p.name : `★ ${p.name}`, p.id)));
    return g;
  }));
  const valid = toy ? patternsFor(toy) : sharedPatterns();
  const want = toy ? toy.patternId : sel.dataset.value || 'wave';
  if (!toy) sel.prepend(new Option('Manual (no pattern)', '__manual'));   // Pattern for all: back to sliders
  sel.value = !toy && want === '__manual' ? want : valid.some((p) => p.id === want) ? want : BUILTIN[0].id;
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
master.addEventListener('input', () => {
  masterLevel = master.value / 100;
  $('#master-out').value = `${master.value}%`;
  refreshMasterTag();
});

// "All toys" panel minimizes like a toy card (starts minimized). STOP ALL is outside it, so it's always showing.
const masterCard = $('.master');
const masterToggle = $('#master-toggle');
function setMasterCollapsed(collapsed) {
  masterCard.classList.toggle('collapsed', collapsed);
  $('#master-body').hidden = collapsed;
  masterToggle.setAttribute('aria-expanded', String(!collapsed));
  masterToggle.title = collapsed ? 'Open the controls for all toys' : 'Minimize';
  $('#master-hint').textContent = collapsed ? 'Tap to open controls' : '';
  refreshMasterTag();
}
// While minimized, show the master level if it's turned down, so weaker toys aren't a mystery.
function refreshMasterTag() {
  const tag = $('#master-tag');
  if (!panelOn) {   // always say so: the panel isn't doing anything
    tag.textContent = 'Panel off';
    tag.hidden = false;
    return;
  }
  tag.textContent = `Master ${master.value}%`;
  tag.hidden = !masterCard.classList.contains('collapsed') || +master.value === 100;
}
masterToggle.addEventListener('click', () => setMasterCollapsed(!masterCard.classList.contains('collapsed')));
setMasterCollapsed(true);

// ---------- functions across all toys ("Turn on by function" in the All toys panel) ----------
// Only connected toys are ever changed, so nothing starts by surprise when a toy connects later.
// Which panel row a motor belongs to: its type plus its number among the toy's motors of that type.
function slotKey(toy, m) {
  const type = toy.motorTypes[m];
  let n = 0;
  for (let i = 0; i <= m; i++) if (toy.motorTypes[i] === type) n++;
  return `${type}${n}`;
}
function motorsOfFn(toy, fn) {
  return Array.from({ length: toy.motors }, (_, m) => m).filter((m) => slotKey(toy, m) === fn);
}
function motorsOfType(toy, type) {
  return Array.from({ length: toy.motors }, (_, m) => m).filter((m) => toy.motorTypes[m] === type);
}
function liveToys() { return [...toys.values()].filter((t) => t.connected); }
function typeActive(toy, type) {
  const ms = motorsOfFn(toy, type);
  if (!toy.connected || !toy.running || !ms.length) return false;
  if (toy.mode === 'pattern') return true;
  return ms.some((m) => toy.enabled[toy.linked ? 0 : m] && effectiveLevel(toy, m) > 0);
}
// A linked toy needs separate sliders to run only some of its motors.
function separateIfMixed(toy, ms) {
  if (!toy.linked || ms.length >= toy.motors) return;
  toy.linked = false;
  if (toy.ui) toy.ui.link.checked = false;
}
function refreshToyCard(toy) {
  saveToySettings(toy);
  if (toy.ui) syncToyUI(toy);
}

function groupMotorsOn(type) {
  if (!panelOn) return;
  for (const toy of liveToys()) {
    const ms = motorsOfFn(toy, type);
    if (!ms.length) continue;
    if (toy.rec) finishRecording(toy);
    const wasRunning = toy.running && toy.mode === 'manual';
    if (toy.mode !== 'manual') { toy.mode = 'manual'; toy.phase = 0; }   // the panel drives the sliders
    separateIfMixed(toy, ms);
    for (let m = 0; m < toy.motors; m++) {
      const i = toy.linked ? 0 : m;
      if (ms.includes(m)) {   // this row's motor(s)
        toy.enabled[i] = true;
        // Override off = the toy's own slider; give it a starting level if it's at 0.
        if (!overrideOn && toy.levels[i] === 0) toy.levels[i] = limitLevel(toy, i, groupLevel(type));
      } else if (!wasRunning) toy.enabled[i] = false;   // a stopped toy starts with only this function
    }
    if (toy.linked) { toy.enabled.fill(true); toy.levels.fill(toy.levels[0]); }
    toy.running = true;
    refreshToyCard(toy);
  }
}
function groupMotorsOff(type) {
  if (!panelOn) return;
  for (const toy of liveToys()) {
    const ms = motorsOfFn(toy, type);
    if (!ms.length || !toy.running) continue;
    if (toy.mode === 'pattern') { setRunning(toy, false); continue; }   // a pattern drives all motors together
    separateIfMixed(toy, ms);
    if (toy.linked) toy.enabled.fill(false); else ms.forEach((m) => { toy.enabled[m] = false; });
    if (!toy.enabled.slice(0, toy.motors).some(Boolean)) toy.running = false;
    refreshToyCard(toy);
  }
}
// Panel slider (Override on): sets that motor type's level on every toy, over the toys' own sliders.
function groupMotorsLevel(type, level) {
  if (!panelOn) return;
  groupLevels[type] = level;
  const active = liveToys().some((t) => typeActive(t, type) && t.mode === 'manual');
  if (!active && level > 0) groupMotorsOn(type);   // moving the slider switches it on, like a toy's slider
  for (const toy of toys.values()) if (toy.ui && motorsOfFn(toy, type).length) renderSliders(toy);
}
function setOverride(on) {
  overrideOn = on;
  store.set('toydeck.overrideOn', on);
  for (const toy of toys.values()) if (toy.ui) renderSliders(toy);
  refreshGroups();
}
$('#override-all').addEventListener('click', () => setOverride(!overrideOn));

// Panel On/Off. Off leaves every toy running exactly as it is, on its own settings; STOP ALL is unaffected.
function setPanelOn(on) {
  panelOn = on;
  store.set('toydeck.panelOn', on);
  const btn = $('#panel-power');
  btn.textContent = on ? 'On' : 'Off';
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', `All toys panel ${on ? 'on' : 'off'}`);
  masterCard.classList.toggle('panel-off', !on);
  $('#panel-off-note').hidden = on;
  for (const id of ['#master', '#all-pattern', '#apply-all', '#sync-all']) $(id).disabled = !on;
  for (const toy of toys.values()) if (toy.ui) renderSliders(toy);
  refreshMasterTag();
  refreshGroups();
}
$('#panel-power').addEventListener('click', () => setPanelOn(!panelOn));

// Rows: one per function that at least one saved toy has. Rebuilt only when that list changes.
function groupFunctions() {
  const all = [...toys.values()];
  const fns = [];
  for (const type of Object.keys(MOTOR_TYPES)) {
    const most = Math.max(0, ...all.map((t) => motorsOfType(t, type).length));
    for (let n = 1; n <= most; n++) fns.push(`${type}${n}`);
  }
  if (all.some((t) => t.hasHeat)) fns.push('heat');
  const suck = Math.max(0, ...all.filter((t) => t.hasSuck).map((t) => t.suckLevels));
  if (suck) fns.push(`suck${suck}`);
  for (const k of Object.keys(EXTRAS)) if (all.some((t) => t.hasExtra[k])) fns.push(k);
  return fns;
}
function hasFunction(toy, fn) {
  if (isMotorFn(fn)) return motorsOfFn(toy, fn).length > 0;
  if (fn === 'heat') return toy.hasHeat;
  if (fn in EXTRAS) return toy.hasExtra[fn];
  return toy.hasSuck;
}
function functionOn(toy, fn) {
  if (isMotorFn(fn)) return typeActive(toy, fn);
  if (fn === 'heat') return toy.heat;
  if (fn in EXTRAS) return toy.extraOn[fn];
  return toy.suck > 0;
}
function renderGroups() {
  const box = document.getElementById('group-rows');
  if (!box) return;
  const fns = groupFunctions();
  const sig = fns.join(',');
  if (sig !== groupSig) {
    groupSig = sig;
    $('#groups').hidden = !fns.length;
    box.replaceChildren(...fns.map((fn) => buildGroupRow(fn, fns)));
  }
  refreshGroups();
}
function onOffButton(label) {
  return `<button type="button" class="motor-toggle group-toggle" aria-label="${label} on all toys, on or off">Off</button>`;
}
function buildGroupRow(fn, fns) {
  const row = document.createElement('div');
  row.dataset.fn = fn;
  let name = fn === 'heat' ? 'Heat' : fn in EXTRAS ? EXTRAS[fn].label : 'Suction levels';
  if (isMotorFn(fn)) {
    const [, type, n] = fn.match(MOTOR_FN);
    name = fns.includes(`${type}2`) ? `${MOTOR_TYPES[type]} ${n}` : MOTOR_TYPES[type];   // "Vibe 1", or just "Thrust"
  }
  const head = `<span class="group-name">${name} <small class="group-count muted"></small></span>`;
  if (isMotorFn(fn)) {
    row.className = `motor-row group-row group-motor type-${fn.match(MOTOR_FN)[1]}`;
    const pct = Math.round(groupLevel(fn) * 100);
    row.innerHTML = `<label class="slider-label"><span>${head}<output>${pct}%</output></span>
      <input type="range" min="0" max="100" value="${pct}" aria-label="${name} level on all toys">
      <small class="group-own muted">Each toy uses its own ${name} slider (Override is off)</small></label>
      ${onOffButton(name)}`;
    const input = $('input', row);
    input.addEventListener('input', () => { $('output', row).value = `${input.value}%`; groupMotorsLevel(fn, input.value / 100); });
    $('.group-toggle', row).addEventListener('click', () => {
      if (liveToys().some((t) => typeActive(t, fn))) groupMotorsOff(fn); else groupMotorsOn(fn);
      refreshGroups();
    });
  } else if (fn.startsWith('suck')) {
    const max = +fn.slice(4);
    row.className = 'feature group-row';
    row.innerHTML = `${head}<div class="levels" role="group" aria-label="Suction level on all toys"></div>`;
    $('.levels', row).append(...Array.from({ length: max + 1 }, (_, level) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.level = String(level);
      b.textContent = level === 0 ? 'Off' : String(level);
      b.addEventListener('click', () => {
        if (!panelOn) return;
        for (const toy of liveToys()) if (toy.hasSuck) setSuction(toy, Math.min(level, toy.suckLevels));
        refreshGroups();
      });
      return b;
    }));
  } else {   // heat and the on/off extras
    row.className = 'feature group-row';
    row.innerHTML = `${head}${onOffButton(name)}`;
    $('.group-toggle', row).addEventListener('click', () => {
      if (!panelOn) return;
      const on = !liveToys().some((t) => hasFunction(t, fn) && functionOn(t, fn));
      for (const toy of liveToys()) {
        if (!hasFunction(toy, fn)) continue;
        if (fn === 'heat') setHeat(toy, on); else setExtra(toy, fn, on);
      }
      refreshGroups();
    });
  }
  return row;
}
// Cheap: called every 250 ms so the buttons always match what the toys are doing.
function refreshGroups() {
  const box = document.getElementById('group-rows');
  if (!box || $('#groups').hidden) return;
  const ov = $('#override-all');
  ov.setAttribute('aria-pressed', String(overrideOn));
  ov.disabled = !panelOn;
  const live = liveToys();
  for (const row of box.children) {
    const fn = row.dataset.fn;
    const have = live.filter((t) => hasFunction(t, fn));
    const count = $('.group-count', row);
    const text = have.length ? `· ${have.length} toy${have.length > 1 ? 's' : ''}` : '· none connected';
    if (count.textContent !== text) count.textContent = text;
    row.querySelectorAll('.group-toggle, .levels button, input').forEach((c) => { c.disabled = !have.length || !panelOn; });
    if (isMotorFn(fn)) row.classList.toggle('own-levels', !overrideOn);   // Override off: hide the panel slider
    const toggle = $('.group-toggle', row);
    if (toggle) {
      const on = have.some((t) => functionOn(t, fn));
      if (toggle.getAttribute('aria-pressed') !== String(on)) {
        toggle.textContent = on ? 'On' : 'Off';
        toggle.setAttribute('aria-pressed', String(on));
        row.classList.toggle('off', !on);
      }
    } else {
      const levels = new Set(have.map((t) => t.suck));
      const current = levels.size === 1 ? [...levels][0] : -1;   // mixed levels: nothing highlighted
      row.querySelectorAll('[data-level]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.level === current)));
    }
  }
}
setInterval(refreshGroups, 250);
renderGroups();
setPanelOn(panelOn);   // apply the remembered On/Off
$('#stop-all').addEventListener('click', stopAll);
function refreshApplyAllLabel() {
  $('#apply-all').textContent = $('#all-pattern').value === '__manual' ? 'Set all to Manual' : 'Play on all';
}
$('#all-pattern').addEventListener('change', (e) => { e.target.dataset.value = e.target.value; refreshApplyAllLabel(); });
$('#apply-all').addEventListener('click', () => {
  if (!panelOn) return;
  const id = $('#all-pattern').value;
  if (id === '__manual') {   // every toy back to its sliders, stopped (like switching mode on a card)
    for (const toy of toys.values()) {
      if (toy.motors === 0 || toy.mode === 'manual') continue;
      if (toy.rec) finishRecording(toy);
      toy.mode = 'manual'; toy.phase = 0; toy.running = false; syncToyUI(toy);
    }
    say('All toys are on Manual. Turn things on with the buttons above, or Start on each toy.');
    return;
  }
  for (const toy of toys.values()) {
    if (toy.motors === 0) continue;
    if (toy.rec) finishRecording(toy);
    toy.mode = 'pattern'; toy.patternId = id; toy.phase = 0; toy.running = true; syncToyUI(toy);
  }
  say(`Playing “${findPattern(id).name}” on all toys.`);
});
$('#sync-all').addEventListener('click', () => { if (!panelOn) return; for (const toy of toys.values()) toy.phase = 0; say('Patterns synced.'); });
$('#connect-all').addEventListener('click', async () => {
  const waiting = [...toys.values()].filter((t) => !t.connected);
  const withDevice = waiting.filter((t) => t.device);
  await Promise.all(withDevice.map((t) => { t.manualStop = false; return connectToy(t, { quiet: true }); }));
  const still = waiting.filter((t) => !t.connected);
  if (still.length) say(`Tap Connect on: ${still.map(shownName).join(', ')}. Make sure they're switched on.`, true);
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

// ---------- sync between devices (the user's private GitHub repo) ----------
// toys.json, patterns.json and recordings.json in the repo, each a map id -> item. Every sync is a three-way merge
// against the last synced copy (toydeck.syncBase): a side that changed an item beats the side that didn't; if both
// changed it, this device wins. Deletions are real deletions. Toys are keyed by Bluetooth device id, which differs
// per device: the same toy added on two devices is merged into one by name (the smaller key wins, on both devices).
// Nothing from the other device changes what a running toy is doing: a connected toy keeps its own slider levels,
// a running toy whose setup changed is stopped, and Override / panel On/Off are not synced.
const SYNC_SECTIONS = { toys: 'toys.json', patterns: 'patterns.json', recordings: 'recordings.json' };
const SYNCED_KEYS = new Set(['toydeck.toys', 'toydeck.patterns', 'toydeck.recordings']);
const sync = {
  cfg: store.get('toydeck.syncConfig', null),   // { repo, token } — this device only, never in backups
  base: store.get('toydeck.syncBase', null),    // last merged copy, per section
  cache: {},                                    // per file: { etag, data, sha } (304 = unchanged, free on the rate limit)
  repoOk: false, busy: false, again: false, timer: null, applying: false, rev: 0, last: 0, error: '',
};
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const byId = (list) => Object.fromEntries(list.map((p) => [p.id, p]));
const toList = (map, order) => [...order.filter((p) => p.id in map).map((p) => map[p.id]),
  ...Object.values(map).filter((p) => !order.some((o) => o.id === p.id))];

function merge3(base, local, remote) {
  const out = {};
  for (const id of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const sb = base[id] && stable(base[id]), sl = local[id] && stable(local[id]), sr = remote[id] && stable(remote[id]);
    let v;
    if (sl === sr || sr === sb) v = local[id];   // same, or only this device changed it
    else if (sl === sb) v = remote[id];          // only the other device changed (or deleted) it
    else v = local[id] ?? remote[id];            // both changed: this device wins; deleted here but edited there: keep the edit
    if (v !== undefined) out[id] = v;
  }
  return out;
}
// Same toy added separately on two devices -> one entry. Two toys with one name added on the SAME device are two toys.
function dedupeToys(merged, local, remote) {
  const rename = {}, byName = {};
  for (const key of Object.keys(merged).sort()) {
    const name = merged[key].name;
    const other = name && name !== 'Toy' ? byName[name] : undefined;
    if (other && (key in local) !== (other in local) && (key in remote) !== (other in remote)) {
      rename[key] = other;
      delete merged[key];
    } else if (!other) byName[name] = key;
  }
  return rename;
}

const b64encode = (str) => {
  const bytes = new TextEncoder().encode(str);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
function ghFetch(path, opts = {}) {
  // toydeck.syncApi: test hook only (a local fake GitHub); real use never sets it
  return fetch(`${store.get('toydeck.syncApi', 'https://api.github.com')}/repos/${sync.cfg.repo}${path}`, {
    cache: 'no-store',
    ...opts,
    headers: { Authorization: `Bearer ${sync.cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...opts.headers },
  });
}
function ghError(r, what) {
  const e = new Error(r.status === 401 ? 'GitHub didn\'t accept the token (wrong or expired)'
    : r.status === 403 || r.status === 404 ? `the token can't ${what} ${sync.cfg.repo}`
      : `GitHub answered ${r.status} (${what})`);
  e.conflict = r.status === 409 || r.status === 422;   // someone else wrote first: read again and retry
  return e;
}
async function readRemote(file) {
  const c = sync.cache[file];
  const r = await ghFetch(`/contents/${file}`, { headers: c?.etag ? { 'If-None-Match': c.etag } : {} });
  if (r.status === 304) return c;
  if (r.status === 404) return { data: null, sha: null };   // repo access was checked first: the file just isn't there yet
  if (!r.ok) throw ghError(r, 'read');
  const j = await r.json();
  let text = j.encoding === 'base64' && j.content ? b64decode(j.content) : null;
  if (text == null) {   // over 1 MB: the contents API leaves it out, the blob API doesn't
    const b = await ghFetch(`/git/blobs/${j.sha}`);
    if (!b.ok) throw ghError(b, 'read');
    text = b64decode((await b.json()).content);
  }
  const out = { etag: r.headers.get('ETag'), data: JSON.parse(text), sha: j.sha };
  sync.cache[file] = out;
  return out;
}
async function writeRemote(file, data, sha) {
  const device = navigator.userAgentData?.platform || (/Android|iPhone|iPad/.test(navigator.userAgent) ? 'phone' : 'computer');
  const r = await ghFetch(`/contents/${file}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `ToyDeck sync from ${device}`, content: b64encode(JSON.stringify(data)), ...(sha ? { sha } : {}) }),
  });
  if (!r.ok) throw ghError(r, 'write to');
  sync.cache[file] = { etag: null, data, sha: (await r.json()).content.sha };
}

async function syncOnce() {
  if (!sync.repoOk) {
    const r = await ghFetch('');
    if (!r.ok) throw ghError(r, 'see');
    if (!(await r.json()).permissions?.push) throw new Error(`the token can only read ${sync.cfg.repo} (give it Contents: Read and write)`);
    sync.repoOk = true;
  }
  const rev = sync.rev;
  const base = sync.base ?? { toys: {}, patterns: {}, recordings: {} };
  const local = { toys: { ...toySettings }, patterns: byId(customPatterns), recordings: byId(recordings) };
  const remote = {}, sha = {};
  for (const [name, file] of Object.entries(SYNC_SECTIONS)) {
    const got = await readRemote(file);
    sha[name] = got.sha;
    // A missing file means "nothing new from there", never "everything was deleted".
    remote[name] = got.data ?? base[name];
  }
  const merged = {};
  for (const name of Object.keys(SYNC_SECTIONS)) merged[name] = merge3(base[name], local[name], remote[name]);
  const rename = dedupeToys(merged.toys, local.toys, remote.toys);
  for (const r of Object.values(merged.recordings)) {
    if (rename[r.toyKey]) merged.recordings[r.id] = { ...r, toyKey: rename[r.toyKey] };
  }
  for (const [name, file] of Object.entries(SYNC_SECTIONS)) {
    if (!sha[name] || stable(merged[name]) !== stable(remote[name])) await writeRemote(file, merged[name], sha[name]);
  }
  if (sync.rev !== rev) { const e = new Error('changed while syncing'); e.conflict = true; throw e; }   // merge again with the new change
  if (Object.keys(SYNC_SECTIONS).some((n) => stable(merged[n]) !== stable(local[n])) || Object.keys(rename).length) applyMerged(merged, rename);
  sync.base = merged;
  store.set('toydeck.syncBase', merged);
}

async function syncNow() {
  if (!sync.cfg) return;
  if (sync.busy) { sync.again = true; return; }
  clearTimeout(sync.timer);
  sync.timer = null;
  sync.busy = true;
  renderSyncStatus();
  try {
    for (let attempt = 0; ; attempt++) {
      try { await syncOnce(); break; } catch (e) { if (!e.conflict || attempt >= 3) throw e; }
    }
    sync.error = '';
    sync.last = Date.now();
  } catch (e) {
    sync.error = e.name === 'TypeError' ? 'no connection to GitHub' : e.message;
    if (/token/.test(sync.error)) sync.repoOk = false;
  } finally {
    sync.busy = false;
    renderSyncStatus();
    if (sync.again) { sync.again = false; syncNow(); }
  }
}
onStoreSet = (key) => {
  if (!SYNCED_KEYS.has(key) || sync.applying) return;
  sync.rev++;
  if (!sync.cfg) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(syncNow, 4000);   // a burst of slider moves becomes one upload
};

// Put a merged copy into this device: settings, cards, patterns, recordings.
function applyMerged(m, rename) {
  sync.applying = true;
  try {
    for (const [from, to] of Object.entries(rename)) {
      const toy = toys.get(from);
      if (toy && !toys.has(to)) { toys.delete(from); toy.key = to; toys.set(to, toy); }
    }
    for (const k of Object.keys(toySettings)) if (!(k in m.toys)) delete toySettings[k];
    Object.assign(toySettings, m.toys);
    for (const [key, saved] of Object.entries(m.toys)) {
      const toy = toys.get(key);
      if (toy) { applySavedSettings(toy, saved); continue; }
      const t = makeToy(key, saved);
      t.collapsed = true;
      toys.set(key, t);
      buildToyCard(t);
    }
    for (const toy of [...toys.values()]) {
      if (toy.key in m.toys || toy.connected) continue;   // forgotten on the other device; a connected toy stays
      toys.delete(toy.key);
      toy.ui?.el.remove();
    }
    customPatterns = toList(m.patterns, customPatterns);
    recordings = toList(m.recordings, recordings);
    store.set('toydeck.toys', toySettings);
    store.set('toydeck.patterns', customPatterns);
    store.set('toydeck.recordings', recordings);
    for (const toy of toys.values()) if (findPattern(toy.patternId).id !== toy.patternId) toy.patternId = BUILTIN[0].id;   // deleted there
    refreshPatternSelects();
    renderGroups();
    $('#empty').hidden = toys.size > 0;
    updateCount();
  } finally {
    sync.applying = false;
  }
}

function applySavedSettings(toy, s) {
  const setupBefore = stable([toy.motors, toy.slots, toy.motorTypes, toy.minPowers]);
  if (!toy.device && s.name) toy.name = s.name;
  toy.motors = s.motors ?? toy.motors;
  toy.slots = fitSlots(s.slots, toy.motors);
  toy.motorTypes = Array.from({ length: 4 }, (_, i) => (s.motorTypes?.[i] in MOTOR_TYPES ? s.motorTypes[i] : 'vibe'));
  toy.minPowers = readMinPowers(s);
  toy.limits = readLimits(s);
  toy.limitLocks = readLimitLocks(s);
  toy.linked = s.linked ?? true;
  if (!toy.connected) toy.levels = Array.from({ length: 4 }, (_, i) => s.levels?.[i] ?? 0);
  toy.hasHeat = s.hasHeat ?? false;
  toy.hasSuck = s.hasSuck ?? false;
  toy.suckLevels = s.suckLevels ?? 5;
  for (const k of Object.keys(EXTRAS)) toy.hasExtra[k] = (s.extras ?? []).includes(k);
  // Features removed on the other device go off here too; a running toy whose motor setup changed stops.
  if (!toy.hasHeat && toy.heat) setHeat(toy, false);
  if ((!toy.hasSuck && toy.suck) || toy.suck > toy.suckLevels) setSuction(toy, toy.hasSuck ? toy.suckLevels : 0);
  for (const k of extrasOn(toy)) if (!toy.hasExtra[k]) setExtra(toy, k, false);
  if (toy.running && stable([toy.motors, toy.slots, toy.motorTypes, toy.minPowers]) !== setupBefore) {
    stopToy(toy);
    say(`${shownName(toy)}'s setup changed on your other device, so it stopped. Press Start.`, true);
  }
  const { ui } = toy;
  if (!ui) return;
  ui.link.checked = toy.linked;
  ui.motors.value = String(toy.motors);
  ui.hasHeat.checked = toy.hasHeat;
  ui.hasSuck.checked = toy.hasSuck;
  ui.suckLevels.value = String(toy.suckLevels);
  ui.el.querySelectorAll('[data-has-extra]').forEach((cb) => { cb.checked = toy.hasExtra[cb.dataset.hasExtra]; });
  renderToyName(toy);
  syncToyUI(toy);
  renderFeatures(toy);
}

// Sync dialog + status line
const sd = { dlg: $('#sync-dialog'), repo: $('#sd-repo'), token: $('#sd-token'), msg: $('#sd-msg'), off: $('#sd-off'), now: $('#sd-now') };
function syncStatusText() {
  if (!sync.cfg) return 'Sync is off on this device.';
  if (sync.busy) return 'Syncing…';
  if (sync.error) return `Sync problem: ${sync.error}.`;
  if (sync.last) return `Synced ${new Date(sync.last).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  return 'Sync is on.';
}
function renderSyncStatus() {
  const text = syncStatusText();
  const btn = $('#sync-devices');
  btn.title = text;
  btn.classList.toggle('sync-bad', !!sync.cfg && !!sync.error);
  btn.classList.toggle('sync-on', !!sync.cfg && !sync.error);
  sd.msg.textContent = text;
  sd.off.hidden = sd.now.hidden = !sync.cfg;
}
$('#sync-devices').addEventListener('click', () => {
  const owner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : '';
  sd.repo.value = sync.cfg?.repo ?? (owner ? `${owner}/toydeck-sync` : '');
  sd.token.value = '';
  sd.token.placeholder = sync.cfg ? 'Saved on this device (leave empty to keep it)' : 'github_pat_…';
  renderSyncStatus();
  sd.dlg.showModal();
});
$('#sd-save').addEventListener('click', async () => {
  const repo = sd.repo.value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '');
  const token = sd.token.value.trim() || sync.cfg?.token;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { sd.msg.textContent = 'Repo should look like yourname/toydeck-sync.'; return; }
  if (!token) { sd.msg.textContent = 'Paste the access token first.'; return; }
  if (sync.cfg && sync.cfg.repo !== repo) { sync.base = null; store.set('toydeck.syncBase', null); }
  sync.cfg = { repo, token };
  sync.repoOk = false;
  sync.cache = {};
  store.set('toydeck.syncConfig', sync.cfg);
  sd.token.value = '';
  await syncNow();
  if (!sync.error) say('Sync is on. Your other devices follow within about 30 seconds.');
});
sd.now.addEventListener('click', () => syncNow());
sd.off.addEventListener('click', () => confirmTap(sd.off, 'Tap again to turn off', () => {
  sync.cfg = null;
  sync.base = null;
  sync.cache = {};
  try { localStorage.removeItem('toydeck.syncConfig'); localStorage.removeItem('toydeck.syncBase'); } catch { /* storage blocked */ }
  renderSyncStatus();
  say('Sync is off on this device. Your settings here are unchanged.');
}));
function startSync() {   // every call is a no-op while sync is off on this device
  renderSyncStatus();
  syncNow();
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 30000);
  document.addEventListener('visibilitychange', () => syncNow());   // back to the app: pick up changes; leaving: send pending ones
}

// ---------- startup ----------
// Show every toy connected before, so it's one tap (or zero) to get it back.
for (const [key, saved] of Object.entries(toySettings)) {
  const toy = makeToy(key, saved);
  toy.collapsed = true;   // toys already in the system open minimized: tap the card to open it
  toys.set(key, toy);
  buildToyCard(toy);
}
updateCount();
startSync();

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

// Restart: stop every toy, fetch the newest version of the app, reload. Saved toys reconnect by themselves.
const restartBtn = $('#restart-app');
restartBtn.addEventListener('click', async () => {
  if (restartBtn.disabled) return;
  restartBtn.disabled = true;
  restartBtn.textContent = 'Restarting…';
  stopAll();
  await new Promise((r) => setTimeout(r, 400));   // let the stop commands reach the toys
  if (sync.cfg) {   // send this device's changes first; the reloaded app then fetches the other device's
    restartBtn.textContent = 'Syncing…';
    const syncFirst = async () => {
      while (sync.busy) await new Promise((r) => setTimeout(r, 200));   // let a sync already running finish
      await syncNow();
    };
    await Promise.race([syncFirst(), new Promise((r) => setTimeout(r, 10000))]);   // never stuck on a slow network
    restartBtn.textContent = 'Restarting…';
  }
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();                           // picks up a new version of the offline cache
  } catch { /* offline: reload the cached copy */ }
  location.reload();
});
