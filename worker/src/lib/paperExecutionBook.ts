import type { IntradayOHLC } from './paperIntradayData'
import { resolveAuthoritativeBuyExecutionSnapshot, type ExecutionBookObservation } from './authoritativeExecutionSnapshot'
import { normalizeFinLabL5Quote, type FinLabL5Quote } from './finlabL5MarketData'

/** The same observation and timing contract feeds pre-allocation L5 and final execution. */
export function shioajiBookObservation(book: IntradayOHLC): ExecutionBookObservation {
  return {
    source:'shioaji_hub',lotType:book.lotType??'board_lot',bid:book.bid??null,ask:book.ask??null,
    bidVolume:book.bidVolume,askVolume:book.askVolume,bidPrices:book.bidPrices,askPrices:book.askPrices,
    bidVolumes:book.bidVolumes,askVolumes:book.askVolumes,volumeUnit:book.volumeUnit,
    sourceTime:book.quoteTime,receivedAt:book.confirmationTime,ageMs:book.quoteAgeMs,
    sessionEpoch:book.sessionEpoch,streamHeartbeatAgeMs:book.streamHeartbeatAgeMs,
    confirmationMode:book.confirmationMode,timingReceipt:book.timingReceipt,
  }
}

export function validatedBookL5(symbol: string, book: IntradayOHLC | undefined, maxAgeMs: number): FinLabL5Quote | null {
  if (!book || book.source!=='shioaji') return null
  const snapshot=resolveAuthoritativeBuyExecutionSnapshot({
    limitPrice:book.ask??NaN,lotType:book.lotType??'board_lot',maxAgeMs,
    observations:[shioajiBookObservation(book)],
  })
  if(snapshot.status!=='ready')return null
  const quote=normalizeFinLabL5Quote(symbol,{
    provider:'shioaji_proxy_live_stream_book',lot_type:book.lotType??'board_lot',last_price:book.last,
    bid_prices:book.bidPrices,ask_prices:book.askPrices,bid_volumes:book.bidVolumes,ask_volumes:book.askVolumes,
    source_time:book.quoteTime,received_at:book.confirmationTime,
  })
  return quote ? {...quote,quoteAgeMs:snapshot.ageMs} : null
}
