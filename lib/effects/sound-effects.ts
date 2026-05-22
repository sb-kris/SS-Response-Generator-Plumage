// Centralised audio cue system.
//
// Every effect follows the same pattern:
//   1. Try a static file under /public/sounds/ first.
//   2. If the file is missing or play() is blocked, synthesise the sound
//      via Web Audio API so the cue still fires.
//   3. Respect the relevant per-effect preference (read from localStorage
//      directly — these functions fire from non-React contexts).
//
// Why both file + synth: the user can drop a richer royalty-free clip into
// /public/sounds/ later without touching code, but until they do the synth
// keeps the cues functional so behaviour matches description.

// ---------------------------------------------------------------------------
// Preference keys (mirrored from store/preferences-store.ts so this module
// stays React-free and can be called from anywhere).
// ---------------------------------------------------------------------------

const SOUND_PREF_KEY = "plumage_sound_enabled";
const CLICK_PREF_KEY = "plumage_click_sound_enabled";

function isSoundEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const v = localStorage.getItem(SOUND_PREF_KEY);
    return v === null ? true : v === "true"; // default ON
  } catch {
    return true;
  }
}

function isClickSoundEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const v = localStorage.getItem(CLICK_PREF_KEY);
    // Default ON when the user hasn't expressed a preference yet.
    return v === null ? true : v === "true";
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Shared AudioContext — cheap to instantiate but expensive to leak. We
// lazily create one and reuse it; close-on-fire would cause clicks during
// rapid sequences (e.g. typing through a form).
// ---------------------------------------------------------------------------

type AudioCtxCtor = typeof AudioContext;
let sharedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (sharedCtx) return sharedCtx;
  const Ctor: AudioCtxCtor | undefined =
    (window as unknown as { AudioContext?: AudioCtxCtor }).AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioCtxCtor }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    sharedCtx = new Ctor();
    return sharedCtx;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// File-first / synth-fallback player
// ---------------------------------------------------------------------------

async function tryFileThenSynth(
  filePath: string,
  volume: number,
  synth: () => void,
): Promise<void> {
  try {
    const audio = new Audio(filePath);
    audio.volume = volume;
    await audio.play();
    return;
  } catch {
    /* fall through */
  }
  try {
    synth();
  } catch {
    /* give up silently */
  }
}

// ---------------------------------------------------------------------------
// Synth primitives — generic envelope helper used by every cue.
// ---------------------------------------------------------------------------

interface NoteSpec {
  freq: number;
  /** Seconds from "now" when this note begins. */
  delay: number;
  /** Total length in seconds, including attack + decay. */
  duration: number;
  /** Peak gain (0–1). */
  peak?: number;
  /** Oscillator wave shape. Default: sine. */
  type?: OscillatorType;
}

function playNotes(notes: NoteSpec[], masterPeak = 0.4): void {
  const ctx = getCtx();
  if (!ctx) return;
  const now = ctx.currentTime;

  // Auto-resume — browsers can suspend the context after no user gesture.
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }

  const master = ctx.createGain();
  master.gain.setValueAtTime(masterPeak, now);
  master.connect(ctx.destination);

  let maxEnd = 0;
  for (const note of notes) {
    const start = now + note.delay;
    const end = start + note.duration;
    if (end > maxEnd) maxEnd = end;

    const osc = ctx.createOscillator();
    osc.type = note.type ?? "sine";
    osc.frequency.setValueAtTime(note.freq, start);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(note.peak ?? 0.9, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

// ---------------------------------------------------------------------------
// Public cue functions
// ---------------------------------------------------------------------------

/** Long, layered celebration arpeggio — used on the first successful push. */
export async function playCelebration(): Promise<void> {
  if (!isSoundEnabled()) return;
  await tryFileThenSynth("/sounds/celebration.mp3", 0.6, () => {
    // C5 → E5 → G5 arpeggio over ~1.4 s
    playNotes(
      [
        { freq: 523.25, delay: 0, duration: 0.95, peak: 0.9 },
        { freq: 659.25, delay: 0.08, duration: 0.95, peak: 0.9 },
        { freq: 783.99, delay: 0.16, duration: 1.0, peak: 0.95 },
        { freq: 1046.5, delay: 0.32, duration: 0.85, peak: 0.7 },
      ],
      0.35,
    );
  });
}

/** Short, bright two-note "good!" — for setup connection success, etc. */
export async function playSuccessChime(): Promise<void> {
  if (!isSoundEnabled()) return;
  await tryFileThenSynth("/sounds/success_chime.mp3", 0.5, () => {
    // E5 → A5 — quick ascending major-third → fourth
    playNotes(
      [
        { freq: 659.25, delay: 0, duration: 0.18, peak: 0.85 },
        { freq: 880.0, delay: 0.09, duration: 0.32, peak: 0.85 },
      ],
      0.3,
    );
  });
}

/** Short, muted descending tone — for setup connection failure, etc. */
export async function playErrorChime(): Promise<void> {
  if (!isSoundEnabled()) return;
  await tryFileThenSynth("/sounds/error_chime.mp3", 0.5, () => {
    // E5 → C5 — gentle descending minor-third; clearly "no" without being
    // a harsh buzz. Triangle wave for a slightly grittier texture vs sine.
    playNotes(
      [
        { freq: 659.25, delay: 0, duration: 0.18, peak: 0.7, type: "triangle" },
        { freq: 523.25, delay: 0.09, duration: 0.32, peak: 0.7, type: "triangle" },
      ],
      0.28,
    );
  });
}

/** Drawn-out descending "fahhh" — the opposite of the celebration arpeggio.
 *  Fires when a push completes with failures or when generation fails outright.
 *  Respects the same `plumage_sound_enabled` preference as the other cues
 *  (status chimes, celebration) — if status chimes are off, this stays
 *  silent too. The file (`fahhh_failure.mp3`) is the primary source; the
 *  synth fallback is a slow descending triangle progression that captures
 *  the same deflating feeling without sounding harsh. */
export async function playFailureCue(): Promise<void> {
  if (!isSoundEnabled()) return;
  await tryFileThenSynth("/sounds/fahhh_failure.mp3", 0.55, () => {
    // G4 → E4 → C4 descending — slow, deflating. Triangle wave for a
    // slightly soft, sigh-y texture rather than a pure sine tone.
    playNotes(
      [
        { freq: 392.0, delay: 0,    duration: 0.55, peak: 0.65, type: "triangle" },
        { freq: 329.63, delay: 0.32, duration: 0.65, peak: 0.65, type: "triangle" },
        { freq: 261.63, delay: 0.7,  duration: 0.95, peak: 0.7,  type: "triangle" },
      ],
      0.32,
    );
  });
}

/** Subtle, very short click — only fires when the click-sound preference is
 *  on (opt-in, defaults off). Used by the Button primitive. */
export async function playButtonClick(): Promise<void> {
  if (!isClickSoundEnabled()) return;
  await tryFileThenSynth("/sounds/button_click.mp3", 0.25, () => {
    // 1.2 kHz square pulse, 35 ms — feels like a soft mechanical key.
    playNotes(
      [{ freq: 1200, delay: 0, duration: 0.035, peak: 0.6, type: "square" }],
      0.18,
    );
  });
}
