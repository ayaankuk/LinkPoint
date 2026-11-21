CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  client TEXT,
  created_at TEXT,
  export_share REAL,
  lines TEXT,
  findings TEXT,
  recoverable REAL
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  scan_id TEXT,
  client TEXT,
  finding TEXT,
  draft TEXT,
  amount REAL,
  fee REAL,
  status TEXT,
  history TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  scan_id TEXT,
  client TEXT,
  message TEXT
);
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  client TEXT,
  payer TEXT,      -- 'client' or 'broker'
  stream TEXT,     -- setup | relief_prep | prepared_claim | platform_licence | monitoring | savings_fee | refund_success
  amount REAL,
  ref TEXT
);
