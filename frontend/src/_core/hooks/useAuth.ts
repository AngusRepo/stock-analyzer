import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AUTH_TOKEN_EVENT, authApi, setToken, clearToken, getToken } from '@/lib/api'
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

  useEffect(() => {
    const onTokenChange = (event: Event) => {
      const authenticated = (event as CustomEvent<{ authenticated?: boolean }>).detail?.authenticated === true
      if (authenticated) {
        qc.invalidateQueries({ queryKey: ['auth', 'me'] })
        return
      }
      qc.setQueryData(['auth', 'me'], null)
      qc.removeQueries({ queryKey: ['auth', 'me'] })
    }

    window.addEventListener(AUTH_TOKEN_EVENT, onTokenChange)
    return () => window.removeEventListener(AUTH_TOKEN_EVENT, onTokenChange)
  }, [qc])

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
    isAuthenticated: !!getToken() && !!meQuery.data,
    error: meQuery.error,
    login: () => { window.location.href = authApi.loginUrl() },
    logout: () => logoutMutation.mutate(),
    refresh: () => meQuery.refetch(),
  }
}
