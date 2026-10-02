CREATE TABLE IF NOT EXISTS paper_rotation_outcomes_v1 (
  account_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL REFERENCES paper_orders(id),
  as_of_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('immature','missing_data','mature')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(account_id,order_id,as_of_date)
);
