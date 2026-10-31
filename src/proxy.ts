import { NextResponse, type NextRequest } from "next/server";

/**
 * Cross-site request protection for the API. The app has no accounts, so any
 * page a user visits could otherwise make their browser POST to a locally
 * running instance (CSRF). State-changing requests must come from this origin
 * and must not use the content types an HTML form can send.
 * The scheduler endpoint is authenticated by its own secret header instead.
 */
const FORM_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];

export function checkApiRequest(method: string, path: string, headers: Headers): { status: 403 | 415; error: string } | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  const origin = headers.get("origin");
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (origin && origin !== "null") {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (!originHost || originHost !== host) return { status: 403, error: "Cross-site requests are not allowed." };
  } else if (origin === "null") {
    return { status: 403, error: "Cross-site requests are not allowed." };
  }
  if (path === "/api/monitoring/run") return null;
  const type = (headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (FORM_TYPES.includes(type)) return { status: 415, error: "Send JSON (content-type: application/json)." };
  return null;
}

export function proxy(request: NextRequest) {
  const problem = checkApiRequest(request.method, request.nextUrl.pathname, request.headers);
  if (problem) return NextResponse.json({ errors: [problem.error] }, { status: problem.status });
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
