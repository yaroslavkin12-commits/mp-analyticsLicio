CREATE TABLE IF NOT EXISTS wb_orders (
  id BIGSERIAL PRIMARY KEY,
  collected_at TIMESTAMP DEFAULT NOW(),
  date DATE NOT NULL,
  last_change_date TIMESTAMP,
  order_id VARCHAR(64),
  nm_id BIGINT,
  article VARCHAR(128),
  subject VARCHAR(256),
  category VARCHAR(256),
  brand VARCHAR(256),
  supplier_article VARCHAR(128),
  tech_size VARCHAR(32),
  barcode VARCHAR(64),
  total_price DECIMAL(12,2),
  discount_percent INT,
  price_with_disc DECIMAL(12,2),
  warehouse_name VARCHAR(256),
  oblast VARCHAR(256),
  is_cancel BOOLEAN DEFAULT FALSE,
  cancel_dt TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wb_orders_date ON wb_orders(date);
CREATE INDEX IF NOT EXISTS idx_wb_orders_nm ON wb_orders(nm_id);

CREATE TABLE IF NOT EXISTS wb_sales (
  id BIGSERIAL PRIMARY KEY,
  collected_at TIMESTAMP DEFAULT NOW(),
  date DATE NOT NULL,
  last_change_date TIMESTAMP,
  sale_id VARCHAR(64) UNIQUE,
  nm_id BIGINT,
  article VARCHAR(128),
  subject VARCHAR(256),
  category VARCHAR(256),
  brand VARCHAR(256),
  supplier_article VARCHAR(128),
  tech_size VARCHAR(32),
  barcode VARCHAR(64),
  price DECIMAL(12,2),
  discount_percent INT,
  price_with_disc DECIMAL(12,2),
  for_pay DECIMAL(12,2),
  finished_price DECIMAL(12,2),
  warehouse_name VARCHAR(256),
  oblast VARCHAR(256)
);
CREATE INDEX IF NOT EXISTS idx_wb_sales_date ON wb_sales(date);
CREATE INDEX IF NOT EXISTS idx_wb_sales_nm ON wb_sales(nm_id);

CREATE TABLE IF NOT EXISTS wb_stocks (
  id BIGSERIAL PRIMARY KEY,
  collected_at TIMESTAMP DEFAULT NOW(),
  snapshot_date DATE NOT NULL,
  nm_id BIGINT,
  article VARCHAR(128),
  subject VARCHAR(256),
  category VARCHAR(256),
  supplier_article VARCHAR(128),
  tech_size VARCHAR(32),
  barcode VARCHAR(64),
  quantity INT DEFAULT 0,
  quantity_full INT DEFAULT 0,
  warehouse_name VARCHAR(256)
);
CREATE INDEX IF NOT EXISTS idx_wb_stocks_snap ON wb_stocks(snapshot_date);

CREATE TABLE IF NOT EXISTS wb_ads (
  id BIGSERIAL PRIMARY KEY,
  collected_at TIMESTAMP DEFAULT NOW(),
  date DATE NOT NULL,
  campaign_id BIGINT,
  campaign_name VARCHAR(512),
  campaign_type INT,
  nm_id BIGINT,
  views BIGINT DEFAULT 0,
  clicks BIGINT DEFAULT 0,
  ctr DECIMAL(8,4) DEFAULT 0,
  cpc DECIMAL(10,2) DEFAULT 0,
  spend DECIMAL(12,2) DEFAULT 0,
  orders INT DEFAULT 0,
  revenue DECIMAL(12,2) DEFAULT 0,
  UNIQUE(date, campaign_id, COALESCE(nm_id, -1))
);
CREATE INDEX IF NOT EXISTS idx_wb_ads_date ON wb_ads(date);

CREATE TABLE IF NOT EXISTS ozon_orders (
  id BIGSERIAL PRIMARY KEY,
  collected_at TIMESTAMP DEFAULT NOW(),
  date DATE NOT NULL,
  posting_number VARCHAR(64),
  order_id BIGINT,
  sku BIGINT,
  offer_id VARCHAR(128),
  product_name VARCHAR(512),
  price DECIMAL(12,2),
  quantity INT DEFAULT 1,
  commission_amount DECIMAL(12,2),
  commission_percent DECIMAL(6,2),
  payout DECIMAL(12,2),
  status VARCHAR(64),
  cancel_reason VARCHAR(256),
  warehouse_name VARCHAR(256),
  UNIQUE(posting_number, sku)
);
CREATE INDEX IF NOT EXISTS idx_oz_orders_date ON ozon_orders(date);
CREATE INDEX IF NOT EXISTS idx_oz_orders_sku ON ozon_orders(sku);

CREATE TABLE IF NOT EXISTS ozon_stocks (
  id BIGSERIAL PRIMARY KEY,
  collected_at TIMESTAMP DEFAULT NOW(),
  snapshot_date DATE NOT NULL,
  sku BIGINT,
  offer_id VARCHAR(128),
  product_name VARCHAR(512),
  fbo_present INT DEFAULT 0,
  fbo_reserved INT DEFAULT 0,
  fbs_present INT DEFAULT 0,
  fbs_reserved INT DEFAULT 0,
  warehouse_id BIGINT,
  warehouse_name VARCHAR(256)
);
CREATE INDEX IF NOT EXISTS idx_oz_stocks_snap ON ozon_stocks(snapshot_date);

CREATE TABLE IF NOT EXISTS ozon_ads (
  id BIGSERIAL PRIMARY KEY,
  collected_at TIMESTAMP DEFAULT NOW(),
  date DATE NOT NULL,
  campaign_id BIGINT,
  campaign_name VARCHAR(512),
  campaign_type VARCHAR(64),
  sku BIGINT,
  offer_id VARCHAR(128),
  views BIGINT DEFAULT 0,
  clicks BIGINT DEFAULT 0,
  ctr DECIMAL(8,4) DEFAULT 0,
  spend DECIMAL(12,2) DEFAULT 0,
  orders INT DEFAULT 0,
  revenue DECIMAL(12,2) DEFAULT 0,
  UNIQUE(date, campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_oz_ads_date ON ozon_ads(date);

CREATE TABLE IF NOT EXISTS ozon_analytics (
  id BIGSERIAL PRIMARY KEY,
  collected_at TIMESTAMP DEFAULT NOW(),
  date DATE NOT NULL,
  sku BIGINT NOT NULL,
  offer_id VARCHAR(128),
  product_name VARCHAR(512),
  hits_view BIGINT DEFAULT 0,
  hits_view_search BIGINT DEFAULT 0,
  hits_view_pdp BIGINT DEFAULT 0,
  hits_tocart BIGINT DEFAULT 0,
  hits_tocart_search BIGINT DEFAULT 0,
  hits_tocart_pdp BIGINT DEFAULT 0,
  orders_item BIGINT DEFAULT 0,
  revenue DECIMAL(12,2) DEFAULT 0,
  delivered_units BIGINT DEFAULT 0,
  returns BIGINT DEFAULT 0,
  cancellations BIGINT DEFAULT 0,
  ctr DECIMAL(8,6) DEFAULT 0,
  cr_to_cart DECIMAL(8,6) DEFAULT 0,
  cr_to_order DECIMAL(8,6) DEFAULT 0,
  redemption_rate DECIMAL(8,4) DEFAULT 0,
  UNIQUE(date, sku)
);
CREATE INDEX IF NOT EXISTS idx_oz_analytics_date ON ozon_analytics(date);
CREATE INDEX IF NOT EXISTS idx_oz_analytics_sku ON ozon_analytics(sku);

CREATE TABLE IF NOT EXISTS product_costs (
  id BIGSERIAL PRIMARY KEY,
  platform VARCHAR(10) NOT NULL CHECK(platform IN ('wb','ozon')),
  article VARCHAR(128) NOT NULL,
  product_name VARCHAR(512),
  cost_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(platform, article)
);

CREATE TABLE IF NOT EXISTS collection_log (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMP DEFAULT NOW(),
  finished_at TIMESTAMP,
  platform VARCHAR(10) NOT NULL,
  collector_type VARCHAR(64) NOT NULL,
  status VARCHAR(20) DEFAULT 'running',
  records_collected INT DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(128) PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO app_settings (key, value) VALUES
  ('wb_enabled', 'true'),
  ('ozon_enabled', 'true'),
  ('collect_interval_hours', '2')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE wb_stocks ADD COLUMN IF NOT EXISTS stock_type VARCHAR(10) NOT NULL DEFAULT 'fbo';
CREATE INDEX IF NOT EXISTS idx_wb_stocks_type ON wb_stocks(stock_type);

CREATE TABLE IF NOT EXISTS ozon_catalog (
  offer_id VARCHAR(128) PRIMARY KEY,
  product_name VARCHAR(512),
  photo_url TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);
