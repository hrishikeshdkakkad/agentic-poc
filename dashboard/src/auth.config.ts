import type { NextAuthConfig } from "next-auth";
import Cognito from "next-auth/providers/cognito";

// Edge-safe: imported by both proxy.ts (middleware) and auth.ts.
// Stores ONLY cognito groups as `roles`; permissions are computed from the
// rbac config at each check so map changes don't require re-login.
export const authConfig: NextAuthConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Cognito({
      clientId: process.env.AUTH_COGNITO_ID,
      clientSecret: process.env.AUTH_COGNITO_SECRET,
      issuer: process.env.AUTH_COGNITO_ISSUER,
    }),
  ],
  callbacks: {
    jwt({ token, profile }) {
      if (profile) {
        const groups = profile["cognito:groups"];
        token.roles = Array.isArray(groups) ? (groups as string[]) : [];
      }
      return token;
    },
    session({ session, token }) {
      session.user.roles = (token.roles as string[]) ?? [];
      return session;
    },
  },
};
