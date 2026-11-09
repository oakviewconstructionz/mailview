-- ============================================================================
-- OakView Mail — database schema (MySQL 8 / MariaDB 10.4+)
-- Idempotent: safe to run repeatedly (CREATE TABLE IF NOT EXISTS).
-- ============================================================================

-- --- Users & access control -------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email         VARCHAR(190) NOT NULL,
  name          VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('admin','manager','viewer') NOT NULL DEFAULT 'viewer',
  status        ENUM('active','disabled') NOT NULL DEFAULT 'active',
  last_login_at DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_resets (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at    DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pr_token (token_hash),
  KEY idx_pr_user (user_id),
  CONSTRAINT fk_pr_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- Integration settings (secrets stored encrypted) ------------------------
CREATE TABLE IF NOT EXISTS settings (
  setting_key   VARCHAR(120) NOT NULL,
  setting_value TEXT NULL,
  is_secret     TINYINT(1) NOT NULL DEFAULT 0,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- Subscribers / contacts -------------------------------------------------
CREATE TABLE IF NOT EXISTS subscribers (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email        VARCHAR(190) NOT NULL,
  first_name   VARCHAR(120) NULL,
  last_name    VARCHAR(120) NULL,
  company      VARCHAR(190) NULL,
  phone        VARCHAR(60) NULL,
  custom_data  JSON NULL,
  status       ENUM('subscribed','unsubscribed','bounced','complained','pending') NOT NULL DEFAULT 'subscribed',
  source       VARCHAR(80) NOT NULL DEFAULT 'manual',
  last_error   VARCHAR(255) NULL,
  sync_state   ENUM('local','synced','pending','failed') NOT NULL DEFAULT 'local',
  synced_at    DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_subscribers_email (email),
  KEY idx_subscribers_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lists (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(190) NOT NULL,
  description TEXT NULL,
  provider_id VARCHAR(120) NULL,          -- id of the list at the delivery provider
  sync_state  ENUM('local','synced','pending','failed') NOT NULL DEFAULT 'local',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_lists_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS list_subscribers (
  list_id       INT UNSIGNED NOT NULL,
  subscriber_id INT UNSIGNED NOT NULL,
  added_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (list_id, subscriber_id),
  KEY idx_ls_subscriber (subscriber_id),
  CONSTRAINT fk_ls_list FOREIGN KEY (list_id) REFERENCES lists (id) ON DELETE CASCADE,
  CONSTRAINT fk_ls_subscriber FOREIGN KEY (subscriber_id) REFERENCES subscribers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS segments (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(190) NOT NULL,
  description TEXT NULL,
  rules       JSON NULL,                  -- e.g. {"status":"subscribed","list_id":3,"has_opened":true}
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_segments_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Suppression list — unsubscribed / bounced / complained addresses are never
-- emailed again, across every campaign.
CREATE TABLE IF NOT EXISTS suppressions (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email      VARCHAR(190) NOT NULL,
  reason     ENUM('unsubscribe','bounce','complaint','manual') NOT NULL,
  detail     VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_suppressions_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- Templates --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS templates (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(190) NOT NULL,
  subject     VARCHAR(255) NULL,
  preheader   VARCHAR(255) NULL,
  html        MEDIUMTEXT NULL,
  text        MEDIUMTEXT NULL,
  created_by  INT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_templates_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- Campaigns --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name                 VARCHAR(190) NOT NULL,
  subject              VARCHAR(255) NOT NULL,
  preheader            VARCHAR(255) NULL,
  from_name            VARCHAR(190) NULL,
  from_email           VARCHAR(190) NULL,
  reply_to             VARCHAR(190) NULL,
  template_id          INT UNSIGNED NULL,
  html                 MEDIUMTEXT NULL,
  text                 MEDIUMTEXT NULL,
  list_id              INT UNSIGNED NULL,
  segment_id           INT UNSIGNED NULL,
  provider             VARCHAR(40) NOT NULL DEFAULT 'sender',
  provider_campaign_id VARCHAR(120) NULL,
  provider_group_id    VARCHAR(120) NULL,
  status               ENUM('draft','scheduled','queued','sending','paused','sent','failed','cancelled')
                         NOT NULL DEFAULT 'draft',
  scheduled_at         DATETIME NULL,
  started_at           DATETIME NULL,
  completed_at         DATETIME NULL,
  last_error           VARCHAR(500) NULL,
  -- per-campaign overrides for batch sizing / throttling (NULL = use global defaults)
  batch_size           INT UNSIGNED NULL,
  interval_seconds     INT UNSIGNED NULL,
  max_recipients       INT UNSIGNED NULL,
  total_recipients     INT UNSIGNED NOT NULL DEFAULT 0,
  sent_count           INT UNSIGNED NOT NULL DEFAULT 0,
  delivered_count      INT UNSIGNED NOT NULL DEFAULT 0,
  failed_count         INT UNSIGNED NOT NULL DEFAULT 0,
  open_count           INT UNSIGNED NOT NULL DEFAULT 0,
  click_count          INT UNSIGNED NOT NULL DEFAULT 0,
  bounce_count         INT UNSIGNED NOT NULL DEFAULT 0,
  unsubscribe_count    INT UNSIGNED NOT NULL DEFAULT 0,
  created_by           INT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_campaigns_status (status),
  KEY idx_campaigns_scheduled (scheduled_at),
  CONSTRAINT fk_campaigns_template FOREIGN KEY (template_id) REFERENCES templates (id) ON DELETE SET NULL,
  CONSTRAINT fk_campaigns_list FOREIGN KEY (list_id) REFERENCES lists (id) ON DELETE SET NULL,
  CONSTRAINT fk_campaigns_segment FOREIGN KEY (segment_id) REFERENCES segments (id) ON DELETE SET NULL,
  CONSTRAINT fk_campaigns_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per recipient of a campaign — this is the send queue and the record
-- of what actually happened for each address. Scales to 2,000–5,000+ rows.
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id         INT UNSIGNED NOT NULL,
  subscriber_id       INT UNSIGNED NULL,
  email               VARCHAR(190) NOT NULL,
  status              ENUM('queued','sending','sent','delivered','failed','bounced','opened','clicked','unsubscribed')
                        NOT NULL DEFAULT 'queued',
  provider_message_id VARCHAR(190) NULL,
  error               VARCHAR(500) NULL,
  attempts            INT UNSIGNED NOT NULL DEFAULT 0,
  token               CHAR(40) NOT NULL,       -- opaque token used for open/click tracking
  sync_state          ENUM('pending','synced','failed') NOT NULL DEFAULT 'pending',
  queued_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at             DATETIME NULL,
  delivered_at        DATETIME NULL,
  opened_at           DATETIME NULL,
  clicked_at          DATETIME NULL,
  bounced_at          DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_cr_token (token),
  UNIQUE KEY uniq_cr_campaign_email (campaign_id, email),   -- prevents duplicate sends
  KEY idx_cr_campaign_status (campaign_id, status),
  KEY idx_cr_email (email),
  CONSTRAINT fk_cr_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE,
  CONSTRAINT fk_cr_subscriber FOREIGN KEY (subscriber_id) REFERENCES subscribers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_events (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id  INT UNSIGNED NOT NULL,
  recipient_id BIGINT UNSIGNED NULL,
  type         ENUM('send','delivery','open','click','bounce','unsubscribe','error') NOT NULL,
  url          VARCHAR(500) NULL,
  meta         JSON NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ce_campaign_type (campaign_id, type),
  CONSTRAINT fk_ce_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Links harvested from campaign HTML so clicks can be tracked + rewritten.
CREATE TABLE IF NOT EXISTS campaign_links (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id INT UNSIGNED NOT NULL,
  url         VARCHAR(500) NOT NULL,
  token       CHAR(40) NOT NULL,
  clicks      INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_cl_token (token),
  KEY idx_cl_campaign (campaign_id),
  CONSTRAINT fk_cl_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- Mailbox cache (IMAP sync) ----------------------------------------------
CREATE TABLE IF NOT EXISTS mail_messages (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account         VARCHAR(80) NOT NULL DEFAULT 'default',
  folder          VARCHAR(190) NOT NULL,
  uid             BIGINT UNSIGNED NOT NULL,
  message_id      VARCHAR(255) NULL,
  in_reply_to     VARCHAR(255) NULL,
  refs            TEXT NULL,
  from_name       VARCHAR(190) NULL,
  from_email      VARCHAR(190) NULL,
  to_json         JSON NULL,
  cc_json         JSON NULL,
  bcc_json        JSON NULL,
  subject         VARCHAR(500) NULL,
  snippet         VARCHAR(500) NULL,
  text_body       MEDIUMTEXT NULL,
  html_body       MEDIUMTEXT NULL,
  has_attachments TINYINT(1) NOT NULL DEFAULT 0,
  is_read         TINYINT(1) NOT NULL DEFAULT 0,
  is_starred      TINYINT(1) NOT NULL DEFAULT 0,
  is_draft        TINYINT(1) NOT NULL DEFAULT 0,
  is_sent         TINYINT(1) NOT NULL DEFAULT 0,
  size_bytes      INT UNSIGNED NULL,
  sent_at         DATETIME NULL,
  received_at     DATETIME NULL,
  synced_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_mail_uid (account, folder, uid),
  KEY idx_mail_folder (account, folder, received_at),
  KEY idx_mail_message_id (message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mail_attachments (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id   BIGINT UNSIGNED NOT NULL,
  filename     VARCHAR(255) NULL,
  content_type VARCHAR(160) NULL,
  size_bytes   INT UNSIGNED NULL,
  content_id   VARCHAR(190) NULL,
  is_inline    TINYINT(1) NOT NULL DEFAULT 0,
  storage_path VARCHAR(500) NULL,
  PRIMARY KEY (id),
  KEY idx_ma_message (message_id),
  CONSTRAINT fk_ma_message FOREIGN KEY (message_id) REFERENCES mail_messages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- Audit trail ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NULL,
  action     VARCHAR(120) NOT NULL,
  meta       JSON NULL,
  ip         VARCHAR(60) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_al_action (action),
  KEY idx_al_user (user_id),
  CONSTRAINT fk_al_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
