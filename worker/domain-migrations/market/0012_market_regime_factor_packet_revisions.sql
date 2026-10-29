-- Append-only factor packet builds (PIT, Wei 10/29). Once the next session has opened,
-- a rebuild of a past date is recorded here and the original canonical packet is kept.
CREATE TABLE IF NOT EXISTS market_regime_factor_packet_revisions_v1 (
 date TEXT NOT NULL, packet_checksum TEXT NOT NULL CHECK(length(packet_checksum)=64),
 packet_json TEXT NOT NULL,
 canonical_mode TEXT NOT NULL CHECK(canonical_mode IN ('replace','keep_original')),
 recorded_at TEXT NOT NULL,
 PRIMARY KEY(date,packet_checksum)
);
