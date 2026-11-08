import { json, wrap } from "@/lib/http";
import { outreachDashboard, pollReplies, setOutreachPolicy } from "@/lib/outreach";

export async function GET() { return wrap(async () => json(await outreachDashboard())); }

// {policy:{enabled,dailyCap,minFit,authorization}} or {pollReplies:true}
export async function POST(req: Request) {
  return wrap(async () => {
    const body = await req.json().catch(() => ({}));
    if (body.pollReplies) return json(await pollReplies());
    return json(await setOutreachPolicy(body.policy ?? {}));
  });
}
