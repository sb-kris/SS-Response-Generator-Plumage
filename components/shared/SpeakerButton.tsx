"use client";

import { useRef, type MouseEvent } from "react";
import { cn } from "@/lib/utils";

interface Props {
  /** Callback fired on click. Receives the click event so consumers can
   *  stopPropagation() (e.g. when the button sits inside a clickable
   *  header). */
  onPlay: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Accessibility label + tooltip text. */
  label?: string;
  /** Extra classes applied to the outer button. */
  className?: string;
}

// Animated speaker button — webm video as the icon glyph.
//
// Why webm: the user provided /brand/speaker_icon.webm (10KB) as a small
// looping animation. `<video autoplay loop muted playsInline>` renders it
// as a self-contained animated icon, no canvas, no spritesheet.
//
// Behaviour: on click we (a) seek to start to make the animation feel
// "responsive" — even though it's looping, restarting feels like a tap —
// and (b) call the consumer's play handler.
//
// The webm is mute-muted, never plays audio. Audio comes from the
// onPlay callback (e.g. replayCelebration → Web Audio synth or MP3).
export function SpeakerButton({ onPlay, label = "Replay sound", className }: Props) {
  const vidRef = useRef<HTMLVideoElement>(null);

  function handleClick(e: MouseEvent<HTMLButtonElement>) {
    // Restart the visual loop so the click feels acknowledged.
    const v = vidRef.current;
    if (v) {
      try {
        v.currentTime = 0;
        void v.play();
      } catch {
        /* ignore — video already playing */
      }
    }
    onPlay(e);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      title={label}
      className={cn(
        "group relative inline-flex items-center justify-center overflow-hidden rounded-full",
        "transition-transform hover:scale-110 active:scale-95",
        className,
      )}
    >
      <video
        ref={vidRef}
        src="/brand/speaker_icon.webm"
        autoPlay
        loop
        muted
        playsInline
        // The video itself shouldn't intercept the click — the button does.
        className="pointer-events-none h-full w-full object-contain"
        aria-hidden
      />
    </button>
  );
}
