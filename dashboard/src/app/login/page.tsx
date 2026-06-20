import { signIn } from "@/auth";

export default function LoginPage() {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-6">
      <div className="w-full max-w-sm rounded-[var(--radius-lg)] border border-line bg-card p-8 text-center shadow-[var(--shadow-sm)]">
        <h1 className="text-lg font-semibold tracking-tight text-txt">Vault · Personal Finance</h1>
        <p className="mt-2 text-sm text-mut">Sign in to continue. Access is invitation-only.</p>
        <form
          action={async () => {
            "use server";
            await signIn("cognito", { redirectTo: "/" });
          }}
          className="mt-6"
        >
          <button className="w-full rounded-[var(--radius)] bg-accent px-4 py-2.5 text-sm font-semibold text-[var(--accent-contrast)] transition-[filter] hover:brightness-110">
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
