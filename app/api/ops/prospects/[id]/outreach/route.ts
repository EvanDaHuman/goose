import { fail, json, wrap } from "@/lib/http";
import { cancelOutreach, queueOutreach, reconcileOutreach, resolveContact, sendOutreach } from "@/lib/outreach";

// Operator actions on one prospect's outreach:
//   {action:"contact"}                        look up a published contact address
//   {action:"queue", test?:boolean}           compose and store the exact email (test copies go to OUTREACH_TEST_RECIPIENT)
//   {action:"test"}                           compose a test copy and send it to OUTREACH_TEST_RECIPIENT only
//   {action:"send", messageId, authorization} send that exact stored message ("Send this exact message")
//   {action:"cancel"|"reconcile", messageId, outcome?}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return wrap(async () => {
    const id = Number((await params).id);
    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "contact": return json(await resolveContact(id));
      case "queue": return json(await queueOutreach(id, { test: body.test === true }));
      case "test": { const m = await queueOutreach(id, { test: true }); return json(await sendOutreach(m.id, "Send this exact message")); }
      case "send": return json(await sendOutreach(Number(body.messageId), body.authorization));
      case "cancel": return json(await cancelOutreach(Number(body.messageId)));
      case "reconcile": return json(await reconcileOutreach(Number(body.messageId), body.outcome === "sent" ? "sent" : "not_sent"));
      default: return fail("unknown action");
    }
  });
}
