import { apiBase, apiGet, apiPost } from './apiClient'

export { AUTH_TOKEN_EVENT, clearToken, getToken, setToken } from './apiClient'

export const authApi = {
  me: () => apiGet<any>('/auth/me'),
  loginUrl: () => `${apiBase}/auth/google`,
  logout: () => apiPost<any>('/auth/logout'),
  exchange: (code: string) => apiPost<{ token: string }>('/auth/exchange', { code }),
}
