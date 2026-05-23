import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif, Inter } from "next/font/google";
import Script from "next/script";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { CursorAvatarTrail } from "@/components/effects/CursorAvatarTrail";
import { ButtonClickListener } from "@/components/effects/ButtonClickListener";
import "./globals.css";

// Geist Sans — primary UI font. Replaces Inter as the body default.
const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

// Geist Mono — pairs with Geist Sans more cohesively than JetBrains Mono.
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

// Instrument Serif — reserved for celebratory/hero moments only
// (synthesis-complete headlines, push-complete success states).
// Importing once, used sparingly per the design brief.
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-instrument-serif",
  display: "swap",
});

// Inter — kept loaded as a secondary fallback for compatibility with any
// pre-existing references to --font-inter. Body default is Geist Sans.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Plumage — Demo data, fully feathered.",
  description:
    "Internal SurveySparrow Presales tool for generating persona-driven, multilingual survey responses for demos.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} ${inter.variable}`}
    >
      <body className="min-h-screen bg-background font-sans">
        {/*
          Apply the stored colour-theme class BEFORE first paint so there's
          no flash of the wrong theme on hard reload. Runs synchronously via
          beforeInteractive, before any React hydration.
        */}
        <Script
          id="plumage-theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('plumage-color-theme');if(t&&t!=='default'){document.documentElement.classList.add('theme-'+t);}}catch(e){}})();`,
          }}
        />
        <ThemeProvider
          attribute="class"
          // Light mode is the default for first-time visitors (8e). Most
          // demos and screenshares happen on bright displays, so a light
          // baseline reads better in front of customers. `enableSystem`
          // is preserved so a user who prefers dark mode can still flip
          // via the toggle or via OS-level system theme.
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider delayDuration={250}>
            {children}
            {/* Mounted globally — self-disables when not generating and
                when the user hasn't opted in. Off by default. */}
            <CursorAvatarTrail />
            {/* Window-level click listener for the button click chime.
                Catches every interactive element, not just shadcn Buttons.
                Itself silent — playButtonClick gates on the user pref. */}
            <ButtonClickListener />
            <Toaster richColors position="top-right" />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
