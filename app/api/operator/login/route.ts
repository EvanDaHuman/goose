import { NextResponse } from "next/server";
import { assertSameOrigin, OPERATOR_COOKIE, operatorSession, validOperatorToken } from "../../../../lib/operatorAuth";

export async function POST(request: Request) {
  const denied = assertSameOrigin(request);
  if (denied) return denied;
  let token = "";
  try { token = String((await request.json()).token ?? ""); } catch { return Response.json({error:"Invalid request"},{status:400}); }
  if (!validOperatorToken(token)) return Response.json({ error: "The operator key was not accepted" }, { status: 401 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(OPERATOR_COOKIE, operatorSession(), { httpOnly: true, sameSite: "strict", secure: new URL(request.url).protocol === "https:", path: "/", maxAge: 12 * 60 * 60 });
  return response;
}
export async function DELETE(request: Request) {
  const denied = assertSameOrigin(request);
  if (denied) return denied;
  const response = NextResponse.json({ ok: true });
  response.cookies.set(OPERATOR_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
