import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useRegisterSW } from 'virtual:pwa-register/react'

export function usePWA() {
  const [installPrompt, setInstallPrompt] = useState<any>(null)
  const [isInstalled, setIsInstalled] = useState(false)

  useRegisterSW({
    onNeedRefresh() {
      toast('StockVision 有新版本', {
        description: '重新整理後即可使用最新介面。',
        action: { label: '重新整理', onClick: () => window.location.reload() },
        duration: 10000,
      })
    },
    onOfflineReady() {
      toast.success('StockVision 已可離線開啟')
    },
  })

  useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true
    setIsInstalled(isStandalone)

    const handlePrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event)
    }

    const handleInstalled = () => {
      setIsInstalled(true)
      setInstallPrompt(null)
      toast.success('StockVision 已安裝')
    }

    window.addEventListener('beforeinstallprompt', handlePrompt)
    window.addEventListener('appinstalled', handleInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', handlePrompt)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [])

  const install = async () => {
    if (!installPrompt) return
    installPrompt.prompt()
    const { outcome } = await installPrompt.userChoice
    if (outcome === 'accepted') {
      setInstallPrompt(null)
      toast.success('已安裝 StockVision')
    }
  }

  return { isInstalled, canInstall: !isInstalled && !!installPrompt, install }
}
