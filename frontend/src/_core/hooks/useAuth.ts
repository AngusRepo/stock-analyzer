import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { authApi, setToken, clearToken, getToken } from '@/lib/api'
import { useEffect } from 'react'

export function useAuth() {
  const qc = useQueryClient()

  // If auth code arrives in URL (after Google OAuth redirect), exchange for JWT
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1))
    const code = hash.get('code')
    if (code) {
      // 移除 hash，避免重複 exchange
      window.history.replaceState({}, '', window.location.pathname)
      authApi.exchange(code).then(({ token }) => {
        setToken(token)
        qc.invalidateQueries({ queryKey: ['auth', 'me'] })
      }).catch(() => {
        console.warn('[Auth] Code exchange failed')
      })
    }
  }, [])

  const meQuery = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => authApi.me(),
    enabled: !!getToken(),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })

  const logoutMutation = useMutation({
    mutationFn: () => authApi.logout(),
    onSettled: () => {
      clearToken()
      qc.setQueryData(['auth', 'me'], null)
      qc.clear()
    },
  })

  return {
    user: meQuery.data ?? null,
    loading: meQuery.isLoading,
    isAuthenticated: !!meQuery.data,
    error: meQuery.error,
    login: () => { window.location.href = authApi.loginUrl() },
    logout: () => logoutMutation.mutate(),
    refresh: () => meQuery.refetch(),
  }
}
