export const PRIMARY_ADMIN_EMAIL = 'wayne60619@gmail.com'

type AuthUser = {
  email?: string | null
  role?: string | null
  is_primary_admin?: boolean | null
}

export function isPrimaryAdminUser(user: AuthUser | null | undefined): boolean {
  if (!user || user.role !== 'admin') return false
  const email = String(user.email ?? '').trim().toLowerCase()
  return user.is_primary_admin === true || email === PRIMARY_ADMIN_EMAIL
}
