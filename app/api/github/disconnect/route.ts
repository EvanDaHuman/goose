import { cookie, SESSION_COOKIE } from "@/lib/github";
import { assertSameOrigin } from "@/lib/operatorAuth";

// Forget the GitHub connection in this browser. (To revoke access entirely, the customer uninstalls the App on GitHub.)
export async function POST(req: Request) {
  const denied = assertSameOrigin(req); if (denied) return denied;
  return Response.json({ ok: true }, { headers: { "set-cookie": cookie(req, SESSION_COOKIE, "", 0) } });
}
