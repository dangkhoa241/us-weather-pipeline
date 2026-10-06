// TanStack Query wrappers for the forecast replay. One cache entry per city + day that never goes stale and is never
// retried or refetched, so a city + day costs at most one Previous Runs request and one archive request per page load.
import { useQuery } from "@tanstack/react-query";
import { fetchReplay, loadReplaySample } from "@/lib/replay";

export function useReplay(city: string, day: string, now: number) {
  return useQuery({
    queryKey: ["replay", city, day],
    // TanStack's abort signal is not passed on purpose: closing the panel mid-request must not cancel it and make
    // the next open send it again.
    queryFn: () => fetchReplay(city, day, { now }),
    enabled: Boolean(city && day),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** The bundled sample, loaded only when a live replay fails. */
export function useReplaySample(enabled: boolean) {
  return useQuery({ queryKey: ["replay-sample"], queryFn: () => loadReplaySample(), enabled, staleTime: Infinity, gcTime: Infinity, retry: false });
}
