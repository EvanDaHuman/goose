import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Goose",
  description: "Goose upgrades old Flask + SQLite applications to FastAPI + PostgreSQL and proves the result.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="brand"><span className="brand-mark">G</span>Goose</Link>
            <nav className="nav">
              <Link href="/">What we upgrade</Link>
              <Link href="/start">Start a job</Link>
            </nav>
            <div className="spacer" />
            <nav className="nav">
              <Link href="/ops">Operator</Link>
              <Link href="/ops/company">Company</Link>
              <Link href="/ops/naive">Naive</Link>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
