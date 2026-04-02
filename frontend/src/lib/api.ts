const BASE = import.meta.env.VITE_API_URL ?? '/api'

// Fix: 使用 sessionStorage 而非 localStorage 儲存 JWT
// 原因：localStorage 跨 tab 持久化，XSS 腳本可讀取
// sessionStorage 僅存活於當前分頁生命週期，關閉分頁即清除，降低 XSS 竊取風險
// 注意：重新開啟分頁需要重新登入（30分鐘 idle timeout 較合理）
let _token: string | null = sessionStorage.getItem('sv_token')
export function setToken(t: string) { _token = t; sessionStorage.setItem('sv_token', t) }
export function clearToken() { _token = null; sessionStorage.removeItem('sv_token') }
export function getToken() { return _token }

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string,string> = { 'Content-Type': 'application/json' }
  if (_token) headers['Authorization'] = `Bearer ${_token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  if (res.status === 401) { clearToken(); throw new Error('Unauthorized') }
  if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })) as any; throw new Error(e.error ?? `HTTP ${res.status}`) }
  return res.json()
}
const get  = <T>(p: string)            => req<T>('GET',    p)
const post = <T>(p: string, b?: unknown) => req<T>('POST',   p, b)
const put  = <T>(p: string, b?: unknown) => req<T>('PUT',    p, b)
const del  = <T>(p: string)            => req<T>('DELETE', p)

export const authApi = {
  me: () => get<any>('/auth/me'),
  loginUrl: () => `${BASE}/auth/google`,
  logout: () => post<any>('/auth/logout'),
  exchange: (code: string) => post<{ token: string }>('/auth/exchange', { code }),
}
export const stocksApi = {
  list:        () => get<any[]>('/stocks'),
  get:         (id: number) => get<any>(`/stocks/${id}`),
  search:      (q: string, limit = 20) => get<any[]>(`/stocks/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  add:         (body: any) => post<any>('/stocks', body),
  remove:      (id: number) => del<any>(`/stocks/${id}`),
  refresh:     (id: number) => post<any>(`/stocks/${id}/refresh`),
  prices:      (id: number, days = 365) => get<any[]>(`/stocks/${id}/prices?days=${days}`),
  indicators:  (id: number, days = 365) => get<any[]>(`/stocks/${id}/indicators?days=${days}`),
  financials:  (id: number, limit = 12) => get<any[]>(`/stocks/${id}/financials?limit=${limit}`),
  chips:       (id: number, days = 60) => get<any[]>(`/stocks/${id}/chips?days=${days}`),
  news:        (id: number, days = 30) => get<any[]>(`/stocks/${id}/news?days=${days}`),
  predictions: (id: number) => get<any[]>(`/stocks/${id}/predictions`),
  factors:     (id: number) => get<any>(`/stocks/${id}/factors`),
  risk:        (id: number, period = '1y') => get<any>(`/stocks/${id}/risk?period=${period}`),
  valuations:  (id: number) => get<any>(`/stocks/${id}/valuations`),
  monthlyRevenue: (id: number, months = 12) => get<any[]>(`/stocks/${id}/monthly-revenue?months=${months}`),
  aiSummary:      (id: number) => get<any>(`/stocks/${id}/ai-summary`),
}
export const marketApi = {
  indices: () => get<any>('/market/indices'),
  risk:    () => get<any>('/market/risk'),
  riskHistory: (days = 30) => get<any>(`/market/risk/history?days=${days}`),
  exDividend: () => get<any[]>('/market/ex-dividend'),
  attentionStocks: () => get<any[]>('/market/attention-stocks'),
}
export const llmApi = {
  technicalAnalysis: (stockId: number) => post<any>('/llm/technical-analysis', { stockId }),
  tradingAdvice:     (stockId: number) => post<any>('/llm/trading-advice', { stockId }),
  analystSummary:    (stockId: number) => post<any>('/llm/analyst-summary', { stockId }),
  ask:               (stockId: number, question: string, history?: any[]) => post<any>('/llm/ask', { stockId, question, conversationHistory: history }),
}
export const watchlistApi = {
  list:   () => get<any[]>('/watchlist'),
  get:    (stockId: number) => get<any>(`/watchlist/${stockId}`),
  add:    (stockId: number) => post<any>(`/watchlist/${stockId}`, {}),
  remove: (stockId: number) => del<any>(`/watchlist/${stockId}`),
  upsert: (stockId: number, data: any) => put<any>(`/watchlist/${stockId}`, data),
}
export const alertsApi = {
  list:   () => get<any[]>('/alerts'),
  add:    (body: any) => post<any>('/alerts', body),
  remove: (id: number) => del<any>(`/alerts/${id}`),
}

export const newsApi = {
  crawl:     (stockId: number)             => post<any>(`/news/${stockId}/crawl`),
  sentiment: (stockId: number, days = 30)  => get<any>(`/news/${stockId}/sentiment?days=${days}`),
  trend:     (stockId: number, days = 30)  => get<any[]>(`/news/${stockId}/trend?days=${days}`),
  keywords:  (stockId: number, days = 30)  => get<any[]>(`/news/${stockId}/keywords?days=${days}`),
}

export const mlApi = {
  runPredict: (stockId: number) => post<any>(`/ml/predict/${stockId}`, {}),
  getPredict: (stockId: number) => get<any>(`/ml/predict/${stockId}`),
}

export const notificationsApi = {
  list:    () => get<any[]>('/notifications'),
  count:   () => get<{ count: number }>('/notifications/count'),
  readAll: () => post<any>('/notifications/read-all'),
}

export const systemApi = {
  status: () => get<any>('/system/status'),
}

export const accuracyApi = {
  // 某支股票各模型的真實準確率
  byStock: (stockId: number) => get<any[]>(`/ml/accuracy/${stockId}`),
  // 全局準確率統計（所有股票加總）
  global: () => get<any>('/ml/accuracy/global'),
}

export const tradeApi = {
  performance: (stockId: number) => get<any[]>(`/ml/trade-performance/${stockId}`),
  globalPerf:  () => get<any[]>('/ml/trade-performance/global'),
  history:     (stockId: number, limit = 50) => get<any[]>(`/ml/trade-history/${stockId}?limit=${limit}`),
}

export const chatApi = {
  // Fix: 移除 userId 參數，server 從 JWT 取
  getSessions: (stockId?: number) =>
    get<any[]>(`/chat/sessions${stockId ? `?stockId=${stockId}` : ''}`),
  getMessages:   (sessionId: number) =>
    get<any[]>(`/chat/sessions/${sessionId}/messages`),
  createSession: (stockId?: number, title?: string) =>
    post<any>('/chat/sessions', { stockId, title }),
  addMessage:    (sessionId: number, role: 'user' | 'assistant', content: string) =>
    post<any>(`/chat/sessions/${sessionId}/messages`, { role, content }),
  deleteSession: (sessionId: number) =>
    del<any>(`/chat/sessions/${sessionId}`),
}

export const recommendationsApi = {
  daily:       (date?: string) =>
    get<any>(`/recommendations/daily${date ? `?date=${date}` : ''}`),
  history:     (days = 7) =>
    get<any[]>(`/recommendations/history?days=${days}`),
  sectorFlow:  (date?: string, type?: 'industry' | 'theme') => {
    const params = new URLSearchParams()
    if (date) params.set('date', date)
    if (type) params.set('type', type)
    const qs = params.toString()
    return get<any>(`/recommendations/sector-flow${qs ? `?${qs}` : ''}`)
  },
  sectorFlowStocks: (date?: string, classification?: 'top' | 'dark_horse') => {
    const params = new URLSearchParams()
    if (date) params.set('date', date)
    if (classification) params.set('classification', classification)
    const qs = params.toString()
    return get<any>(`/recommendations/sector-flow-stocks${qs ? `?${qs}` : ''}`)
  },
  sectorTrend: (sector: string, days = 14, type?: 'industry' | 'theme') => {
    const params = new URLSearchParams({ sector, days: String(days) })
    if (type) params.set('type', type)
    return get<any>(`/recommendations/sector-trend?${params}`)
  },
  dailyReport: (date?: string) =>
    get<any>(`/recommendations/daily-report${date ? `?date=${date}` : ''}`),
}

export const backtestApi = {
  latest: () => get<any>('/backtest/latest'),
}

export const cronApi = {
  schedule: () => get<{ schedule: { task: string; tw_time: string; description: string }[] }>('/cron/schedule'),
}

export const paperApi = {
  account:         () => get<any>('/paper/account'),
  positions:       () => get<any>('/paper/positions'),
  orders:          (limit = 50) => get<any[]>(`/paper/orders?limit=${limit}`),
  pnl:             () => get<any>('/paper/pnl'),
  cronLogs:        (date?: string) => get<any>(`/admin/cron-logs${date ? `?date=${date}` : ''}`),
  quadrantFilter:  (date?: string) => get<any>(`/paper/quadrant-filter${date ? `?date=${date}` : ''}`),
  pendingBuys:     () => get<any>('/paper/pending-buys'),
}

export const adaptiveApi = {
  get:  () => get<any>('/admin/adaptive-params'),
  set:  (params: any) => post<any>('/admin/adaptive-params', params),
}

export const adminApi = {
  users:   () => get<any[]>('/auth/admin/users'),
  // approve/reject 現在走 POST，帶 approval token（從 email 連結取得）
  approveByToken: (token: string, action: 'approve' | 'reject') =>
    post<any>('/auth/admin/approve', { token, action }),
  // 後台直接操作（不需 token）
  setStatus: (userId: number, status: 'approved' | 'rejected') =>
    post<any>(`/auth/admin/users/${userId}/status`, { status }),
  setRole: (userId: number, role: 'user' | 'admin') =>
    post<any>(`/auth/admin/users/${userId}/role`, { role }),
}
