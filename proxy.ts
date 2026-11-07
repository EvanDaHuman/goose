import { NextResponse, type NextRequest } from "next/server";
import { isOperatorRequest, requireOperator } from "./lib/operatorAuth";

export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/ops/login") return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/ops")) return (await requireOperator(request)) ?? NextResponse.next();
  if (isOperatorRequest(request)) return NextResponse.next();
  const url = new URL("/ops/login", request.url);
  url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}
export const config = { matcher: ["/ops/:path*", "/api/ops/:path*"] };
