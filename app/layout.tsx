import type { Metadata } from "next";
import { AppTopbar } from "@/components/AppTopbar";
import type { ReactNode } from "react";
import { siteFontVars } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Goose | Autonomous engineering", template: "%s | Goose" },
  description: "Give Goose your existing software and the outcome you need. Our agent team assesses, implements, and independently verifies the change, from proposal through delivery and support.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" className={siteFontVars}><body>
    <a href="#main-content" className="skip-link">Skip to content</a>
    <AppTopbar />
    <div id="main-content">{children}</div>
  </body></html>;
}
