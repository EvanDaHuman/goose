"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The public pages (/ and /start) have their own navigation (components/site/SiteNav.tsx); every other page keeps this bar,
// styled like the public nav (black and gold, with the logo).
const PUBLIC = new Set(["/", "/start"]);

export function AppTopbar() {
  const path = usePathname() ?? "";
  if (PUBLIC.has(path)) return null;
  return (
    <header className="topbar"><div className="topbar-inner">
      <Link href="/" className="brand" aria-label="Goose home">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/goose-logo.webp" alt="Goose" width={757} height={210} />
      </Link>
      <nav className="nav" aria-label="Main navigation"><Link href="/#intro">What it does</Link><Link href="/#examples">Examples</Link><Link href="/contact">Contact</Link></nav>
      <div className="spacer" />
      <nav className="nav" aria-label="Workspace navigation">
        <Link href="/ops" className={`nav-ops${path.startsWith("/ops") ? " active" : ""}`}>Operations</Link>
        {/* no "Begin migration" on a job's own page: that job is already under way */}
        {!path.startsWith("/jobs/") && <Link href="/start" className="nav-start">Begin migration</Link>}
      </nav>
    </div></header>
  );
}
