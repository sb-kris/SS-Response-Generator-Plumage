"use client";

import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

interface SliderProps
  extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
  /** CSS color (string, hex, or var) used for the range fill. Defaults to primary. */
  rangeColor?: string;
  /** CSS color used for the thumb border. Defaults to primary. */
  thumbColor?: string;
}

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SliderProps
>(({ className, rangeColor, thumbColor, style, ...props }, ref) => {
  // Allow per-instance theming (used by the persona sliders to tint each
  // archetype) without forking the primitive. We thread CSS variables via
  // inline style so Tailwind's hover / focus utilities still apply.
  const themedStyle: React.CSSProperties = {
    ...style,
    ...(rangeColor ? ({ ["--slider-range" as string]: rangeColor } as React.CSSProperties) : {}),
    ...(thumbColor ? ({ ["--slider-thumb" as string]: thumbColor } as React.CSSProperties) : {}),
  };

  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn(
        "relative flex w-full touch-none select-none items-center",
        className,
      )}
      style={themedStyle}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary">
        <SliderPrimitive.Range
          className="absolute h-full"
          style={{
            backgroundColor: rangeColor ?? "hsl(var(--primary))",
          }}
        />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className="block h-5 w-5 rounded-full border-2 bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
        style={{
          borderColor: thumbColor ?? rangeColor ?? "hsl(var(--primary))",
        }}
      />
    </SliderPrimitive.Root>
  );
});
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
