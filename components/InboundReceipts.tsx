"use client";

import { useState } from "react";

type Receipt = {
  id: number; event_type: string; sender: string | null; subject: string | null;
  is_test: boolean; outcome: "inquiry" | "ignored" | "needs_review";
  reason: string | null; inquiry_id: number | null; received_at: string;
  text_body?: string | null; html_body?: string | null; message_id?: string | null;
};

export function InboundReceipts({ receipts, inquiryIds }: { receipts: Receipt[]; inquiryIds: number[] }) {
  return <section className="card"><div className="card-head"><h2>Incoming email</h2><span className="small muted">AgentMail receipts</span></div>
    <p className="small muted">Signed inbox events create inquiries or enter review. Email alone does not grant access to an existing customer workspace.</p>
    {receipts.length ? receipts.map(receipt => <IncomingReceipt key={receipt.id} receipt={receipt} inquiryVisible={receipt.inquiry_id !== null && inquiryIds.includes(receipt.inquiry_id)} />)
      : <p className="business-empty">Incoming email will appear here after the AgentMail webhook and inbox are configured.</p>}
  </section>;
}

function IncomingReceipt({ receipt, inquiryVisible }: { receipt: Receipt; inquiryVisible: boolean }) {
  const [original, setOriginal] = useState<Receipt | null>(null);
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const read = async () => {
    if (original) { setExpanded(!expanded); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/commerce/inbound/${encodeURIComponent(receipt.id)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load the original email.");
      setOriginal(data); setExpanded(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const bodyStyle = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 360, overflow: "auto", fontSize: ".86rem", lineHeight: 1.65 } as const;
  return <article className="business-entry incoming-receipt">
    <div className="row between"><b>{receipt.subject || "(No subject)"}</b><div className="row"><span className={`tag ${receipt.is_test ? "test" : "real"}`}>{receipt.is_test ? "Test" : "Real"}</span><span className={`pill ${receipt.outcome === "inquiry" ? "ok" : receipt.outcome === "needs_review" ? "warn" : "neutral"}`}>{receipt.outcome.replaceAll("_", " ")}</span></div></div>
    <div className="metadata"><span>{receipt.sender || "Sender not supplied"}</span><span>{new Date(receipt.received_at).toLocaleString()}</span><span>{receipt.event_type}</span></div>
    {receipt.reason && <p className="small muted">{receipt.reason}</p>}
    <div className="row" style={{ marginTop: 10 }}><button className="btn small" type="button" disabled={busy} aria-expanded={expanded} onClick={() => void read()}>{busy ? "Loading email..." : expanded ? "Hide original email" : "Read original email"}</button>
      {receipt.inquiry_id !== null && (inquiryVisible ? <a className="small" href={`#inquiry-${receipt.inquiry_id}`}>Open inquiry #{receipt.inquiry_id} ↓</a> : <span className="small muted">Linked inquiry #{receipt.inquiry_id}</span>)}
    </div>
    {error && <p className="form-message error" role="alert">{error}</p>}
    {expanded && original && <div className="section stack-sm">
      {original.message_id && <p className="small muted" style={{ overflowWrap: "anywhere" }}>Message {original.message_id}</p>}
      {original.text_body !== null && original.text_body !== undefined ? <><h3>Original plain-text body</h3><pre aria-label="Original plain-text body" style={bodyStyle}>{original.text_body}</pre></> : <p className="small muted">The provider did not supply a plain-text body.</p>}
      {original.html_body !== null && original.html_body !== undefined && <details><summary>Original HTML source, displayed as text</summary><pre aria-label="Original HTML source" style={bodyStyle}>{original.html_body}</pre></details>}
      {original.text_body == null && original.html_body == null && <p className="small muted">Review the message in AgentMail to obtain its original content.</p>}
    </div>}
  </article>;
}
