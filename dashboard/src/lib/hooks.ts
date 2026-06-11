"use client";

import useSWR from "swr";
import { callTool, linkFetch } from "./api";

/** SWR over an MCP tool call; key includes args so filter changes refetch.
 * Pass an empty tool name to skip fetching (conditional usage). */
export function useTool<T>(tool: string, args: Record<string, unknown> = {}) {
  return useSWR<T>(
    tool ? [`tool:${tool}`, JSON.stringify(args)] : null,
    () => callTool<T>(tool, args),
    { revalidateOnFocus: false },
  );
}

export function useLinkStatus<T>() {
  return useSWR<T>("link:status", () => linkFetch<T>("status"), {
    revalidateOnFocus: false,
  });
}
