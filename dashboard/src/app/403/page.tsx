import Link from "next/link";

export default function Forbidden() {
  return (
    <div className="grid min-h-[60vh] place-items-center text-center">
      <div>
        <h1 className="text-lg font-semibold text-txt">No access</h1>
        <p className="mt-2 text-sm text-mut">Your account doesn’t have permission for this page.</p>
        <Link href="/" className="mt-4 inline-block text-sm text-accent">Back to start</Link>
      </div>
    </div>
  );
}
