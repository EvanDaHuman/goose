import type { ReactNode } from "react";
import { siteFontVars } from "@/app/fonts";
import { SiteNav } from "./SiteNav";

/** Frame for the public pages: brand fonts, the black-and-gold theme (app/site.css), nav and footer. */
export function SiteShell({ children, overHero = false }: { children: ReactNode; overHero?: boolean }) {
  return (
    <div className={`site ${siteFontVars}`}>
      <SiteNav overHero={overHero} />
      {children}
      <footer className="s-footer gutter">
        <div className="container">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/goose-logo.webp" alt="Goose" width={757} height={210} />
          <span>Built for the Naive Autonomous Company Hackathon · YC · Nov 2026</span>
        </div>
      </footer>
    </div>
  );
}
