import { useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { stocksApi } from '@/lib/api'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Search } from 'lucide-react'

export interface StockSelection { id: number; symbol: string; name: string; market: string }

interface Props { onSelect: (s: StockSelection) => void }

export default function StockSearchCombobox({ onSelect }: Props) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  const { data: results = [] } = useQuery({
    queryKey: ['stocks', 'search', q],
    queryFn: () => stocksApi.search(q, 20),
    enabled: q.length >= 1,
    staleTime: 30000,
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-start text-muted-foreground gap-2">
          <Search className="w-4 h-4" /> 搜尋股票代號或名稱…
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="輸入代號或名稱…" value={q} onValueChange={setQ} />
          <CommandList>
            <CommandEmpty>{q.length < 1 ? '請輸入關鍵字' : '查無結果'}</CommandEmpty>
            <CommandGroup>
              {results.map((s: any) => (
                <CommandItem key={s.id} onSelect={() => { onSelect(s); setOpen(false); setQ('') }}>
                  <span className="font-mono font-semibold mr-2">{s.symbol}</span>
                  <span className="text-muted-foreground">{s.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{s.market}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
