import "next-auth";
import "next-auth/jwt";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: { roles: string[] } & DefaultSession["user"];
  }
}
declare module "next-auth/jwt" {
  interface JWT {
    roles?: string[];
  }
}
