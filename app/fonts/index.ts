// Self-hosted brand fonts for the public site (latin subsets; see LICENSE.txt). Each exposes a CSS
// variable that app/site.css builds its font stacks on (the fallback families live there, quoted).
import localFont from "next/font/local";

export const displayFont = localFont({
  src: [
    { path: "./BodoniModa-latin.woff2", style: "normal", weight: "400 900" },
    { path: "./BodoniModa-latin-italic.woff2", style: "italic", weight: "400 900" },
  ],
  variable: "--font-display-face",
  display: "swap",
  adjustFontFallback: "Times New Roman",
});

export const bodyFont = localFont({
  src: "./HankenGrotesk-latin.woff2",
  weight: "100 900",
  variable: "--font-body-face",
  display: "swap",
});

export const monoFont = localFont({
  src: "./JetBrainsMono-latin.woff2",
  weight: "100 800",
  variable: "--font-mono-face",
  display: "swap",
});

export const siteFontVars = `${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`;
