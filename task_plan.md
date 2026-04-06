# UI Redesign v2 — Full Layout Restructure

## 問題
Phase 1 只改 token 值，視覺差異太小。需要改佈局結構。

## 策略
1. index.css: oklch → hex（確保渲染正確）
2. 建立 AppShell.tsx（shared sidebar + topbar）
3. Dashboard.tsx: 用 AppShell 包裝
4. BotDashboard.tsx: 用 AppShell 包裝 + 重整 content
5. App.tsx: 更新 loading fallback

## Phase A: index.css hex + AppShell
## Phase B: Dashboard.tsx + BotDashboard.tsx restructure
## Phase C: Build + Deploy
