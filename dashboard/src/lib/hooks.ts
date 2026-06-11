"use client";

import useSWR from "swr";
import { callTool, linkFetch } from "./api";

/** SWR over an MCP tool call; key includes args so filter changes refetch. */
export function useTool<T>(tool: string, args: Record<string, unknown> = {}) {
  return useSWR<T>([`tool:${tool}`, JSON.stringify(args)], () => callTool<T>(tool, args), {
    revalidateOnFocus: false,
  });
}

export function useLinkStatus<T>() {
  return useSWR<T>("link:status", () => linkFetch<T>("status"), {
    revalidateOnFocus: false,
  });
}
