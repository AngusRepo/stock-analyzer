import { ShieldX, Clock, XCircle, ArrowLeft, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getLoginUrl } from "@/const";

type Reason = 'pending_approval' | 'rejected' | 'oauth_denied' | 'token_failed' |
              'invalid_state' | 'server_error' | string

function getContent(reason: Reason) {
  switch (reason) {
    case 'pending_approval':
      return {
        icon:    <Clock className="w-10 h-10 text-amber-500" />,
        iconBg:  'bg-amber-100 dark:bg-amber-950/40',
        title:   '申請審核中',
        desc:    '您的帳號已建立，正在等待管理員核准。\n核准後系統將自動寄送通知 Email 給您，屆時即可登入使用。',
        showLogin: false,
      }
    case 'rejected':
      return {
        icon:    <XCircle className="w-10 h-10 text-destructive" />,
        iconBg:  'bg-destructive/10',
        title:   '申請未通過',
        desc:    '您的使用申請未獲管理員核准。\n如有疑問，請聯繫系統管理員。',
        showLogin: false,
      }
    default:
      return {
        icon:    <ShieldX className="w-10 h-10 text-destructive" />,
        iconBg:  'bg-destructive/10',
        title:   '存取遭拒',
        desc:    '您的帳號未獲授權使用本系統。\n請確認您使用的是已獲授權的 Google 帳號。',
        showLogin: true,
      }
  }
}

export default function Unauthorized() {
  const reason = (new URLSearchParams(window.location.search).get('reason') ?? '') as Reason
  const { icon, iconBg, title, desc, showLogin } = getContent(reason)

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-6">
        <div className={`w-20 h-20 rounded-2xl flex items-center justify-center mx-auto ${iconBg}`}>
          {icon}
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-foreground">{title}</h1>
          <p className="text-muted-foreground text-sm leading-relaxed whitespace-pre-line">{desc}</p>
        </div>

        <div className="flex flex-col gap-3">
          {showLogin && (
            <Button onClick={() => window.location.href = getLoginUrl()} className="w-full gap-2">
              <LogIn className="w-4 h-4" />
              使用其他帳號登入
            </Button>
          )}
          <Button
            variant="ghost"
            className="w-full text-muted-foreground"
            onClick={() => window.location.href = '/'}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            返回首頁
          </Button>
        </div>
      </div>
    </div>
  )
}
