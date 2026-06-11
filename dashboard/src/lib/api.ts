export class ApiError extends Error {
  constructor(message: string, public service?: string, public status?: number) {
    super(message);
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, data.service, res.status);
  return data as T;
}

export async function callTool<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  return unwrap<T>(
    await fetch(`/api/mcp/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args }),
    }),
  );
}

export async function linkFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return unwrap<T>(await fetch(`/api/link/${path}`, init));
}
