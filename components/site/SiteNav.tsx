"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/** The public site's top bar. Over the homepage hero it stays hidden until the visitor scrolls past half of it. */
export function SiteNav({ overHero = false }: { overHero?: boolean }) {
  const [show, setShow] = useState(!overHero);
  useEffect(() => {
    if (!overHero) return;
    const hero = document.getElementById("home");
    const onScroll = () => setShow(!hero || hero.getBoundingClientRect().bottom < window.innerHeight * 0.5);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [overHero]);
  return (
    <nav className={`s-nav gutter${show ? " show" : ""}`} aria-label="Main">
      <div className="container">
        <Link href="/" aria-label="Goose home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/goose-logo.webp" alt="Goose" width={757} height={210} />
        </Link>
        <ul>
          <li className="opt"><a href="/#intro">What it does</a></li>
          <li className="opt"><a href="/#examples">Examples</a></li>
          <li className="opt"><a href="/#demo">Live demo</a></li>
          <li className="opt"><Link href="/contact">Contact</Link></li>
          <li><Link className="s-btn primary" href="/start">Begin migration</Link></li>
        </ul>
      </div>
    </nav>
  );
}
