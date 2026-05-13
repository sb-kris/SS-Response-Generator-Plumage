import { ImageResponse } from "next/og";

// OpenGraph card — 1200×630, served at /opengraph-image. Dark indigo
// background with feather, "Plumage" wordmark, and tagline.

export const alt = "Plumage — Demo data, fully feathered.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: "0 96px",
          background: "linear-gradient(135deg, #0f0c2e 0%, #1e1b4b 50%, #2d2a5e 100%)",
          color: "#e0e7ff",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        {/* Feather mark — sized large to anchor the composition */}
        <svg
          width="100"
          height="100"
          viewBox="0 0 40 40"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <linearGradient id="og-grad" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#818cf8" />
              <stop offset="0.55" stopColor="#a78bfa" />
              <stop offset="1" stopColor="#5eead4" />
            </linearGradient>
          </defs>
          <path
            d="M20 4c-7 4-11 11-11 18 0 5 3 9 7 11 1-6 4-12 10-18-2 6-5 12-6 18 4-1 8-4 10-9 2-5 1-12-2-16-2-3-5-5-8-4z"
            fill="url(#og-grad)"
          />
        </svg>

        <div
          style={{
            fontSize: 132,
            fontWeight: 700,
            letterSpacing: -3,
            marginTop: 28,
            color: "#f5f3ff",
          }}
        >
          Plumage
        </div>

        <div
          style={{
            fontSize: 36,
            color: "#a5b4fc",
            marginTop: 8,
            fontWeight: 400,
          }}
        >
          Demo data, fully feathered.
        </div>

        <div
          style={{
            fontSize: 22,
            color: "#818cf8",
            marginTop: 48,
            opacity: 0.7,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          Internal · SurveySparrow Presales
        </div>
      </div>
    ),
    { ...size },
  );
}
