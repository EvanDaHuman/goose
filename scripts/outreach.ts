// Prospect outreach from the command line.
//   npm run outreach                       status: configuration, pipeline, recent messages
//   npm run outreach -- contacts           look up published contact emails for every drafted prospect
//   npm run outreach -- preview <id>       compose the exact email for prospect <id> and print it (nothing is sent)
//   npm run outreach -- test <id>          send a TEST copy of prospect <id>'s email to OUTREACH_TEST_RECIPIENT only
//   npm run outreach -- send <id> --yes    send prospect <id>'s email to the prospect (authorizes this exact message)
//   npm run outreach -- replies            poll AgentMail for replies to sent outreach
//   npm run outreach -- policy on <cap> [High|Medium] | policy off
import { pool, q } from "../lib/db";
import { cancelOutreach, outreachDashboard, outreachStatus, pollReplies, POLICY_PHRASE, queueOutreach, resolveContact, sendOutreach, setOutreachPolicy } from "../lib/outreach";

const [cmd = "status", arg, ...rest] = process.argv.slice(2);
const id = () => { const n = Number(arg); if (!Number.isInteger(n) || n < 1) throw new Error("Give a prospect id"); return n; };
const show = (m: any) => console.log(`\n--- outreach message #${m.id} (${m.is_test ? "TEST" : "real"}, ${m.status}) ---\nTo: ${m.delivered_to}${m.is_test ? `   (real recipient would be ${m.recipient})` : ""}\nSubject: ${m.subject}\n\n${m.body}\n---`);

try {
  if (cmd === "status") {
    const d = await outreachDashboard();
    console.log("Outreach:", JSON.stringify({ ...d.status, policy: d.policy, sentToday: d.sentToday }, null, 2));
    const ps = await q<any>("SELECT id,name,fit_score,status,contact_email,contact_kind,contact_checked_at IS NOT NULL AS checked,outreach_draft IS NOT NULL AS drafted FROM prospects ORDER BY id");
    console.table(ps.map((p) => ({ id: p.id, name: p.name.slice(0, 40), fit: p.fit_score, status: p.status, drafted: p.drafted, contact: p.contact_email ?? (p.checked ? "(none found)" : "(not checked)"), kind: p.contact_kind ?? "" })));
    if (d.messages.length) console.table(d.messages.slice(0, 15).map((m: any) => ({ id: m.id, prospect: m.prospect_name.slice(0, 30), to: m.delivered_to, test: m.is_test, status: m.status, replied: !!m.replied_at, error: m.error ?? "" })));
  } else if (cmd === "contacts") {
    const ps = await q<any>(arg ? "SELECT id,name FROM prospects WHERE id=$1" : "SELECT id,name FROM prospects WHERE outreach_draft IS NOT NULL ORDER BY id", arg ? [id()] : []);
    for (const p of ps) { const r = await resolveContact(p.id); console.log(`${p.id} ${p.name}: ${r.email ? `${r.email} (${r.kind}, ${r.source})` : r.note}`); }
  } else if (cmd === "preview") {
    const m = await queueOutreach(id(), { test: !outreachStatus().canSendReal });
    show(m);
    if (m.is_test) { await cancelOutreach(m.id); console.log(`Real sending is not configured yet: ${outreachStatus().realBlockers.join("; ")}`); }
  } else if (cmd === "test") {
    const m = await queueOutreach(id(), { test: true }); show(m);
    const r = await sendOutreach(m.id, "Send this exact message"); console.log(`Sent TEST copy via AgentMail: ${r.messageId}`);
  } else if (cmd === "send") {
    const m = await queueOutreach(id()); show(m);
    if (!rest.includes("--yes")) console.log("\nNot sent. Re-run with --yes to authorize and send this exact message to the prospect.");
    else { const r = await sendOutreach(m.id, "Send this exact message"); console.log(`Sent via AgentMail: ${r.messageId} (thread ${r.threadId})`); }
  } else if (cmd === "replies") {
    console.log(await pollReplies());
  } else if (cmd === "policy") {
    const on = arg === "on";
    console.log(await setOutreachPolicy({ enabled: on, dailyCap: Number(rest[0] ?? 5), minFit: rest[1], authorization: on ? POLICY_PHRASE : undefined }));
  } else throw new Error(`Unknown command ${cmd}`);
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
finally { await pool.end(); }
