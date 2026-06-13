/**
 * RingtoneService — plays call ringtones using the Web Audio API.
 *
 * Built-in ringtones are synthesized entirely in-browser — no audio files required.
 * The selected ringtone + volume is persisted in localStorage per username.
 *
 * Usage:
 *   RingtoneService.start()   — begin looping ringtone
 *   RingtoneService.stop()    — stop immediately
 *   RingtoneService.preview() — play a short preview then stop
 */

export interface RingtoneDefinition {
  id: string;
  label: string;
  /** Generate one "ring" cycle using the provided AudioContext */
  play: (ctx: AudioContext, volume: number) => number; // returns duration in seconds
}

// ── Built-in ringtone definitions ────────────────────────────────────────────

export const RINGTONES: RingtoneDefinition[] = [
  {
    id: 'classic',
    label: 'Classic Ring',
    play(ctx, vol) {
      const t = ctx.currentTime;
      const beep = (start: number, freq: number, dur: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(vol, start + 0.01);
        gain.gain.setValueAtTime(vol, start + dur - 0.02);
        gain.gain.linearRampToValueAtTime(0, start + dur);
        osc.start(start); osc.stop(start + dur);
      };
      beep(t,       480, 0.4);
      beep(t + 0.5, 480, 0.4);
      return 1.8; // cycle duration
    },
  },
  {
    id: 'modern',
    label: 'Modern Buzz',
    play(ctx, vol) {
      const t = ctx.currentTime;
      const pulse = (start: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'square';
        osc.frequency.setValueAtTime(880, start);
        osc.frequency.exponentialRampToValueAtTime(660, start + 0.15);
        gain.gain.setValueAtTime(vol * 0.4, start);
        gain.gain.linearRampToValueAtTime(0, start + 0.15);
        osc.start(start); osc.stop(start + 0.15);
      };
      pulse(t); pulse(t + 0.2); pulse(t + 0.4);
      return 1.4;
    },
  },
  {
    id: 'gentle',
    label: 'Gentle Chime',
    play(ctx, vol) {
      const t = ctx.currentTime;
      const chime = (start: number, freq: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(vol, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.8);
        osc.start(start); osc.stop(start + 0.8);
      };
      chime(t,       1047); // C6
      chime(t + 0.15, 1319); // E6
      chime(t + 0.3,  1568); // G6
      return 1.6;
    },
  },
  {
    id: 'pulse',
    label: 'Digital Pulse',
    play(ctx, vol) {
      const t = ctx.currentTime;
      const blip = (start: number, freq: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(vol * 0.6, start + 0.02);
        gain.gain.linearRampToValueAtTime(0, start + 0.1);
        osc.start(start); osc.stop(start + 0.1);
      };
      for (let i = 0; i < 4; i++) blip(t + i * 0.18, 660 + i * 40);
      return 1.2;
    },
  },
  {
    id: 'marimba',
    label: 'Marimba',
    play(ctx, vol) {
      const t = ctx.currentTime;
      const note = (start: number, freq: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(vol, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.5);
        osc.start(start); osc.stop(start + 0.5);
      };
      // G4 E4 C4 G4
      [392, 330, 262, 392].forEach((f, i) => note(t + i * 0.14, f));
      return 1.5;
    },
  },
  {
    id: 'silent',
    label: 'Silent',
    play(_ctx, _vol) { return 1; },
  },
];

// ── Storage keys ──────────────────────────────────────────────────────────────
const STORAGE_KEY_ID  = (u: string) => `${u}_ringtone_id`;
const STORAGE_KEY_VOL = (u: string) => `${u}_ringtone_vol`;

export function getSavedRingtoneId(username: string): string {
  return localStorage.getItem(STORAGE_KEY_ID(username)) ?? 'classic';
}
export function getSavedVolume(username: string): number {
  return parseFloat(localStorage.getItem(STORAGE_KEY_VOL(username)) ?? '0.7');
}
export function saveRingtone(username: string, id: string, volume: number) {
  localStorage.setItem(STORAGE_KEY_ID(username), id);
  localStorage.setItem(STORAGE_KEY_VOL(username), String(volume));
}

// ── Runtime playback ──────────────────────────────────────────────────────────

let activeCtx: AudioContext | null = null;
let loopTimeout: ReturnType<typeof setTimeout> | null = null;

function getRingtone(id: string): RingtoneDefinition {
  return RINGTONES.find(r => r.id === id) ?? RINGTONES[0];
}

/** Start looping the ringtone for an incoming call */
export function startRingtone(username: string) {
  stopRingtone();
  const id  = getSavedRingtoneId(username);
  const vol = getSavedVolume(username);
  if (id === 'silent') return;

  const ring = getRingtone(id);

  const loop = () => {
    try {
      const ctx = new AudioContext();
      activeCtx = ctx;
      const cycleDur = ring.play(ctx, vol);
      loopTimeout = setTimeout(() => {
        ctx.close();
        activeCtx = null;
        loopTimeout = null;
        loop(); // next iteration
      }, cycleDur * 1000);
    } catch { /* AudioContext unavailable */ }
  };
  loop();
}

/** Stop the ringtone */
export function stopRingtone() {
  if (loopTimeout !== null) { clearTimeout(loopTimeout); loopTimeout = null; }
  if (activeCtx) { activeCtx.close().catch(() => {}); activeCtx = null; }
}

/** Play a single preview cycle then stop */
export function previewRingtone(id: string, vol: number) {
  stopRingtone();
  if (id === 'silent') return;
  const ring = getRingtone(id);
  try {
    const ctx = new AudioContext();
    activeCtx = ctx;
    const dur = ring.play(ctx, vol);
    setTimeout(() => { ctx.close(); activeCtx = null; }, dur * 1000 + 100);
  } catch { /* ignore */ }
}
