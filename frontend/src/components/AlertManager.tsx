import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bell, Trash2, Plus, Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useAlerts, useAddAlert, useRemoveAlert } from "@/hooks/queries";
import { useAuth } from "@/hooks/useAuth";

interface Props { stockId: number; stockSymbol?: string }

const RULE_TYPES = [
  { value: "price_above", label: "價格高於" },
  { value: "price_below", label: "價格低於" },
  { value: "rsi_overbought", label: "RSI 超買 (≥70)" },
  { value: "rsi_oversold",   label: "RSI 超賣 (≤30)" },
  { value: "macd_cross_up",  label: "MACD 黃金交叉" },
  { value: "macd_cross_down","label": "MACD 死亡交叉" },
  { value: "bb_breakout_upper", label: "布林上軌突破" },
  { value: "bb_breakout_lower", label: "布林下軌跌破" },
];

export default function AlertManager({ stockId, stockSymbol }: Props) {
  const { isAuthenticated } = useAuth();
  const [ruleType, setRuleType] = useState("price_above");
  const [threshold, setThreshold] = useState("");

  const { data: rules = [], isLoading } = useAlerts();
  const addRule    = useAddAlert();
  const removeRule = useRemoveAlert();

  const stockRules = rules.filter((r: any) => r.stock_id === stockId);

  const handleAdd = async () => {
    if (!isAuthenticated) { toast.error("請先登入"); return; }
    try {
      await addRule.mutateAsync({ stockId, ruleType, threshold: threshold ? parseFloat(threshold) : null });
      toast.success("警報已新增"); setThreshold("");
    } catch (e: any) { toast.error(e.message); }
  };

  if (!isAuthenticated) return (
    <Card><CardContent className="py-6 text-center text-xs text-muted-foreground">請登入以使用警報功能</CardContent></Card>
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Bell className="w-4 h-4 text-yellow-400" /> 價格警報
          {stockSymbol && <Badge variant="outline" className="text-xs">{stockSymbol}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Select value={ruleType} onValueChange={setRuleType}>
            <SelectTrigger className="h-8 text-xs flex-1"><SelectValue /></SelectTrigger>
            <SelectContent>{RULE_TYPES.map(r => <SelectItem key={r.value} value={r.value} className="text-xs">{r.label}</SelectItem>)}</SelectContent>
          </Select>
          {(ruleType === "price_above" || ruleType === "price_below") && (
            <Input value={threshold} onChange={e => setThreshold(e.target.value)} placeholder="目標價" className="h-8 text-xs w-24" type="number" />
          )}
          <Button size="sm" variant="outline" onClick={handleAdd} disabled={addRule.isPending} className="h-8 px-2">
            {addRule.isPending ? <Loader2 className="w-3 h-3 animate-spin"/> : <Plus className="w-3 h-3"/>}
          </Button>
        </div>

        <div className="space-y-1.5">
          {isLoading ? <div className="text-xs text-muted-foreground text-center py-2">載入中...</div>
          : stockRules.length === 0 ? <div className="text-xs text-muted-foreground text-center py-2">尚無警報</div>
          : stockRules.map((r: any) => (
            <div key={r.id} className="flex items-center justify-between text-xs bg-muted/30 rounded-md px-2.5 py-1.5">
              <span>{RULE_TYPES.find(t => t.value === r.rule_type)?.label ?? r.rule_type}
                {r.threshold && <span className="ml-1 text-primary font-mono">{r.threshold}</span>}
              </span>
              <Button size="sm" variant="ghost" onClick={() => removeRule.mutate(r.id)} className="h-5 w-5 p-0">
                <Trash2 className="w-3 h-3 text-destructive"/>
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
