import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useRegisterSW } from 'virtual:pwa-register/react'

export function usePWA() {
  const [installPrompt, setInstallPrompt] = useState<any>(null)
  const [isInstalled, setIsInstalled] = useState(false)

  // vite-plugin-pwa auto-update: shows toast when new SW is waiting
  useRegisterSW({
    onNeedRefresh() {
      toast('StockVision 有新版本', {
        description: '重新整理頁面以套用更新',
        action: { label: '立即更新', onClick: () => window.location.reload() },
        duration: 10000,
      })
    },
    onOfflineReady() {
      toast.success('StockVision 已可離線使用')
    },
  })

  useEffect(() => {
    // PWA install state
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true
    setIsInstalled(isStandalone)

    const handlePrompt = (e: Event) => {
      e.preventDefault()
      setInstallPrompt(e)
    }
    window.addEventListener('beforeinstallprompt', handlePrompt)
    window.addEventListener('appinstalled', () => {
      setIsInstalled(true)
      setInstallPrompt(null)
      toast.success('StockVision 已安裝到桌面！')
    })

    return () => window.removeEventListener('beforeinstallprompt', handlePrompt)
  }, [])

  const install = async () => {
    if (!installPrompt) return
    installPrompt.prompt()
    const { outcome } = await installPrompt.userChoice
    if (outcome === 'accepted') {
      setInstallPrompt(null)
      toast.success('正在安裝 StockVision…')
    }
  }

  return { isInstalled, canInstall: !!installPrompt, install }
}
