import { ImageResponse } from "next/og";

// Apple touch icon — 180×180, served at /apple-icon. Mirrors the SVG icon
// but in PNG form (iOS Safari doesn't honour SVG favicons in homescreen
// shortcuts). Generated at build time via ImageResponse — no static asset.

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #6366f1 0%, #a855f7 50%, #2dd4bf 100%)",
          borderRadius: 40,
        }}
      >
        {/* White feather on the bright gradient — visible against any wallpaper */}
        <svg
          width="120"
          height="120"
          viewBox="0 0 40 40"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M20 4c-7 4-11 11-11 18 0 5 3 9 7 11 1-6 4-12 10-18-2 6-5 12-6 18 4-1 8-4 10-9 2-5 1-12-2-16-2-3-5-5-8-4z"
            fill="#FFFFFF"
            fillOpacity={0.95}
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
