"use client";
import { useState } from "react";

export default function OperatorLogin() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <main className="wrap" style={{maxWidth:520,paddingTop:80}}><p className="eyebrow">Goose operations</p><h1>Sign in to your company.</h1>
    <p className="muted">Use the operator key configured for this installation. Customer workspaces use their own private links.</p>
    <form onSubmit={async event => {event.preventDefault();setBusy(true);setError("");try{
      const response=await fetch("/api/operator/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token})});
      const result=await response.json();if(!response.ok)throw new Error(result.error);
      const next=new URLSearchParams(location.search).get("next");location.href=next?.startsWith("/ops")&&!next.startsWith("//")?next:"/ops";
    }catch(e){setError(e instanceof Error?e.message:"Sign in failed");setBusy(false);}}}>
      <label>Operator key<input type="password" autoComplete="current-password" value={token} onChange={e=>setToken(e.target.value)} required /></label>
      {error&&<p role="alert">{error}</p>}<button className="button" disabled={busy}>{busy?"Signing in…":"Sign in"}</button>
    </form></main>;
}
