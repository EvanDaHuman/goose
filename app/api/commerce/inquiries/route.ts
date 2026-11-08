import { createInquiry } from "@/lib/commerce";
import { json, wrap, fail } from "@/lib/http";
import { assertSameOrigin } from "@/lib/operatorAuth";
export async function POST(req: Request) {
  const denied = assertSameOrigin(req); if (denied) return denied;
  return wrap(async () => {
    const raw = await req.text();
    if (Buffer.byteLength(raw) > 20_000) return fail("Inquiry is too large", 413);
    return json(await createInquiry(JSON.parse(raw)), 201);
  });
}
