import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'
import { signJWT, verifyJWT, revokeJWT, authMiddleware, adminMiddleware } from '../lib/auth'

const auth = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const SCOPES  = 'openid email profile'
const JWT_EXP = 60 * 60 * 24 * 7  // 7 天（原本 30 天風險過高）

// ─── HTML escape（防止 Google name 觸發 Email HTML injection）────────────────
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ─── Email 通知（Resend API）─────────────────────────────────────────────────
async function sendApprovalRequestEmail(
  resendKey: string,
  adminEmail: string,
  applicantName: string,
  applicantEmail: string,
  approvalToken: string,           // 一次性 token，取代直接 approve/reject
  workerOrigin: string,
): Promise<void> {
  // 核准/拒絕改走前端確認頁，帶 token 參數，避免爬蟲預覽誤觸發
  const approveUrl = `${workerOrigin}/#/admin/approve?token=${approvalToken}&action=approve`
  const rejectUrl  = `${workerOrigin}/#/admin/approve?token=${approvalToken}&action=reject`
  const safeName   = escapeHtml(applicantName)
  const safeEmail  = escapeHtml(applicantEmail)

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from:    'StockVision <noreply@stockvision.app>',
      to:      [adminEmail],
      subject: `[StockVision] 新用戶申請審核：${safeName}`,
      html: `
        <h2>新用戶申請使用 StockVision</h2>
        <table style="border-collapse:collapse;width:400px">
          <tr><td style="padding:8px;border:1px solid #ddd"><b>姓名</b></td>
              <td style="padding:8px;border:1px solid #ddd">${safeName}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><b>Email</b></td>
              <td style="padding:8px;border:1px solid #ddd">${safeEmail}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><b>申請時間</b></td>
              <td style="padding:8px;border:1px solid #ddd">
                ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}
              </td></tr>
        </table>
        <br/>
        <p style="color:#6b7280;font-size:13px">點擊下方按鈕，系統會先顯示確認頁再執行操作：</p>
        <a href="${approveUrl}" style="background:#16a34a;color:#fff;padding:10px 24px;
           text-decoration:none;border-radius:6px;margin-right:12px">✅ 核准</a>
        <a href="${rejectUrl}"  style="background:#dc2626;color:#fff;padding:10px 24px;
           text-decoration:none;border-radius:6px">❌ 拒絕</a>
        <br/><br/>
        <small style="color:#6b7280">
          Token 有效期 48 小時。或至後台手動處理：${escapeHtml(workerOrigin)}/api/auth/admin/users
        </small>
      `,
    }),
    signal: AbortSignal.timeout(8_000),
  }).catch(e => console.warn('[Auth] Email send failed:', e))
}

async function sendApprovalResultEmail(
  resendKey: string,
  toEmail: string,
  toName: string,
  approved: boolean,
): Promise<void> {
  const safeName = escapeHtml(toName)
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from:    'StockVision <noreply@stockvision.app>',
      to:      [toEmail],
      subject: approved ? '[StockVision] 您的帳號已核准' : '[StockVision] 帳號申請未通過',
      html: approved
        ? `<h2>歡迎使用 StockVision，${safeName}！</h2>
           <p>您的帳號已通過審核，現在可以登入使用所有功能。</p>`
        : `<h2>您好，${safeName}</h2>
           <p>很抱歉，您的 StockVision 使用申請未獲核准。如有疑問請聯繫管理員。</p>`,
    }),
    signal: AbortSignal.timeout(8_000),
  }).catch(e => console.warn('[Auth] Result email failed:', e))
}

// ─── GET /api/auth/google ─────────────────────────────────────────────────────
auth.get('/google', async (c) => {
  const state = crypto.randomUUID()
  await c.env.KV.put(`oauth:state:${state}`, '1', { expirationTtl: 300 })

  const params = new URLSearchParams({
    client_id:     c.env.GOOGLE_CLIENT_ID,
    redirect_uri:  `${new URL(c.req.url).origin}/api/auth/callback`,
    response_type: 'code',
    scope:         SCOPES,
    state,
    access_type:   'online',
    prompt:        'select_account',
  })
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
})

// ─── GET /api/auth/callback ───────────────────────────────────────────────────
auth.get('/callback', async (c) => {
  const code  = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  if (error || !code) return c.redirect(`${c.env.PAGES_ORIGIN || ''}/unauthorized?reason=oauth_denied`)
  if (!state)         return c.redirect(`${c.env.PAGES_ORIGIN || ''}/unauthorized?reason=missing_state`)

  const stateValid = await c.env.KV.get(`oauth:state:${state}`)
  if (!stateValid) return c.redirect(`${c.env.PAGES_ORIGIN || ''}/unauthorized?reason=invalid_state`)
  await c.env.KV.delete(`oauth:state:${state}`)

  try {
    // 1. Exchange code
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     c.env.GOOGLE_CLIENT_ID,
        client_secret: c.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  `${new URL(c.req.url).origin}/api/auth/callback`,
        grant_type:    'authorization_code',
      }),
    })
    if (!tokenRes.ok) {
      console.error('[OAuth] Token exchange failed')
      return c.redirect(`${c.env.PAGES_ORIGIN || ''}/unauthorized?reason=token_failed`)
    }

    const tokens = await tokenRes.json() as any

    // 2. Get user info
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (!userRes.ok) return c.redirect(`${c.env.PAGES_ORIGIN || ''}/unauthorized?reason=userinfo_failed`)

    const googleUser = await userRes.json() as {
      id: string; email: string; name: string; picture: string
    }

    // 3. Upsert user
    const existing = await c.env.DB.prepare(
      'SELECT id, role, approval_status FROM users WHERE google_id = ?'
    ).bind(googleUser.id).first<{ id: number; role: string; approval_status: string }>()

    let userId: number
    let userRole: string
    let approvalStatus: string

    if (existing) {
      userId         = existing.id
      userRole       = existing.role
      approvalStatus = existing.approval_status
      await c.env.DB.prepare(
        `UPDATE users SET name=?, avatar=?, last_login=datetime('now') WHERE id=?`
      ).bind(googleUser.name, googleUser.picture, userId).run()
    } else {
      // ── Bootstrap 邏輯：ADMIN_EMAIL 環境變數控制第一個 admin ──────────────
      // 不用硬編碼：ADMIN_EMAIL 是 wrangler secret，不存在 source code 裡
      const adminEmail = c.env.ADMIN_EMAIL?.trim().toLowerCase()
      const isBootstrapAdmin = adminEmail && googleUser.email.toLowerCase() === adminEmail

      if (isBootstrapAdmin) {
        userRole       = 'admin'
        approvalStatus = 'approved'
      } else {
        // 檢查是否為 DB 裡已有 admin 指定（未來可讓 admin 邀請）
        userRole       = 'user'
        approvalStatus = 'pending'
      }

      const result = await c.env.DB.prepare(
        `INSERT INTO users (google_id, email, name, avatar, role, approval_status)
         VALUES (?,?,?,?,?,?) RETURNING id`
      ).bind(googleUser.id, googleUser.email, googleUser.name, googleUser.picture,
             userRole, approvalStatus)
       .first<{ id: number }>()

      if (!result) return c.redirect(`${c.env.PAGES_ORIGIN || ''}/unauthorized?reason=db_error`)
      userId = result.id

      // 新的非 admin 用戶 → 寄審核通知，帶一次性 token（POST 驗證用）
      if (approvalStatus === 'pending' && c.env.RESEND_API_KEY) {
        const origin         = new URL(c.req.url).origin
        const notifyAdmin    = adminEmail || ''
        if (notifyAdmin) {
          // 產生 approval token，存 KV 48 小時
          const approvalToken = crypto.randomUUID()
          await c.env.KV.put(
            `approval:token:${approvalToken}`,
            JSON.stringify({ userId, action: 'pending' }),
            { expirationTtl: 48 * 3600 },
          )
          c.executionCtx.waitUntil(
            sendApprovalRequestEmail(
              c.env.RESEND_API_KEY, notifyAdmin,
              googleUser.name, googleUser.email, approvalToken, origin,
            )
          )
        }
      }
    }

    if (approvalStatus === 'pending')  return c.redirect(`${c.env.PAGES_ORIGIN || ''}/unauthorized?reason=pending_approval`)
    if (approvalStatus === 'rejected') return c.redirect(`${c.env.PAGES_ORIGIN || ''}/unauthorized?reason=rejected`)

    // 4. Sign JWT
    const token = await signJWT({
      sub:   userId,
      email: googleUser.email,
      name:  googleUser.name,
      role:  userRole,
      exp:   Math.floor(Date.now() / 1000) + JWT_EXP,
    }, c.env.JWT_SECRET)

    // 5. Auth Code Exchange（避免 JWT 直接出現在 URL / 瀏覽器歷史記錄）
    //    前端讀到 code 後，打 POST /api/auth/exchange 換 JWT，code 用後即刪
    const authCode = crypto.randomUUID()
    await c.env.KV.put(`auth:code:${authCode}`, token, { expirationTtl: 60 })
    const frontendOrigin = c.env.PAGES_ORIGIN || new URL(c.req.url).origin
    return c.redirect(`${frontendOrigin}/#code=${authCode}`)
  } catch (e) {
    console.error('[OAuth] Callback error:', e)
    return c.redirect(`${c.env.PAGES_ORIGIN || ''}/unauthorized?reason=server_error`)
  }
})

// ─── POST /api/auth/exchange  →  code → JWT（一次性，60 秒有效）────────────────
auth.post('/exchange', async (c) => {
  const { code } = await c.req.json().catch(() => ({ code: null }))
  if (!code || typeof code !== 'string') return c.json({ error: '無效 code' }, 400)

  const token = await c.env.KV.get(`auth:code:${code}`)
  if (!token) return c.json({ error: 'Code 無效或已過期' }, 410)

  // 用後即刪，確保 one-time use
  await c.env.KV.delete(`auth:code:${code}`)
  return c.json({ token })
})

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
auth.get('/me', authMiddleware, async (c) => {
  const user = await c.env.DB.prepare(
    'SELECT id, email, name, avatar, role, approval_status, created_at FROM users WHERE id = ?'
  ).bind(c.get('userId')).first()
  if (!user) return c.json({ error: '使用者不存在' }, 404)
  return c.json(user)
})

// ─── POST /api/auth/logout — 撤銷 JWT（加入 KV blacklist）─────────────────────
auth.post('/logout', async (c) => {
  const authHeader = c.req.header('Authorization')
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (token) {
    const payload = await verifyJWT(token, c.env.JWT_SECRET)
    if (payload) await revokeJWT(payload, c.env.KV)
  }
  return c.json({ success: true })
})

// ══════════════════════════════════════════════════════════════════════════════
// 管理員專用路由（authMiddleware + adminMiddleware）
// ══════════════════════════════════════════════════════════════════════════════

auth.get('/admin/users', authMiddleware, adminMiddleware, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, email, name, avatar, role, approval_status, created_at, last_login
     FROM users
     ORDER BY CASE approval_status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
              created_at DESC`
  ).all()
  return c.json(results ?? [])
})

// ── POST（不再是 GET）：approve/reject 需要帶 approval token ──────────────────
// email 中的連結 → 前端確認頁 → 前端送 POST，防止爬蟲誤觸發
auth.post('/admin/approve', authMiddleware, adminMiddleware, async (c) => {
  const { token: approvalToken, action } = await c.req.json()
  if (!approvalToken || !['approve', 'reject'].includes(action)) {
    return c.json({ error: '無效參數' }, 400)
  }

  // 驗證一次性 token
  const raw = await c.env.KV.get(`approval:token:${approvalToken}`)
  if (!raw) return c.json({ error: 'Token 無效或已過期' }, 410)

  const { userId } = JSON.parse(raw) as { userId: number }
  await c.env.KV.delete(`approval:token:${approvalToken}`)  // 用後即刪

  const user = await c.env.DB.prepare(
    'SELECT id, email, name, approval_status FROM users WHERE id=?'
  ).bind(userId).first<{ id: number; email: string; name: string; approval_status: string }>()

  if (!user) return c.json({ error: '用戶不存在' }, 404)
  if (user.approval_status !== 'pending') {
    return c.json({ message: `用戶已是 ${user.approval_status} 狀態` })
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected'
  await c.env.DB.prepare(
    'UPDATE users SET approval_status=? WHERE id=?'
  ).bind(newStatus, userId).run()

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil(
      sendApprovalResultEmail(c.env.RESEND_API_KEY, user.email, user.name, action === 'approve')
    )
  }

  return c.json({ success: true, message: `已${action === 'approve' ? '核准' : '拒絕'} ${user.email}` })
})

// ── 直接 approve/reject by userId（後台操作用，不需 token）────────────────────
auth.post('/admin/users/:userId/status', authMiddleware, adminMiddleware, async (c) => {
  const targetId = parseInt(c.req.param('userId') ?? '', 10)
  if (!targetId || isNaN(targetId)) return c.json({ error: '無效 ID' }, 400)

  const { status } = await c.req.json()
  if (!['approved', 'rejected'].includes(status)) return c.json({ error: '無效 status' }, 400)

  const user = await c.env.DB.prepare(
    'SELECT id, email, name FROM users WHERE id=?'
  ).bind(targetId).first<{ id: number; email: string; name: string }>()
  if (!user) return c.json({ error: '用戶不存在' }, 404)

  await c.env.DB.prepare(
    'UPDATE users SET approval_status=? WHERE id=?'
  ).bind(status, targetId).run()

  if (c.env.RESEND_API_KEY) {
    c.executionCtx.waitUntil(
      sendApprovalResultEmail(c.env.RESEND_API_KEY, user.email, user.name, status === 'approved')
    )
  }

  return c.json({ success: true })
})

auth.post('/admin/users/:userId/role', authMiddleware, adminMiddleware, async (c) => {
  const targetId = parseInt(c.req.param('userId') ?? '', 10)
  if (!targetId || isNaN(targetId)) return c.json({ error: '無效 ID' }, 400)

  const { role } = await c.req.json()
  if (!['user', 'admin'].includes(role)) return c.json({ error: '無效 role' }, 400)

  // 不允許降級自己（避免系統沒有 admin）
  if (targetId === c.get('userId') && role === 'user') {
    return c.json({ error: '不能降級自己的 admin 權限' }, 403)
  }

  await c.env.DB.prepare('UPDATE users SET role=? WHERE id=?').bind(role, targetId).run()
  return c.json({ success: true })
})

export { auth }
