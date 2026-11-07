import { StartForm } from "@/components/StartForm";

export const dynamic = "force-dynamic";

export default function Start() {
  return (
    <main className="wrap">
      <h1>Start a job</h1>
      <p className="lead">Tell us what you want to improve and send the application. We inspect it, then propose a plan and a fixed price
        that fit it, or tell you plainly that we cannot do it yet. Nothing is charged until the result passes the agreed checks and you accept it.</p>
      <div className="grid g2 section" style={{ alignItems: "start" }}>
        <StartForm />
        <div className="stack">
          <div className="card small muted">
            <b>How we handle your files.</b> Uploads are stored unchanged and opened read-only. Every test runs on a separate copy, in an
            isolated environment with no internet access and no access to other customers' jobs. With our live agent team on, the agents read
            a copy of the code in their own sandboxed computers on Naive; it is removed from there after delivery.
          </div>
        </div>
      </div>
    </main>
  );
}
