import Link from "next/link";
import type { ReactNode } from "react";
import { DELIVERY_STEPS, DELIVERY_STEPS_V2, STAGES } from "@/lib/jobs";

export const ROLE_NAMES: Record<string, string> = {
  coordinator: "Coordinator", assessment: "Assessment agent", implementation: "Implementation agent", verification: "Verification agent",
  commercial: "Commercial agent", modernization: "Modernization agent", customer: "Customer", founder: "Founder", system: "System",
};

/** Where a recorded step came from. Rows recorded before tracking began are shown as what they were: deterministic workers. */
export function Origin({ origin, detail, source }: { origin: string | null; detail?: any; source?: string }) {
  if (origin === "agent") return <span className="origin agent" title={detail?.session_id ? `Naive session ${detail.session_id}` : "Naive session"}>Agent (Naive)</span>;
  if (origin === "human") return <span className="origin human">Person</span>;
  if (origin === "fixture") return <span className="origin fixture">Demo fixture</span>;
  if (origin === "system") return <span className="origin">System</span>;
  if (origin === "tool") return <span className="origin" title={detail?.tool ?? ""}>Tool{detail?.tool ? `: ${detail.tool}` : ""}</span>;
  return <span className="origin" title="Recorded before provenance tracking">{source === "naive" ? "Naive" : "Deterministic worker"}</span>;
}

export function Pill({ tone, children }: { tone: "ok" | "bad" | "warn" | "info" | "neutral"; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function JobStatus({ status, stage }: { status: string; stage: string }) {
  if (status === "done") return <Pill tone="ok">Complete</Pill>;
  if (status === "rejected") return <Pill tone="neutral">Not a fit yet</Pill>;
  if (status === "declined") return <Pill tone="neutral">Declined</Pill>;
  if (status === "waiting_founder") return <Pill tone="warn">Needs founder</Pill>;
  if (status === "waiting_customer") return <Pill tone="info">Waiting for customer</Pill>;
  if (stage === "repair") return <Pill tone="bad">Repairing</Pill>;
  return <Pill tone="info">Working</Pill>;
}

export function KindTag({ kind }: { kind: string }) {
  return kind === "demo" ? <span className="tag demo" title="Synthetic business and data">Demo · synthetic data</span>
    : <span className="tag real">Real customer</span>;
}

export function usd(micro: number | string | null | undefined, digits = 4) {
  return `$${(Number(micro ?? 0) / 1_000_000).toFixed(digits)}`;
}

export function dollars(cents: number | null | undefined) {
  return cents == null ? "-" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function when(d: string | Date | null | undefined) {
  if (!d) return "-";
  const t = new Date(d);
  return t.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function clock(d: string | Date) {
  return new Date(d).toLocaleTimeString("en-US", { hour12: false });
}

export function Steps({ stage, status, failedAttempts = 0, pipeline = 1 }: { stage: string; status: string; failedAttempts?: number; pipeline?: number }) {
  const order = pipeline >= 2 ? DELIVERY_STEPS_V2 : DELIVERY_STEPS;
  const pos = (s: string) => {
    if (s === "intake") return 0;
    if (s === "awaiting_info") return pipeline >= 2 ? order.indexOf("plan") : 0;
    if (s === "awaiting_acceptance") return order.indexOf("propose");
    if (s === "migrate") return order.indexOf(pipeline >= 2 ? "implement" : "modernize");
    if (s === "repair") return order.indexOf("verify");
    if (s === "follow_up" || s === "closed") return order.length;
    return order.indexOf(s);
  };
  const cur = pos(stage);
  const labels: Record<string, string> = { assess: "Assess", inspect: "Inspect", plan: "Plan", propose: "Agree", baseline: "Record",
    freeze: "Freeze checks", modernize: "Upgrade", implement: "Change", verify: "Verify", package: "Package", delivered: "Deliver", invoice: "Invoice" };
  return (
    <div className="steps" aria-label="Progress">
      {order.map((s, i) => {
        let cls = i < cur ? "done" : i === cur ? "now" : "";
        if (i === cur && status === "waiting_founder") cls = "now stuck";
        if (s === "verify" && failedAttempts > 0 && i <= cur) cls += i < cur ? " done" : " failed";
        return <div key={s} className={`step ${cls}`}>{labels[s] ?? STAGES[s]?.label}</div>;
      })}
    </div>
  );
}

export function ModeBanner({ mode }: { mode: string }) {
  return mode === "naive"
    ? <div className="banner info"><b>Live agents (Naive)</b><span>The assessment, implementation and verification agents and the coordinator run as Naive sessions with budgets; each decision below says whether an agent, a deterministic tool or a person made it. Costs marked "metered" come from Naive.</span></div>
    : <div className="banner info"><b>Local mode - no AI</b><span>Plans and code changes come from Goose's deterministic tools on this machine; no AI model is called and nothing runs on Naive. Work that needs the live agents stops and says so. Costs are estimates at Naive's published computer rate; nothing is billed.</span></div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted small">{children}</p>;
}

export function Back({ href, children }: { href: string; children: ReactNode }) {
  return <p className="small"><Link href={href}>&larr; {children}</Link></p>;
}
