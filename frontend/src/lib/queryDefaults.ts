export const defaultQueryOptions = {
  queries: {
    retry: 1,
    staleTime: 2 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    structuralSharing: true,
  },
}
