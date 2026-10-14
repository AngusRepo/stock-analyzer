export interface PortfolioDeRiskHolding {
  symbol: string
  shares: number
  price: number
  weakness: number
}

export interface PortfolioDeRiskPlan {
  required: boolean
  currentExposure: number
  targetExposure: number
  currentPositionsValue: number
  targetPositionsValue: number
  projectedPositionsValue: number
  fullExitSymbols: string[]
  reductions: Record<string, number>
}

function finiteNonNegative(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function buildPortfolioDeRiskPlan(params: {
  totalPortfolio: number
  targetExposure: number
  holdings: PortfolioDeRiskHolding[]
}): PortfolioDeRiskPlan {
  const totalPortfolio = finiteNonNegative(params.totalPortfolio)
  const targetExposure = Math.max(0, Math.min(1, Number(params.targetExposure) || 0))
  const holdings = params.holdings
    .map((holding) => ({
      ...holding,
      shares: Math.max(0, Math.floor(finiteNonNegative(holding.shares))),
      price: finiteNonNegative(holding.price),
      weakness: Number.isFinite(Number(holding.weakness)) ? Number(holding.weakness) : 0,
    }))
    .filter((holding) => holding.shares > 0 && holding.price > 0)
  const currentPositionsValue = holdings.reduce((sum, holding) => sum + holding.shares * holding.price, 0)
  const targetPositionsValue = totalPortfolio * targetExposure
  let projectedPositionsValue = currentPositionsValue
  const fullExitSymbols: string[] = []
  const reductions: Record<string, number> = {}

  if (totalPortfolio > 0 && currentPositionsValue > targetPositionsValue) {
    const weakestFirst = [...holdings].sort((a, b) => (
      b.weakness - a.weakness || a.symbol.localeCompare(b.symbol)
    ))
    for (const holding of weakestFirst) {
      if (projectedPositionsValue <= targetPositionsValue) break
      // Odd lots are legal. Sell only the excess, rounded up by one share.
      const shares = Math.min(holding.shares, Math.ceil((projectedPositionsValue-targetPositionsValue)/holding.price))
      projectedPositionsValue -= shares * holding.price
      reductions[holding.symbol] = shares
      if (shares === holding.shares) fullExitSymbols.push(holding.symbol)
    }
  }

  return {
    required: Object.keys(reductions).length > 0,
    currentExposure: totalPortfolio > 0 ? currentPositionsValue / totalPortfolio : 0,
    targetExposure,
    currentPositionsValue,
    targetPositionsValue,
    projectedPositionsValue: Math.max(0, projectedPositionsValue),
    fullExitSymbols,
    reductions,
  }
}
