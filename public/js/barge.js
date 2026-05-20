import * as voice from './voice.js';
import { getMicAmp, captureCommand, getMuted } from './wake.js';

let noiseFloor = 0.02;
let active = false;
let triggerStart = 0;

const HOLD_MS = 180;
const HEADROOM = 0.06; // RMS units (rough); adjust with calibration

window.addEventListener('friday:speaking', (e) => {
  active = !!e.detail;
  triggerStart = 0;
});

setInterval(() => {
  if (getMuted()) return;
  const amp = getMicAmp();
  // Track noise floor while not speaking (decay slowly)
  if (!active) {
    noiseFloor = noiseFloor * 0.95 + amp * 0.05;
    return;
  }
  const threshold = noiseFloor + HEADROOM;
  if (amp > threshold) {
    if (!triggerStart) triggerStart = performance.now();
    else if (performance.now() - triggerStart > HOLD_MS) {
      triggerStart = 0;
      voice.stopSpeaking();
      window.dispatchEvent(new CustomEvent('friday:barge'));
      // Capture the interrupting utterance, dispatch as command
      captureCommand(3200).then((txt) => {
        if (txt && txt.trim()) window.dispatchEvent(new CustomEvent('friday:command', { detail: txt.trim() }));
      });
    }
  } else {
    triggerStart = 0;
  }
}, 60);
