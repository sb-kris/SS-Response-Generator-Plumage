// Build coherent User-Agent strings for fake personas.
//
// We don't aim for perfect cross-version accuracy — just plausible UAs that
// match the browser/OS pair. Minor versions vary so personas don't all share
// the exact same UA string. Major versions are pinned to "current" as of
// the spec's quality bar (May 2026).

import type { DeviceType } from "@/lib/generation/persona-types";

interface UAInput {
  deviceType: DeviceType;
  browser: string; // "Chrome" | "Safari" | "Firefox" | "Edge" | "Samsung Internet" | "Other"
  os: string; // "Windows" | "macOS" | "iOS" | "Android" | "Linux"
  rng: () => number; // injected so callers can seed deterministically if needed
}

function pickInt(rng: () => number, min: number, max: number): number {
  return Math.floor(min + rng() * (max - min + 1));
}

function chromeMajor(rng: () => number): number {
  // Chrome's release cadence: roughly +1 major per month; Chrome 124 shipped
  // around Apr 2024. By May 2026 we're around 134-138. Spread within range.
  return pickInt(rng, 130, 140);
}

function chromeFullVersion(rng: () => number): string {
  return `${chromeMajor(rng)}.0.${pickInt(rng, 4000, 7000)}.${pickInt(rng, 30, 200)}`;
}

function safariFullVersion(rng: () => number): string {
  // Safari versioning: 17.x was 2024, 18.x ~2025. Use 18.
  const minor = pickInt(rng, 0, 5);
  return `18.${minor}`;
}

function firefoxFullVersion(rng: () => number): string {
  return `${pickInt(rng, 124, 138)}.0`;
}

function edgeFullVersion(rng: () => number): string {
  return `${chromeMajor(rng)}.0.${pickInt(rng, 2000, 3000)}.${pickInt(rng, 30, 100)}`;
}

function macOSToken(rng: () => number): string {
  // macOS 14 Sonoma → 15 Sequoia → 16. Use realistic spread.
  const major = pickInt(rng, 14, 16);
  const minor = pickInt(rng, 0, 6);
  return `Macintosh; Intel Mac OS X 10_15_${major}_${minor}`;
}

function windowsToken(): string {
  // Modern Chrome reports "Windows NT 10.0" even on Windows 11. Universal.
  return "Windows NT 10.0; Win64; x64";
}

function linuxToken(): string {
  return "X11; Linux x86_64";
}

function iOSToken(rng: () => number, deviceType: DeviceType): string {
  // iOS 17 → 18 in 2025. iPad reports a slightly different platform string.
  const major = pickInt(rng, 17, 19);
  const minor = pickInt(rng, 0, 6);
  if (deviceType === "Tablet") {
    return `iPad; CPU OS ${major}_${minor} like Mac OS X`;
  }
  return `iPhone; CPU iPhone OS ${major}_${minor} like Mac OS X`;
}

function androidToken(rng: () => number, deviceType: DeviceType): string {
  const major = pickInt(rng, 13, 15);
  const buildNum = pickInt(rng, 1000, 9999);
  if (deviceType === "Tablet") {
    return `Linux; Android ${major}; SM-X710 Build/UP1A.${buildNum}.001`;
  }
  // Random plausible Samsung / Pixel device string
  const deviceCode = rng() < 0.5 ? `SM-S92${pickInt(rng, 1, 9)}U` : `Pixel ${pickInt(rng, 7, 9)}`;
  return `Linux; Android ${major}; ${deviceCode} Build/UP1A.${buildNum}.001`;
}

export function buildUserAgent(input: UAInput): string {
  const { browser, os, deviceType, rng } = input;

  // --- Chrome on various OSes ---
  if (browser === "Chrome") {
    const ver = chromeFullVersion(rng);
    const platform =
      os === "Windows"
        ? windowsToken()
        : os === "macOS"
          ? macOSToken(rng)
          : os === "Linux"
            ? linuxToken()
            : os === "Android"
              ? androidToken(rng, deviceType)
              : os === "iOS"
                ? iOSToken(rng, deviceType)
                : windowsToken();

    if (os === "iOS") {
      // iOS Chrome uses CriOS, not Chrome.
      return `Mozilla/5.0 (${platform}) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${ver} Mobile/15E148 Safari/604.1`;
    }
    if (os === "Android") {
      return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Mobile Safari/537.36`;
    }
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
  }

  // --- Safari (Apple-only) ---
  if (browser === "Safari") {
    const ver = safariFullVersion(rng);
    if (os === "iOS") {
      const platform = iOSToken(rng, deviceType);
      return `Mozilla/5.0 (${platform}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ver} Mobile/15E148 Safari/604.1`;
    }
    // macOS Safari
    const platform = macOSToken(rng);
    return `Mozilla/5.0 (${platform}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ver} Safari/605.1.15`;
  }

  // --- Firefox ---
  if (browser === "Firefox") {
    const ver = firefoxFullVersion(rng);
    const platform =
      os === "Windows"
        ? windowsToken()
        : os === "macOS"
          ? macOSToken(rng)
          : os === "Linux"
            ? linuxToken()
            : os === "Android"
              ? `Android ${pickInt(rng, 13, 15)}; Mobile`
              : windowsToken();
    return `Mozilla/5.0 (${platform}; rv:${ver}) Gecko/20100101 Firefox/${ver}`;
  }

  // --- Edge (always Chromium-based) ---
  if (browser === "Edge") {
    const chromeVer = chromeFullVersion(rng);
    const edgeVer = edgeFullVersion(rng);
    const platform =
      os === "Windows" ? windowsToken() : os === "macOS" ? macOSToken(rng) : windowsToken();
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36 Edg/${edgeVer}`;
  }

  // --- Samsung Internet (Android only) ---
  if (browser === "Samsung Internet") {
    const samMajor = pickInt(rng, 23, 27);
    const platform = androidToken(rng, deviceType);
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/${samMajor}.0 Chrome/${chromeFullVersion(rng)} Mobile Safari/537.36`;
  }

  // --- "Other" fallback: generic Chromium UA ---
  return `Mozilla/5.0 (${windowsToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeFullVersion(rng)} Safari/537.36`;
}
