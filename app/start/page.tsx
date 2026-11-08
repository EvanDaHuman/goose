import type { Metadata } from "next";
import Link from "next/link";
import { BeginForm } from "@/components/site/BeginForm";
import { SiteShell } from "@/components/site/SiteShell";
import { EXAMPLES } from "@/components/site/samples";
import "../site.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Start an engineering job" };

export default async function Start({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const ex = EXAMPLES.find((e) => e.sample === str(sp.example));
  return (
    <SiteShell>
      <div className="gutter page-top">
        <div className="container">
          <Link className="back" href="/">← Back to home</Link>
          <div style={{ display: "grid", gap: 16 }}>
            <div className="eyebrow">Start an engineering job</div>
            <h1 className="h2">Tell us where your software <em>needs to go</em>.</h1>
          </div>
          <div className="begin-grid">
            <BeginForm prefill={ex ? { from: ex.from, to: ex.to, goal: ex.goal } : undefined} githubStatus={str(sp.github)} inquiryId={str(sp.inquiry)} />
            <aside className="next" aria-label="What happens next">
              <h3>What happens next</h3>
              <ol>
                <li><span><b>We inspect your code</b> with read-only access and send a plan with a fixed price, or tell you plainly that we can&apos;t do it yet.</span></li>
                <li><span><b>You accept</b>, and we record how your app behaves today and freeze the checks.</span></li>
                <li><span><b>Goose does the work</b> on copies, and a separate verifier compares old and new.</span></li>
                <li><span><b>You get</b> the verified code, execution evidence and instructions for reproducing the checks. Migration plans include cutover and recovery requirements. Then the invoice.</span></li>
              </ol>
              <p className="fine">Your code is stored unchanged and opened read-only. Every test runs on a separate copy, in an isolated environment with
                no internet access. If we cannot finish and prove a job, the plan says so before you pay anything.</p>
              <p className="fine">Still defining the change? <Link href="/contact">Send an inquiry</Link> and discuss the system before sharing code.</p>
            </aside>
          </div>
        </div>
      </div>
    </SiteShell>
  );
}
