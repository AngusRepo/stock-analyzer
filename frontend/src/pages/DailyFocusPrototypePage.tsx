import AppShell from '@/components/AppShell'
import { ThemeFlowPanel } from '@/components/DailyRecommendationPanel'
import { DailyRecommendationPanelV2 } from '@/components/DailyRecommendationPanelV2'
import MarketRiskPanel from '@/components/MarketRiskPanel'
import {
  WorkstationPageTitle,
  WorkstationPanel,
} from '@/components/workstation/WorkstationChrome'

export default function DailyFocusPrototypePage() {
  return (
    <AppShell>
      <main className="h-full overflow-y-auto">
        <div className="w-full space-y-4 px-4 py-4">
          <WorkstationPageTitle
            kicker="paper trading"
            title="Daily Focus Preview"
          />

          <WorkstationPanel title="AI Focus" kicker="tradable lane + emerging research lane">
            <div className="p-3">
              <DailyRecommendationPanelV2 />
            </div>
          </WorkstationPanel>

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_390px]">
            <WorkstationPanel title="Market Risk" kicker="risk, flow, confidence">
              <div className="p-3">
                <MarketRiskPanel />
              </div>
            </WorkstationPanel>

            <ThemeFlowPanel />
          </div>
        </div>
      </main>
    </AppShell>
  )
}
