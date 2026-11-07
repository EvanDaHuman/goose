import Link from "next/link";
import { StartForm } from "@/components/StartForm";

export const dynamic = "force-dynamic";

export default async function Start({ searchParams }: { searchParams: Promise<{ inquiry?: string }> }) {
  const { inquiry } = await searchParams;
  return <main className="wrap">
    <div className="page-intro"><div className="kicker">Your next technical change</div><h1>Start a job</h1><p className="lead">Tell us the outcome you need and share the source. Goose assesses the system, asks the questions that matter, and proposes a fixed scope and price for your approval.</p></div>
    <div className="intake-layout section">
      <StartForm inquiryId={inquiry} />
      <aside className="stack intake-aside">
        <div className="card"><span className="kicker">What happens next</span><ol className="intake-steps"><li><b>Assessment</b><span>The agents inspect the source and your requirements.</span></li><li><b>Your proposal</b><span>Review the changes, acceptance criteria, and fixed price.</span></li><li><b>Engineering & verification</b><span>Work begins after acceptance. Failed checks block delivery.</span></li><li><b>Delivery & support</b><span>Receive the result, review the evidence, and manage follow-up work.</span></li></ol></div>
        <div className="card"><h3>Working with your source</h3><p className="small muted">Goose works on copies. The execution environment separates implementation from the independent verification evidence. With live mode enabled, Naïve agents receive the source needed for the job.</p><p className="small muted">Share only files and data you are authorized to provide. Production access and cutover are outside the intake authorization.</p></div>
        <div className="card"><h3>Still defining the change?</h3><p className="small muted">Start with your objective and constraints. You can discuss the system before uploading source.</p><Link href="/contact" className="btn small">Send an inquiry ↗</Link></div>
      </aside>
    </div>
  </main>;
}
