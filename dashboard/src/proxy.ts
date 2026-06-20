// Next.js 16 middleware (renamed to proxy.ts). Runs on the edge.
// Layer 1 of defense in depth: redirect unauthenticated users to /login, and
// redirect authenticated-but-unauthorized PAGE access to their first allowed
// page (or /403). API routes self-enforce (layer 2) and are left to pass.
import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "./auth.config";
import { permissionsForRoles, canAccessPage, allowedPages } from "@/lib/rbac";

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Always let Auth.js endpoints and the public pages through.
  if (pathname.startsWith("/api/auth") || pathname === "/login" || pathname === "/403") {
    return;
  }

  // API routes self-enforce (layer 2): they return JSON 401/403 themselves.
  // Pass them through so we never redirect an API call to the HTML login page.
  if (pathname.startsWith("/api")) return;

  if (!req.auth) {
    const url = new URL("/login", req.nextUrl.origin);
    url.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  const perms = permissionsForRoles(req.auth.user?.roles ?? []);
  if (!canAccessPage(perms, pathname)) {
    const home = allowedPages(perms)[0];
    return NextResponse.redirect(new URL(home ?? "/403", req.nextUrl.origin));
  }
});

export const config = {
  // Run on everything except static assets and the image optimizer.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
