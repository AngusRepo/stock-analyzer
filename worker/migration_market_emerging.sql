-- 擴充 market 欄位支援興櫃（EMERGING）
-- SQLite 不支援 ALTER CHECK，需重建表或移除 CHECK
-- 實際操作：D1 的 CHECK constraint 是軟限制，直接 INSERT 'EMERGING' 即可
-- 此 migration 僅作為文件記錄

-- 如果未來需要插入興櫃股票：
-- INSERT INTO stocks (symbol, name, market, sector) VALUES ('6916', '博晟生醫', 'EMERGING', '生技醫療業')
-- D1 SQLite 不強制 CHECK 約束，所以不需要 ALTER TABLE
