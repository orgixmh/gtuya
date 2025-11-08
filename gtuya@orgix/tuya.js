const { Gio, GLib } = imports.gi;

// ===== Settings-backed devices =====
const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.gtuya';
const SETTINGS_KEY = 'devices-json';

// fallback if settings are empty
const FALLBACK_DEVICES = [];

const CMD_CONTROL = 0x07;
const CMD_QUERY   = 0x0A;

let seq = 1;
let _settings = null;
let _devicesChangedHandlers = [];
let DEVICES = [];

/* ---------- settings loader  ---------- */
function getSettingsCompat() {
  
  const thisFile = Gio.File.new_for_uri(import.meta.url);
  const extDir   = thisFile.get_parent();
  const schemaDir= extDir.get_child('schemas');

  const src = Gio.SettingsSchemaSource.new_from_directory(
    schemaDir.get_path(),
    Gio.SettingsSchemaSource.get_default(),
    false
  );
  const schema = src.lookup('org.gnome.shell.extensions.gtuya', true);
  if (!schema)
    throw new Error('GSettings schema org.gnome.shell.extensions.gTuya not found.');

  return new Gio.Settings({ settings_schema: schema });
}

/* ---------- devices settings glue ---------- */
function _parseDevices(jsonStr) {
  try {
    const arr = JSON.parse(jsonStr);
    if (!Array.isArray(arr)) return [];
    return arr.map(d => ({
      key: d.key || d.devId,
      name: d.name || 'Tuya Led',
      ip: String(d.ip || ''),
      port: Number(d.port || 6668),
      devId: String(d.devId || ''),
      localKey: String(d.localKey || '').slice(0, 16),
      ver: String(d.ver || '3.3'),
    })).filter(d => d.ip && d.devId && d.localKey);
  } catch {
    return [];
  }
}

function _emitDevicesChanged() {
  for (const cb of _devicesChangedHandlers) {
    try { cb(getDevices()); } catch {}
  }
}


export function initSettings() {
  if (_settings) return;
  _settings = getSettingsCompat();

  DEVICES = _parseDevices(_settings.get_string(SETTINGS_KEY));
  if (DEVICES.length === 0) {
    DEVICES = [...FALLBACK_DEVICES];
  }

  _settings.connect(`changed::${SETTINGS_KEY}`, () => {
    DEVICES = _parseDevices(_settings.get_string(SETTINGS_KEY));
    _emitDevicesChanged();
  });
}

export function getDevices() { return DEVICES.map(d => ({ ...d })); }
export function addDevicesChangedListener(cb) { _devicesChangedHandlers.push(cb); }
export function setDevices(arr) {
  if (!_settings) return;
  _settings.set_string(SETTINGS_KEY, JSON.stringify(arr || []));
}

/* ---------- helpers ---------- */
function writeU32BE(buf, off, val) {
  buf[off]   = (val >>> 24) & 0xff;
  buf[off+1] = (val >>> 16) & 0xff;
  buf[off+2] = (val >>>  8) & 0xff;
  buf[off+3] = (val       ) & 0xff;
}
function asciiBytes(str) {
  const a = new Uint8Array(str.length);
  for (let i=0;i<str.length;i++) a[i] = str.charCodeAt(i) & 0xff;
  return a;
}
function utf8Bytes(str) { return new TextEncoder().encode(str); }
function pkcs7Pad(bytes, block=16) {
  const rem = bytes.length % block;
  const pad = rem === 0 ? block : (block - rem);
  const out = new Uint8Array(bytes.length + pad);
  out.set(bytes, 0);
  out.fill(pad, bytes.length);
  return out;
}
function pkcs7Unpad(bytes) {
  if (bytes.length === 0) return bytes;
  const pad = bytes[bytes.length - 1];
  if (pad === 0 || pad > 16 || pad > bytes.length) return bytes;
  return bytes.slice(0, bytes.length - pad);
}
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf, off=0, len=buf.length) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < len; i++) c = CRC32_TABLE[(c ^ buf[off+i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function asciiToHex(str) {
  const u = asciiBytes(str);
  let s = '';
  for (let i=0;i<u.length;i++) s += u[i].toString(16).padStart(2,'0');
  return s;
}

/* AES-128-ECB via system openssl (PKCS#7) */
async function aes128EcbEncryptPKCS7(plainBytes, keyAscii16) {
  const padded = pkcs7Pad(plainBytes, 16);
  const keyHex = asciiToHex(keyAscii16);

  const proc = new Gio.Subprocess({
    argv: ['/usr/bin/openssl', 'enc', '-aes-128-ecb', '-nopad', '-nosalt', '-K', keyHex],
    flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
  });
  proc.init(null);

  const inBytes = new GLib.Bytes(padded);
  const [ok, out, err] = await new Promise((resolve) => {
    proc.communicate_async(inBytes, null, (p, res) => {
      try {
        const [bOK, outGLib, errGLib] = p.communicate_finish(res);
        resolve([bOK, outGLib ? outGLib.toArray() : new Uint8Array(),
                      errGLib ? errGLib.toArray() : new Uint8Array()]);
      } catch (e) {
        resolve([false, new Uint8Array(), new Uint8Array()]);
      }
    });
  });

  const status = proc.get_exit_status();
  if (status !== 0) {
    const errStr = new TextDecoder().decode(err);
    throw new Error(`openssl enc failed (${status}): ${errStr.trim()}`);
  }
  return new Uint8Array(out);
}

async function aes128EcbDecryptPKCS7(encBytes, keyAscii16) {
  const keyHex = asciiToHex(keyAscii16);
  const proc = new Gio.Subprocess({
    argv: ['/usr/bin/openssl', 'enc', '-d', '-aes-128-ecb', '-nopad', '-nosalt', '-K', keyHex],
    flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
  });
  proc.init(null);

  const inBytes = new GLib.Bytes(encBytes);
  const [ok, out, err] = await new Promise((resolve) => {
    proc.communicate_async(inBytes, null, (p, res) => {
      try {
        const [bOK, outGLib, errGLib] = p.communicate_finish(res);
        resolve([bOK, outGLib ? outGLib.toArray() : new Uint8Array(),
                      errGLib ? errGLib.toArray() : new Uint8Array()]);
      } catch (e) {
        resolve([false, new Uint8Array(), new Uint8Array()]);
      }
    });
  });

  const status = proc.get_exit_status();
  if (status !== 0) {
    const errStr = new TextDecoder().decode(err);
    throw new Error(`openssl dec failed (${status}): ${errStr.trim()}`);
  }
  return pkcs7Unpad(new Uint8Array(out));
}

/* ----- CONTROL builder (generic DPS) ----- */
async function buildControlPacketForDps(dev, dpsObj) {
  const payloadObj = {
    devId: dev.devId,
    uid: '',
    t: Math.floor(Date.now() / 1000),
    dps: dpsObj,
  };
  const jsonBytes = utf8Bytes(JSON.stringify(payloadObj));

  // CONTROL 3.3: 15-byte "3.3" header + AES(cipher)
  const verHeader = new Uint8Array(15);
  verHeader.set(asciiBytes(dev.ver), 0);

  const cipher = await aes128EcbEncryptPKCS7(jsonBytes, dev.localKey);
  const payload = new Uint8Array(verHeader.length + cipher.length);
  payload.set(verHeader, 0);
  payload.set(cipher, verHeader.length);

  const lenField = payload.length + 8;
  const pkt = new Uint8Array(16 + payload.length + 8);
  writeU32BE(pkt, 0, 0x000055AA);
  writeU32BE(pkt, 4, (seq++) >>> 0);
  writeU32BE(pkt, 8, CMD_CONTROL);
  writeU32BE(pkt, 12, lenField);
  pkt.set(payload, 16);

  const crc = crc32(pkt, 0, 16 + payload.length);
  writeU32BE(pkt, 16 + payload.length, crc);
  writeU32BE(pkt, 20 + payload.length, 0x0000AA55);

  return pkt;
}

/* ----- QUERY builder (DP_QUERY 0x0A) — payload is AES only (no "3.3" header) ----- */
async function buildQueryPacket(dev) {
  const payloadObj = {
    devId: dev.devId,
    uid: '',
    t: Math.floor(Date.now() / 1000),
  };
  const jsonBytes = utf8Bytes(JSON.stringify(payloadObj));
  const cipher = await aes128EcbEncryptPKCS7(jsonBytes, dev.localKey);

  const lenField = cipher.length + 8;
  const pkt = new Uint8Array(16 + cipher.length + 8);
  writeU32BE(pkt, 0, 0x000055AA);
  writeU32BE(pkt, 4, (seq++) >>> 0);
  writeU32BE(pkt, 8, CMD_QUERY);
  writeU32BE(pkt, 12, lenField);
  pkt.set(cipher, 16);

  const crc = crc32(pkt, 0, 16 + cipher.length);
  writeU32BE(pkt, 16 + cipher.length, crc);
  writeU32BE(pkt, 20 + cipher.length, 0x0000AA55);
  return pkt;
}

async function sendOnce(dev, bytes) {
  const client = new Gio.SocketClient();
  client.timeout = 3;
  const conn = await new Promise((resolve, reject) => {
    client.connect_to_host_async(`${dev.ip}:${dev.port}`, null, null, (c, res) => {
      try { resolve(c.connect_to_host_finish(res)); }
      catch (e) { reject(e); }
    });
  });

  try {
    const out = conn.get_output_stream();
    await new Promise((resolve, reject) => {
      out.write_bytes_async(new GLib.Bytes(bytes), GLib.PRIORITY_DEFAULT, null, (o, r) => {
        try { o.write_bytes_finish(r); resolve(); }
        catch (e) { reject(e); }
      });
    });

    // read small response (ignore content)
    const din = new Gio.DataInputStream({ base_stream: conn.get_input_stream() });
    await new Promise((resolve) => {
      din.read_bytes_async(1024, GLib.PRIORITY_DEFAULT, null, (_i, r2) => {
        try { _i.read_bytes_finish(r2); } catch (e) {}
        resolve();
      });
    });
  } finally {
    await new Promise((resolve) => conn.close_async(GLib.PRIORITY_DEFAULT, null, () => resolve()));
  }
}

/* Receive until suffix 00 00 AA 55 or timeout, return full frame bytes */
async function sendAndRecvFrame(dev, bytes) {
  const client = new Gio.SocketClient();
  client.timeout = 3;
  const conn = await new Promise((resolve, reject) => {
    client.connect_to_host_async(`${dev.ip}:${dev.port}`, null, null, (c, res) => {
      try { resolve(c.connect_to_host_finish(res)); }
      catch (e) { reject(e); }
    });
  });

  let frame = new Uint8Array(0);
  try {
    const out = conn.get_output_stream();
    await new Promise((resolve, reject) => {
      out.write_bytes_async(new GLib.Bytes(bytes), GLib.PRIORITY_DEFAULT, null, (o, r) => {
        try { o.write_bytes_finish(r); resolve(); }
        catch (e) { reject(e); }
      });
    });

    const din = new Gio.DataInputStream({ base_stream: conn.get_input_stream() });

    const deadline = Date.now() + 4000; // 4s
    while (Date.now() < deadline) {
      const chunk = await new Promise((resolve) => {
        din.read_bytes_async(1024, GLib.PRIORITY_DEFAULT, null, (_i, r2) => {
          try {
            const bytes = _i.read_bytes_finish(r2);
            resolve(bytes ? bytes.toArray() : new Uint8Array());
          } catch (e) {
            resolve(new Uint8Array());
          }
        });
      });
      if (!chunk || chunk.length === 0) break;
      // append
      const tmp = new Uint8Array(frame.length + chunk.length);
      tmp.set(frame, 0);
      tmp.set(chunk, frame.length);
      frame = tmp;

      const n = frame.length;
      if (n >= 4 && frame[n-4]===0x00 && frame[n-3]===0x00 && frame[n-2]===0xAA && frame[n-1]===0x55)
        break;
    }
  } finally {
    await new Promise((resolve) => conn.close_async(GLib.PRIORITY_DEFAULT, null, () => resolve()));
  }
  return frame;
}

/* Parse Tuya frame; return decrypted JSON object if possible */
async function decodeQueryFrameToJson(dev, frame) {
  if (!frame || frame.length < 24) throw new Error('No Tuya frame');
  // header(16) + body + crc(4) + aa55(4)
  let enc = frame.slice(16, frame.length - 8);
  // optional return code (4x00)
  if (enc.length >= 4 && enc[0]===0 && enc[1]===0 && enc[2]===0 && enc[3]===0)
    enc = enc.slice(4);
  // optional plain "3.3" header (15 bytes)
  if (enc.length >= 15 && enc[0]===0x33 && enc[1]===0x2E && enc[2]===0x33)
    enc = enc.slice(15);

  // decrypt (PKCS#7 unpad inside)
  const plain = await aes128EcbDecryptPKCS7(enc, dev.localKey);
  const str = new TextDecoder().decode(plain);
  try {
    return JSON.parse(str);
  } catch (_) {
    throw new Error('Failed to parse JSON');
  }
}

/* ---------- public API (multi-device) ---------- */
function findDev(keyOrDevId) {
  return DEVICES.find(d => d.key === keyOrDevId || d.devId === keyOrDevId);
}

export async function sendPower(keyOrDevId, on) {
  const dev = findDev(keyOrDevId);
  if (!dev) throw new Error(`Device not found: ${keyOrDevId}`);
  const pkt = await buildControlPacketForDps(dev, { '20': !!on });
  await sendOnce(dev, pkt);
}

export async function sendBrightness(keyOrDevId, val /* 0..1000 */) {
  const dev = findDev(keyOrDevId);
  if (!dev) throw new Error(`Device not found: ${keyOrDevId}`);
  const v = Math.max(0, Math.min(1000, Math.round(val)));
  const pkt = await buildControlPacketForDps(dev, { '22': v });
  await sendOnce(dev, pkt);
}

/* Query current state: returns { on:boolean, brightness:number|undefined, dps:object } */
export async function queryStatus(keyOrDevId) {
  const dev = findDev(keyOrDevId);
  if (!dev) throw new Error(`Device not found: ${keyOrDevId}`);
  const pkt = await buildQueryPacket(dev);
  const frame = await sendAndRecvFrame(dev, pkt);
  const obj = await decodeQueryFrameToJson(dev, frame);

  const dps = obj && obj.dps ? obj.dps : {};
  const on  = !!dps['20'];
  const br  = (typeof dps['22'] === 'number') ? dps['22'] : undefined;
  return { on, brightness: br, dps };
}
