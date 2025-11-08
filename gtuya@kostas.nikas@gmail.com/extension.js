import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import TuyaToggleButton from './ui.js';

let indicator = null;

export default class Extension {
  enable() {
    indicator = new TuyaToggleButton();
    Main.panel.addToStatusArea('gTuya', indicator, 0, 'right');
  }
  disable() {
    if (indicator) indicator.destroy();
    indicator = null;
  }
}