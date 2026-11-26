type AuthUser = {
  role?: string | null
  is_primary_admin?: boolean | null
}

// /auth/me computes is_primary_admin from the Worker's ADMIN_EMAIL secret; the address stays out of the bundle.
export function isPrimaryAdminUser(user: AuthUser | null | undefined): boolean {
  if (!user || user.role !== 'admin') return false
  return user.is_primary_admin === true
}
