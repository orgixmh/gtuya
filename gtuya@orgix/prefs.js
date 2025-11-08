// prefs.js
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SCHEMA_KEY = 'devices-json';

function loadDevices(settings) {
  try {
    const txt = settings.get_string(SCHEMA_KEY) || '[]';
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveDevices(settings, arr) {
  settings.set_string(SCHEMA_KEY, JSON.stringify(arr || []));
}
function uniqByKey(arr) {
  const m = new Map();
  for (const d of arr) if (d && d.key) m.set(String(d.key), d);
  return [...m.values()];
}

function mkEntry({ placeholder = '', text = '', widthChars = 0, hexpand = true }) {
  const e = new Gtk.Entry({ hexpand, placeholder_text: placeholder });
  if (widthChars > 0) e.set_width_chars(widthChars);
  e.set_text(String(text ?? ''));
  return e;
}
function mkSpin({ min = 1, max = 65535, value = 6668 }) {
  const adj = new Gtk.Adjustment({ lower: min, upper: max, step_increment: 1, page_increment: 10, value });
  return new Gtk.SpinButton({ adjustment: adj, digits: 0, climb_rate: 1, hexpand: true });
}
function labelRight(text) {
  const l = new Gtk.Label({ label: text, xalign: 1 });
  l.add_css_class('dim-label');
  return l;
}
function validateDevice(dev) {
  const errs = [];
  if (!dev.name) errs.push('Name is required');
  if (!dev.ip) errs.push('IP is required');
  if (!(dev.port >= 1 && dev.port <= 65535)) errs.push('Port 1..65535');
  if (!dev.devId) errs.push('devId is required');
  if (!dev.localKey || String(dev.localKey).length !== 16) errs.push('localKey: 16 chars');
  if (!dev.ver) errs.push('Version (e.g. 3.3)');
  return errs;
}


function asciiBytes(str){const a=new Uint8Array(str.length);for(let i=0;i<str.length;i++)a[i]=str.charCodeAt(i)&0xff;return a;}
function utf8Bytes(str){return new TextEncoder().encode(str);}
function pkcs7Pad(b,blk=16){const r=b.length%blk,p=r===0?blk:(blk-r);const out=new Uint8Array(b.length+p);out.set(b,0);out.fill(p,b.length);return out;}
function asciiToHex(str){const u=asciiBytes(str);let s='';for(let i=0;i<u.length;i++)s+=u[i].toString(16).padStart(2,'0');return s;}
function writeU32BE(buf,off,val){buf[off]=(val>>>24)&0xff;buf[off+1]=(val>>>16)&0xff;buf[off+2]=(val>>>8)&0xff;buf[off+3]=(val)&0xff;}
const CRC32_TABLE=(()=>{const t=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[i]=c>>>0;}return t;})();
function crc32(buf,off=0,len=buf.length){let c=0xFFFFFFFF;for(let i=0;i<len;i++)c=CRC32_TABLE[(c^buf[off+i])&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}

async function aes128EcbEncryptPKCS7(bytes,keyAscii16){
  const padded=pkcs7Pad(bytes,16);
  const keyHex=asciiToHex(keyAscii16);
  const proc=new Gio.Subprocess({
    argv:['/usr/bin/openssl','enc','-aes-128-ecb','-nopad','-nosalt','-K',keyHex],
    flags:Gio.SubprocessFlags.STDIN_PIPE|Gio.SubprocessFlags.STDOUT_PIPE|Gio.SubprocessFlags.STDERR_PIPE
  });
  proc.init(null);
  const inBytes=new GLib.Bytes(padded);
  const [ok,out,err]=await new Promise(res=>{
    proc.communicate_async(inBytes,null,(p,r)=>{try{const [b,o,e]=p.communicate_finish(r);res([b,o?o.toArray():new Uint8Array(),e?e.toArray():new Uint8Array()]);}catch{res([false,new Uint8Array(),new Uint8Array()]);}});
  });
  if(proc.get_exit_status()!==0){
    const errStr=new TextDecoder().decode(err);
    throw new Error(`openssl enc failed: ${errStr.trim()}`);
  }
  return new Uint8Array(out);
}
async function buildControlPacketForDps(dev,dpsObj,seqRef){
  const payloadObj={devId:dev.devId,uid:'',t:Math.floor(Date.now()/1000),dps:dpsObj};
  const jsonBytes=utf8Bytes(JSON.stringify(payloadObj));
  const verHeader=new Uint8Array(15);
  verHeader.set(asciiBytes(dev.ver||'3.3'),0);
  const cipher=await aes128EcbEncryptPKCS7(jsonBytes,dev.localKey);
  const payload=new Uint8Array(verHeader.length+cipher.length);
  payload.set(verHeader,0); payload.set(cipher,verHeader.length);
  const pkt=new Uint8Array(16+payload.length+8);
  writeU32BE(pkt,0,0x000055AA);
  writeU32BE(pkt,4,(seqRef.value++)>>>0);
  writeU32BE(pkt,8,0x07);
  writeU32BE(pkt,12,payload.length+8);
  pkt.set(payload,16);
  const crc=crc32(pkt,0,16+payload.length);
  writeU32BE(pkt,16+payload.length,crc);
  writeU32BE(pkt,20+payload.length,0x0000AA55);
  return pkt;
}
async function sendOnce(dev,bytes){
  const client=new Gio.SocketClient(); client.timeout=3;
  const conn=await new Promise((resolve,reject)=>{
    client.connect_to_host_async(`${dev.ip}:${dev.port}`,null,null,(c,res)=>{try{resolve(c.connect_to_host_finish(res));}catch(e){reject(e);}});
  });
  try{
    const out=conn.get_output_stream();
    await new Promise((resolve,reject)=>{
      out.write_bytes_async(new GLib.Bytes(bytes),GLib.PRIORITY_DEFAULT,null,(o,r)=>{try{o.write_bytes_finish(r);resolve();}catch(e){reject(e);}});
    });
    const din=new Gio.DataInputStream({base_stream:conn.get_input_stream()});
    await new Promise(resolve=>{
      din.read_bytes_async(512,GLib.PRIORITY_DEFAULT,null,(_i,r2)=>{try{_i.read_bytes_finish(r2);}catch{} resolve();});
    });
  } finally {
    await new Promise(resolve=>conn.close_async(GLib.PRIORITY_DEFAULT,null,()=>resolve()));
  }
}
async function testPower(dev){
  const seqRef={ value: 1 };
  // ON
  const pktOn = await buildControlPacketForDps(dev,{ '20': true }, seqRef);
  await sendOnce(dev,pktOn);
  // wait ~500ms
  await new Promise(r=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,500,()=>{r();return GLib.SOURCE_REMOVE;}));
  // OFF
  const pktOff = await buildControlPacketForDps(dev,{ '20': false }, seqRef);
  await sendOnce(dev,pktOff);
}

/* ---------- Prefs UI ---------- */
export default class TuyaTogglePrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    window.set_title('gTuya - Settings');

    const page = new Adw.PreferencesPage();
    window.add(page);

    // Manage (Add device) 
    const manageGroup = new Adw.PreferencesGroup({ title: 'Manage' });
    const addRow = new Adw.ActionRow({ title: 'Add device' });
    addRow.activatable = true;
    manageGroup.add(addRow);
    page.add(manageGroup);

    // Devices group placeholder 
    let devicesGroup = new Adw.PreferencesGroup({ title: 'Devices' });
    page.add(devicesGroup);

    function replaceDevicesGroup() {
      if (devicesGroup.get_parent()) page.remove(devicesGroup);
      devicesGroup = new Adw.PreferencesGroup({ title: 'Devices' });
      page.add(devicesGroup);
    }

    const buildRow = (dev) => {
      const exp = new Adw.ExpanderRow({
        title: dev.name || dev.devId || '(unnamed)',
        subtitle: dev.ip ? `${dev.ip}:${dev.port ?? 6668}` : 'no IP',
        expanded: false,
        activatable: false,
      });

      const grid = new Gtk.Grid({ column_spacing: 8, row_spacing: 6, margin_top: 6, margin_bottom: 6 });

      const nameE = mkEntry({ placeholder: 'Friendly name', text: dev.name ?? '' });
      const ipE   = mkEntry({ placeholder: 'IP address', text: dev.ip ?? '' });
      const portE = mkSpin({ value: Number(dev.port ?? 6668) });
      const idE   = mkEntry({ placeholder: 'devId', text: dev.devId ?? '' });
      const lkE = new Gtk.PasswordEntry({
        hexpand: true,
        show_peek_icon: true,    
      });
      lkE.set_text(dev.localKey ?? '');
      if (lkE.set_width_chars)   
        lkE.set_width_chars(20);

      const verE  = mkEntry({ placeholder: 'ver (e.g. 3.3)', text: dev.ver ?? '3.3', widthChars: 6 });

      let r = 0;
      grid.attach(labelRight('Name'),     0, r, 1, 1); grid.attach(nameE, 1, r++, 1, 1);
      grid.attach(labelRight('IP'),       0, r, 1, 1); grid.attach(ipE,   1, r++, 1, 1);
      grid.attach(labelRight('Port'),     0, r, 1, 1); grid.attach(portE, 1, r++, 1, 1);
      grid.attach(labelRight('devId'),    0, r, 1, 1); grid.attach(idE,   1, r++, 1, 1);
      grid.attach(labelRight('localKey'), 0, r, 1, 1); grid.attach(lkE,   1, r++, 1, 1);
      grid.attach(labelRight('Version'),  0, r, 1, 1); grid.attach(verE,  1, r++, 1, 1);

      const actions = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, halign: Gtk.Align.END });
      const resetBtn = new Gtk.Button({ label: 'Reset' });
      const saveBtn  = new Gtk.Button({ label: 'Save' });
      const delBtn   = new Gtk.Button({ label: 'Remove' });
      const testBtn  = new Gtk.Button({ label: 'Test' });
      delBtn.add_css_class('destructive-action');
      actions.append(testBtn);
      actions.append(resetBtn);
      actions.append(saveBtn);
      actions.append(delBtn);

      const wrap = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 6, margin_bottom: 6 });
      wrap.append(grid);
      wrap.append(actions);

      const innerRow = new Adw.ActionRow({ activatable: false });
      innerRow.add_suffix(wrap);
      exp.add_row(innerRow);

      const capture = () => ({
        
        key: dev.key,
        name: nameE.get_text().trim(),
        ip: ipE.get_text().trim(),
        port: Number(portE.get_value()) || 6668,
        devId: idE.get_text().trim(),
        localKey: lkE.get_text().slice(0, 16),
        ver: verE.get_text().trim() || '3.3',
      });

      resetBtn.connect('clicked', () => {
        nameE.set_text(dev.name ?? '');
        ipE.set_text(dev.ip ?? '');
        portE.set_value(Number(dev.port ?? 6668));
        idE.set_text(dev.devId ?? '');
        lkE.set_text(dev.localKey ?? '');
        verE.set_text(dev.ver ?? '3.3');
      });

      saveBtn.connect('clicked', () => {
        const updated = capture();
        const errs = validateDevice(updated);
        if (errs.length) return; 
        let arr = uniqByKey(loadDevices(settings));
        const pos = arr.findIndex(d => d.key === dev.key);
        if (pos >= 0) arr[pos] = updated; else arr.push(updated);
        saveDevices(settings, uniqByKey(arr));
        
        exp.set_title(updated.name || updated.devId || '(unnamed)');
        exp.set_subtitle(updated.ip ? `${updated.ip}:${updated.port}` : 'no IP');
      });

      delBtn.connect('clicked', () => {
        let arr = uniqByKey(loadDevices(settings));
        arr = arr.filter(d => d.key !== dev.key);
        saveDevices(settings, arr);
        refresh();
      });

      testBtn.connect('clicked', async () => {
        try { await testPower(dev); } catch (e) { /* silently ignore in UI */ }
      });

      return exp;
    };

    const refresh = () => {
      replaceDevicesGroup();
      const devices = uniqByKey(loadDevices(settings));
      for (const dev of devices) devicesGroup.add(buildRow(dev));
    };

    // Add device with UUID key
    let addingBusy = false;
    addRow.connect('activated', () => {
      if (addingBusy) return;
      addingBusy = true;
      try {
        let arr = uniqByKey(loadDevices(settings));
        const key = GLib.uuid_string_random();
        arr.push({
          key,
          name: 'New Device',
          ip: '',
          port: 6668,
          devId: '',
          localKey: '',
          ver: '3.3',
        });
        saveDevices(settings, arr);
        refresh();
      } finally {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { addingBusy = false; return GLib.SOURCE_REMOVE; });
      }
    });

    refresh();
  }
}
