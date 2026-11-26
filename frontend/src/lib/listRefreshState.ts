/**
 * 清單區塊的讀取狀態。刷新失敗但手上有上次的資料時，不論清單有沒有內容都要看得到「更新失敗」與重試；
 * 否則上次剛好是空清單時，畫面只剩「沒有資料」，看不出其實是讀不到。
 */
export type ListRefreshState = 'loading' | 'error' | 'empty' | 'empty-stale' | 'list' | 'list-stale'

export function listRefreshState(input: { isLoading: boolean; isError: boolean; hasData: boolean; count: number }): ListRefreshState {
  if (input.isLoading && !input.hasData) return 'loading'
  if (input.isError && !input.hasData) return 'error'
  if (input.count <= 0) return input.isError ? 'empty-stale' : 'empty'
  return input.isError ? 'list-stale' : 'list'
}
