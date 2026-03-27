export const COOKIE_NAME = 'sv_session'
export const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000
export const getLoginUrl = () => `${import.meta.env.VITE_API_URL ?? '/api'}/auth/google`
