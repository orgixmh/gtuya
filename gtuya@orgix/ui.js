import * as ExtensionUtils from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib'; 
import Gio from 'gi://Gio'; 
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {
  initSettings, getDevices, addDevicesChangedListener,
  sendPower, sendBrightness, queryStatus
} from './tuya.js';

const EXT_UUID = 'gtuya@orgix';

const TuyaToggleButton = GObject.registerClass(
class TuyaToggleButton extends PanelMenu.Button {
  _init() {
    super._init(0.0, 'gtuya');
    initSettings();

    this._icon = new St.Icon({
      icon_name: 'display-brightness-symbolic',
      style_class: 'system-status-icon tuya-bri-icon'
    });
    this.add_child(this._icon);

    this._state = new Map();

    const devs = getDevices();
    devs.forEach(dev => this._addDeviceBlock(dev));
    addDevicesChangedListener(() => this._rebuildMenu());

    //this._appendPrefsItem();
  }

  
  vfunc_event(event) {
    const t = event.type();
    if (t === Clutter.EventType.BUTTON_PRESS || t === Clutter.EventType.BUTTON_RELEASE) {
      const btn = event.get_button ? event.get_button() : 0;
      if (btn === 3) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { openPrefs(); return GLib.SOURCE_REMOVE; });
        return Clutter.EVENT_STOP;
      }
      if (btn === 2) return Clutter.EVENT_STOP;
    }
    return super.vfunc_event(event);
  }

  _rebuildMenu() {
    this.menu.removeAll();
    this._state.clear();

    const devs = getDevices();
    devs.forEach(dev => this._addDeviceBlock(dev));

    
    //this._appendPrefsItem();
  }

  _appendPrefsItem() {
    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    const prefsItem = new PopupMenu.PopupMenuItem('Settings…');
    prefsItem.connect('activate', () => openPrefs());
    this.menu.addMenuItem(prefsItem);
  }

  _cancelDebounce(key) {
    const st = this._state.get(key);
    if (st?.debounceId) { GLib.source_remove(st.debounceId); st.debounceId = 0; }
  }
  _scheduleDebouncedCommit(key, ms) {
    const st = this._state.get(key);
    this._cancelDebounce(key);
    st.debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      st.debounceId = 0; this._commitNow(key); return GLib.SOURCE_REMOVE;
    });
  }
  _sliderTo1000(slider) { return Math.round(slider.value * 1000); }
  _applyBriIconStyle(key) {
    const st = this._state.get(key);
    if (!st) return;
    st.briIcon.remove_style_class_name('tuya-bri-on');
    st.briIcon.remove_style_class_name('tuya-bri-off');
    st.briIcon.add_style_class_name(st.isOn ? 'tuya-bri-on' : 'tuya-bri-off');
  }

  _addDeviceBlock(dev) {
    const key = dev.key || dev.devId;

    this._state.set(key, {
      isOn: false,
      lastNonZero: 0.5,
      debounceId: 0,
      pending: 0,
      slider: null,
      briIcon: null,
      titleLabel: null
    });

    const row = new PopupMenu.PopupBaseMenuItem({ activate: false, can_focus: true });
    row.add_style_class_name('tuya-nohover');

    const vbox = new St.BoxLayout({
      vertical: true, x_expand: true, y_expand: true,
      style: 'min-height: 10px; min-width: 150px; padding: 8px; gap: 8px;'
    });

    const titleLbl = new St.Label({ text: dev.name || 'Tuya Led', style_class: 'tuya-title' });
    vbox.add_child(titleLbl);

    const hbox = new St.BoxLayout({ vertical: false, x_expand: true, y_expand: true, style: 'min-height: 28px; gap: 8px;' });

    const briIcon = new St.Icon({
      icon_name: 'display-brightness-symbolic',
      style_class: 'system-status-icon tuya-bri-icon',
      reactive: true, can_focus: true, track_hover: true,
      y_align: Clutter.ActorAlign.CENTER
    });
    briIcon.connect('button-press-event', () => this._onBriIconClick(key));

    const slider = new Slider.Slider(0.0);
    slider.x_expand = true;

    slider.connect('drag-begin', () => this._cancelDebounce(key));
    slider.connect('drag-end', () => {
      const v01 = slider.value;
      if (v01 > 0) this._state.get(key).lastNonZero = v01;
      this._state.get(key).pending = this._sliderTo1000(slider);
      this._commitNow(key);
    });
    slider.connect('notify::value', () => {
      const v01 = slider.value;
      if (v01 > 0) this._state.get(key).lastNonZero = v01;
      this._state.get(key).pending = this._sliderTo1000(slider);
      this._scheduleDebouncedCommit(key, 1000);
    });

    hbox.add_child(briIcon);
    hbox.add_child(slider);
    vbox.add_child(hbox);
    row.add_child(vbox);
    this.menu.addMenuItem(row);

    const st = this._state.get(key);
    st.slider = slider;
    st.briIcon = briIcon;
    st.titleLabel = titleLbl;
    this._applyBriIconStyle(key);

    this._initFromDevice(dev); 
  }

  async _initFromDevice(dev) {
    const key = dev.key || dev.devId;
    const st = this._state.get(key);
    if (!st) return;
    try {
      const { on, brightness } = await queryStatus(key);
      st.isOn = on;
      if (typeof brightness === 'number') {
        const v01 = Math.max(0, Math.min(1, brightness / 1000));
        st.slider.value = on ? v01 : 0.0;
        if (v01 > 0) st.lastNonZero = v01;
      } else {
        st.slider.value = on ? st.lastNonZero : 0.0;
      }
      this._applyBriIconStyle(key);
    } catch { /* device may be offline at startup */ }
  }

  async _onBriIconClick(key) {
    const st = this._state.get(key);
    if (!st) return;
    try {
      if (st.isOn) {
        await sendPower(key, false);
        st.isOn = false;
        this._cancelDebounce(key);
        st.slider.value = 0.0;
        st.pending = 0;
      } else {
        await sendPower(key, true);
        st.isOn = true;
        const v01 = Math.max(0.01, Math.min(1.0, st.lastNonZero));
        st.slider.value = v01;
        st.pending = Math.round(v01 * 1000);
        await sendBrightness(key, st.pending);
      }
      this._applyBriIconStyle(key);
    } catch (e) {
      Main.notify('Tuya Toggle', (e?.message || e) + '');
    }
    return Clutter.EVENT_STOP;
  }

  async _commitNow(key) {
    const st = this._state.get(key);
    if (!st) return;
    const v = st.pending;
    try {
      if (v <= 0) {
        await sendPower(key, false);
        st.isOn = false;
      } else {
        if (!st.isOn) {
          await sendPower(key, true);
          st.isOn = true;
        }
        await sendBrightness(key, v);
      }
      this._applyBriIconStyle(key);
    } catch (e) {
      Main.notify('Tuya Toggle', (e?.message || e) + '');
    }
  }
});

export default TuyaToggleButton;

/* ---- helpers ---- */
function openPrefs() {
  const bin = GLib.find_program_in_path('gnome-extensions') || '/usr/bin/gnome-extensions';
  const cmd = `${bin} prefs ${EXT_UUID}`;
  const proc = new Gio.Subprocess({
    argv: ['/bin/sh', '-c', cmd], 
    flags: Gio.SubprocessFlags.STDIN_PIPE
          | Gio.SubprocessFlags.STDOUT_PIPE
          | Gio.SubprocessFlags.STDERR_PIPE,
  });
  proc.init(null);
  proc.communicate_utf8_async('', null, () => {});
}
