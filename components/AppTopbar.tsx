"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The public pages (/ and /start) have their own navigation (components/site/SiteNav.tsx); every other page keeps this bar.
const PUBLIC = new Set(["/", "/start"]);

export function AppTopbar() {
  if (PUBLIC.has(usePathname() ?? "")) return null;
  return (
    <header className="topbar"><div className="topbar-inner">
      <Link href="/" className="brand" aria-label="Goose home"><svg className="brand-goose" width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M5 24c0-5 4-9 10-9h3V8a5 5 0 0 1 10 0v2l-6 2v7c0 5-4 9-10 9H8l-3-4Z" fill="currentColor"/><path d="m27 8 5 2-5 2V8Z" fill="#d8aa63"/><circle cx="24.5" cy="7.5" r="1.2" fill="var(--surface)"/><path d="M1 20h9l-5 4-4-4Z" fill="currentColor"/></svg>goose<span className="brand-caption">ENGINEERING</span></Link>
      <nav className="nav" aria-label="Main navigation"><Link href="/#intro">What we do</Link><Link href="/contact">Discuss a change</Link></nav>
      <div className="spacer" />
      <nav className="nav" aria-label="Workspace navigation"><Link href="/ops" className="nav-ops">Operations</Link><Link href="/start" className="nav-start">Start a job <span aria-hidden="true">↗</span></Link></nav>
    </div></header>
  );
}
