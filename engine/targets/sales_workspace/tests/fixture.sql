SET TIME ZONE 'UTC';  -- relative dates below are computed in UTC, like the application

-- Synthetic test data for the sales workspace (made-up business, not real people or companies).
-- Loaded after schema.sql into a throwaway database by tests/conftest.py and by the screenshot run.
--
-- Users' password hashes use SuiteCRM 7's scheme, password_hash(strtolower(md5(password))) with PHP's $2y$
-- prefix, for the test password TEST_PASSWORD defined in tests/conftest.py.
-- Dates are relative to the day the fixture is loaded, so renewals, close dates and due dates stay current.
--
-- Shape: two teams (East Sales, West Sales), a manager and two salespeople per team, an inactive salesperson,
-- an administrator without a team, a support lead without a team. Roles mirror the customer's SuiteCRM roles:
--   Salesperson   list/view = team, edit = own, delete = none
--   Sales Manager list/view/edit/delete = team
--   Support       accounts/contacts list/view = all, edit = none; notes/tasks list/view = all, edit = own;
--                 deals and leads access = disabled

INSERT INTO app_meta (key, value) VALUES
  ('migration', '{"source": "SuiteCRM 7.11.23", "snapshot_taken_at": "2026-11-04T21:00:00Z", "synthetic": true}');

INSERT INTO teams (id, name, source) VALUES
  ('t-east', 'East Sales', 'suitecrm'),
  ('t-west', 'West Sales', 'suitecrm');

INSERT INTO roles (id, name, description, source) VALUES
  ('r-sales',   'Salesperson',   'Account executives: see their team''s sales records, edit their own, no delete.', 'suitecrm'),
  ('r-manager', 'Sales Manager', 'Team managers: see, edit and delete their team''s sales records; approve large deals.', 'suitecrm'),
  ('r-support', 'Support',       'Support desk: reads accounts and contacts; no access to deals or leads.', 'suitecrm');

INSERT INTO role_permissions (role_id, entity, action, level)
SELECT 'r-sales', e, v.a, v.l
FROM unnest(ARRAY['accounts','contacts','leads','deals','notes','tasks']) AS e
CROSS JOIN (VALUES ('access','enabled'), ('list','team'), ('view','team'), ('edit','own'), ('delete','none'),
                   ('export','none')) AS v(a, l);

INSERT INTO role_permissions (role_id, entity, action, level)
SELECT 'r-manager', e, v.a, v.l
FROM unnest(ARRAY['accounts','contacts','leads','deals','notes','tasks']) AS e
CROSS JOIN (VALUES ('access','enabled'), ('list','team'), ('view','team'), ('edit','team'), ('delete','team'),
                   ('export','team')) AS v(a, l);

INSERT INTO role_permissions (role_id, entity, action, level)
SELECT 'r-support', e, v.a, v.l
FROM unnest(ARRAY['accounts','contacts']) AS e
CROSS JOIN (VALUES ('access','enabled'), ('list','all'), ('view','all'), ('edit','none'), ('delete','none'),
                   ('export','none')) AS v(a, l);

INSERT INTO role_permissions (role_id, entity, action, level)
SELECT 'r-support', e, v.a, v.l
FROM unnest(ARRAY['notes','tasks']) AS e
CROSS JOIN (VALUES ('access','enabled'), ('list','all'), ('view','all'), ('edit','own'), ('delete','none'),
                   ('export','none')) AS v(a, l);

INSERT INTO role_permissions (role_id, entity, action, level) VALUES
  ('r-support', 'deals', 'access', 'disabled'),
  ('r-support', 'leads', 'access', 'disabled');

INSERT INTO users (id, user_name, first_name, last_name, title, email, status, is_admin, reports_to,
                   password_hash, password_scheme, timezone, source) VALUES
  ('u-admin',   'admin',   'Avery', 'Stone',  'CRM Administrator',   'avery.stone@sample.example', 'active',   true,  NULL,
   '$2y$10$OG5NrwCVy6ThHI16YcLAxeIse1DuOKQROJwPnNIUITzLfhvbTe82i', 'suitecrm-bcrypt-md5', 'UTC', 'suitecrm'),
  ('u-mchen',   'mchen',   'Maya',  'Chen',   'Sales Manager, East', 'maya.chen@sample.example',   'active',   false, NULL,
   '$2y$10$ku86E/rN4dGJlzGOj2rjL.ifjFoi6SP54/QBYpda7c1pFlqiKq/3G', 'suitecrm-bcrypt-md5', 'UTC', 'suitecrm'),
  ('u-ohaddad', 'ohaddad', 'Omar',  'Haddad', 'Sales Manager, West', 'omar.haddad@sample.example', 'active',   false, NULL,
   '$2y$10$6ql96.oGFjRx5uchYM6hCOS6HOvnlYYusfcR/aY/Ww3NPukzYVcJ.', 'suitecrm-bcrypt-md5', 'UTC', 'suitecrm'),
  ('u-pnair',   'pnair',   'Priya', 'Nair',   'Account Executive',   'priya.nair@sample.example',  'active',   false, 'u-mchen',
   '$2y$10$wsAV5Y20c3i3/x5SCYbrDu1TmC17u.H6fGn5k/uwXQxyzplaqKKSO', 'suitecrm-bcrypt-md5', 'UTC', 'suitecrm'),
  ('u-jweber',  'jweber',  'Jonah', 'Weber',  'Account Executive',   'jonah.weber@sample.example', 'active',   false, 'u-mchen',
   '$2y$10$uGSQuN67MXjUHUi8hV/21u2BeR5Ploqn8cYhKyAJHjbnYZbCnWsbm', 'suitecrm-bcrypt-md5', 'UTC', 'suitecrm'),
  ('u-sokafor', 'sokafor', 'Sam',   'Okafor', 'Account Executive',   'sam.okafor@sample.example',  'active',   false, 'u-ohaddad',
   '$2y$10$cRjOmG9QPba75PkeXkQStuElihKeFnjWfSrxrat/ss9c8aOkfJHl.', 'suitecrm-bcrypt-md5', 'UTC', 'suitecrm'),
  ('u-rellis',  'rellis',  'Ruth',  'Ellis',  'Account Executive',   'ruth.ellis@sample.example',  'active',   false, 'u-ohaddad',
   '$2y$10$LbCDDfK1RSKKx7471ortB.BnDNcMAvUUaW1VIGWV/SF9zjlZdp/S2', 'suitecrm-bcrypt-md5', 'UTC', 'suitecrm'),
  ('u-treyes',  'treyes',  'Tom',   'Reyes',  'Account Executive (left 2025)', 'tom.reyes@sample.example', 'inactive', false, 'u-ohaddad',
   '$2y$10$wEUGw/d89zW9Rq7WK.kHlOyPLIsj274w8yb63oq.Zndi6y/PEuTHS', 'suitecrm-bcrypt-md5', 'UTC', 'suitecrm'),
  ('u-dkim',    'dkim',    'Dana',  'Kim',    'Support Lead',        'dana.kim@sample.example',    'active',   false, NULL,
   '$2y$10$0SLxWxcVZgLAuwJqAOyGy.2ivxsvNl6APsMNQj9SM8.tN5VtATUym', 'suitecrm-bcrypt-md5', 'UTC', 'suitecrm');

INSERT INTO user_roles (user_id, role_id) VALUES
  ('u-mchen', 'r-manager'), ('u-ohaddad', 'r-manager'),
  ('u-pnair', 'r-sales'), ('u-jweber', 'r-sales'), ('u-sokafor', 'r-sales'), ('u-rellis', 'r-sales'),
  ('u-treyes', 'r-sales'),
  ('u-dkim', 'r-support');

INSERT INTO user_teams (user_id, team_id) VALUES
  ('u-mchen', 't-east'), ('u-pnair', 't-east'), ('u-jweber', 't-east'),
  ('u-ohaddad', 't-west'), ('u-sokafor', 't-west'), ('u-rellis', 't-west'), ('u-treyes', 't-west');

INSERT INTO currencies (code, name, symbol, rate_per_usd, source_id) VALUES
  ('USD', 'US Dollar', '$', 1.000000, '-99'),
  ('EUR', 'Euro', '€', 0.920000, 'eur-0920');

-- ------------------------------------------------------------------------------------------------- accounts
INSERT INTO accounts (id, name, account_type, industry, phone, website, billing_city, billing_state, billing_country,
                      employees, description, contract_renewal_date, owner_id, created_by, created_at, updated_at,
                      deleted_at, source) VALUES
  ('acc-acme-supply', 'Acme Supply', 'Customer', 'Retail', '(518) 555-0100', 'www.acme-supply.example', 'Albany', 'NY', 'USA',
   '120', 'Regional distributor of janitorial and warehouse supplies. Customer since 2019; consolidating vendors this year.',
   CURRENT_DATE + 45, 'u-pnair', 'u-pnair', now() - interval '900 days', now() - interval '3 days', NULL, 'suitecrm'),
  ('acc-acme-supply-inc', 'Acme Supply Inc', 'Prospect', 'Retail', '(617) 555-0142', 'www.acmesupplyinc.example', 'Boston', 'MA', 'USA',
   '35', 'A different company with a similar name (no relation to Acme Supply in Albany).',
   NULL, 'u-jweber', 'u-jweber', now() - interval '200 days', now() - interval '20 days', NULL, 'suitecrm'),
  ('acc-acme-supplies-ltd', 'Acme Supplies Ltd', 'Customer', 'Manufacturing', '(860) 555-0102', 'www.acme-supplies-ltd.example', 'Hartford', 'CT', 'USA',
   '650', 'Manufacturer of shelving components; buys in euros through its EU parent.',
   CURRENT_DATE - 30, 'u-jweber', 'u-jweber', now() - interval '1300 days', now() - interval '30 days', NULL, 'suitecrm'),
  ('acc-northwind', 'Northwind Clinics', 'Customer', 'Healthcare', '(508) 555-0177', 'www.northwind-clinics.example', 'Worcester', 'MA', 'USA',
   '410', 'Network of outpatient clinics.', CURRENT_DATE + 12, 'u-mchen', 'u-mchen', now() - interval '700 days', now() - interval '9 days', NULL, 'suitecrm'),
  ('acc-bluebird', 'Bluebird Health Partners', 'Customer', 'Healthcare', '(401) 555-0119', 'www.bluebird-health.example', 'Providence', 'RI', 'USA',
   '1200', 'Hospital group; purchasing is centralised.', CURRENT_DATE + 75, 'u-pnair', 'u-pnair', now() - interval '640 days', now() - interval '15 days', NULL, 'suitecrm'),
  ('acc-orchard', 'Orchard Lane Grocers', 'Customer', 'Retail', '(802) 555-0164', 'www.orchard-lane.example', 'Burlington', 'VT', 'USA',
   '85', 'Independent grocery chain, five stores.', CURRENT_DATE + 88, 'u-pnair', 'u-pnair', now() - interval '300 days', now() - interval '5 days', NULL, 'suitecrm'),
  ('acc-granite', 'Granite Peak Hardware', 'Prospect', 'Retail', '(603) 555-0150', 'www.granite-peak.example', 'Manchester', 'NH', 'USA',
   '60', NULL, CURRENT_DATE + 160, 'u-jweber', 'u-jweber', now() - interval '120 days', now() - interval '10 days', NULL, 'suitecrm'),
  ('acc-old-mill', 'Old Mill Traders', 'Customer', 'Retail', '(518) 555-0190', NULL, 'Troy', 'NY', 'USA',
   '20', 'Closed its account in 2025.', CURRENT_DATE + 30, 'u-pnair', 'u-pnair', now() - interval '1500 days', now() - interval '200 days',
   now() - interval '200 days', 'suitecrm'),
  ('acc-acme-supply-co', 'ACME Supply Co.', 'Customer', 'Retail', '(503) 555-0101', 'www.acme-supply-co.example', 'Portland', 'OR', 'USA',
   '650', 'West-coast wholesaler; not related to Acme Supply in Albany.', CURRENT_DATE + 130, 'u-sokafor', 'u-sokafor',
   now() - interval '980 days', now() - interval '12 days', NULL, 'suitecrm'),
  ('acc-harborview', 'Harborview Retail Group', 'Customer', 'Retail', '(206) 555-0133', 'www.harborview-retail.example', 'Seattle', 'WA', 'USA',
   '2300', 'Department stores across the Pacific Northwest.', CURRENT_DATE + 20, 'u-rellis', 'u-rellis',
   now() - interval '1100 days', now() - interval '2 days', NULL, 'suitecrm'),
  ('acc-cedar-grove', 'Cedar Grove Manufacturing', 'Partner', 'Manufacturing', '(208) 555-0158', 'www.cedar-grove.example', 'Boise', 'ID', 'USA',
   '540', NULL, CURRENT_DATE + 200, 'u-sokafor', 'u-sokafor', now() - interval '400 days', now() - interval '40 days', NULL, 'suitecrm'),
  ('acc-summit', 'Summit Ridge Hospital', 'Prospect', 'Healthcare', '(509) 555-0171', 'www.summit-ridge.example', 'Spokane', 'WA', 'USA',
   '900', NULL, NULL, 'u-ohaddad', 'u-ohaddad', now() - interval '60 days', now() - interval '6 days', NULL, 'suitecrm'),
  ('acc-pine-hollow', 'Pine Hollow Outfitters', 'Customer', 'Retail', '(541) 555-0126', 'www.pine-hollow.example', 'Bend', 'OR', 'USA',
   '40', 'West team account assigned to Priya while covering a territory.', CURRENT_DATE + 60, 'u-pnair', 'u-rellis',
   now() - interval '500 days', now() - interval '25 days', NULL, 'suitecrm');

-- ------------------------------------------------------------------------------------------------- contacts
INSERT INTO contacts (id, first_name, last_name, title, email, phone, city, state, lead_source, description, account_id,
                      owner_id, created_by, created_at, updated_at, deleted_at, source) VALUES
  ('c-maria-lopez', 'Maria', 'Lopez', 'Purchasing Manager', 'maria.lopez@acme-supply.example', '(518) 555-0107', 'Albany', 'NY',
   'Trade Show', NULL, 'acc-acme-supply', 'u-pnair', 'u-pnair', now() - interval '890 days', now() - interval '12 days', NULL, 'suitecrm'),
  ('c-dev-patel', 'Dev', 'Patel', 'Operations Director', 'dev.patel@acme-supply.example', '(518) 555-0123', 'Albany', 'NY',
   'Existing Customer', NULL, 'acc-acme-supply', 'u-pnair', 'u-pnair', now() - interval '400 days', now() - interval '3 days', NULL, 'suitecrm'),
  ('c-grace-kim', 'Grace', 'Kim', 'Chief Financial Officer', 'grace.kim@acme-supply.example', '(518) 555-0131', 'Albany', 'NY',
   'Cold Call', NULL, 'acc-acme-supply', 'u-jweber', 'u-jweber', now() - interval '210 days', now() - interval '50 days', NULL, 'suitecrm'),
  ('c-victor-hale', 'Victor', 'Hale', 'Former buyer', 'victor.hale@acme-supply.example', NULL, 'Albany', 'NY',
   NULL, NULL, 'acc-acme-supply', 'u-pnair', 'u-pnair', now() - interval '1000 days', now() - interval '300 days',
   now() - interval '300 days', 'suitecrm'),
  ('c-nadia-petrov', 'Nadia', 'Petrov', 'Regional Buyer', 'nadia.petrov@acme-supply.example', '(503) 555-0188', 'Portland', 'OR',
   'Word of mouth', 'Works with the West team on joint purchasing.', 'acc-acme-supply', 'u-sokafor', 'u-sokafor',
   now() - interval '90 days', now() - interval '30 days', NULL, 'suitecrm'),
  ('c-owen-shaw', 'Owen', 'Shaw', 'Procurement Lead', 'owen.shaw@acme-supplies-ltd.example', '(860) 555-0145', 'Hartford', 'CT',
   'Existing Customer', NULL, 'acc-acme-supplies-ltd', 'u-jweber', 'u-jweber', now() - interval '800 days', now() - interval '31 days', NULL, 'suitecrm'),
  ('c-hannah-berg', 'Hannah', 'Berg', 'Facilities Lead', 'hannah.berg@northwind-clinics.example', '(508) 555-0181', 'Worcester', 'MA',
   'Web Site', NULL, 'acc-northwind', 'u-mchen', 'u-mchen', now() - interval '650 days', now() - interval '9 days', NULL, 'suitecrm'),
  ('c-lucy-tran', 'Lucy', 'Tran', 'Supply Chain Director', 'lucy.tran@bluebird-health.example', '(401) 555-0122', 'Providence', 'RI',
   'Trade Show', NULL, 'acc-bluebird', 'u-pnair', 'u-pnair', now() - interval '600 days', now() - interval '15 days', NULL, 'suitecrm'),
  ('c-quinn-harper', 'Quinn', 'Harper', 'Store Manager', 'quinn.harper@orchard-lane.example', '(802) 555-0170', 'Burlington', 'VT',
   'Web Site', NULL, 'acc-orchard', 'u-pnair', 'u-pnair', now() - interval '40 days', now() - interval '40 days', NULL, 'workspace'),
  ('c-luis-ortega', 'Luis', 'Ortega', 'Buyer', 'luis.ortega@acme-supply-co.example', '(503) 555-0109', 'Portland', 'OR',
   'Trade Show', NULL, 'acc-acme-supply-co', 'u-sokafor', 'u-sokafor', now() - interval '950 days', now() - interval '12 days', NULL, 'suitecrm'),
  ('c-sara-lind', 'Sara', 'Lind', 'VP Operations', 'sara.lind@harborview-retail.example', '(206) 555-0140', 'Seattle', 'WA',
   'Existing Customer', NULL, 'acc-harborview', 'u-rellis', 'u-rellis', now() - interval '1000 days', now() - interval '2 days', NULL, 'suitecrm'),
  ('c-ken-ito', 'Ken', 'Ito', 'Plant Manager', 'ken.ito@cedar-grove.example', '(208) 555-0163', 'Boise', 'ID',
   'Cold Call', NULL, 'acc-cedar-grove', 'u-sokafor', 'u-sokafor', now() - interval '380 days', now() - interval '40 days', NULL, 'suitecrm');

-- ------------------------------------------------------------------------------------------------- deals
INSERT INTO deals (id, name, account_id, stage, probability, amount, currency_code, amount_usd, close_date, lead_source,
                   next_step, description, approval_status, approved_by, approved_amount_usd, approved_at, owner_id,
                   created_by, created_at, updated_at, deleted_at, source) VALUES
  ('d-acme-shelving', 'Acme Supply – Warehouse shelving', 'acc-acme-supply', 'Negotiation/Review', 80, 48500.00, 'USD', 48500.000000,
   CURRENT_DATE + 20, 'Existing Customer', 'Waiting for manager approval', 'Second warehouse in Albany; three-year supply agreement.',
   'requested', NULL, NULL, NULL, 'u-pnair', 'u-pnair', now() - interval '45 days', now() - interval '2 days', NULL, 'suitecrm'),
  ('d-acme-25000', 'Acme Supply – Janitorial renewal', 'acc-acme-supply', 'Negotiation/Review', 80, 25000.00, 'USD', 25000.000000,
   CURRENT_DATE + 10, 'Existing Customer', 'Send final contract', NULL,
   '', NULL, NULL, NULL, 'u-pnair', 'u-pnair', now() - interval '60 days', now() - interval '4 days', NULL, 'suitecrm'),
  ('d-acme-25001', 'Acme Supply – Signage and labeling', 'acc-acme-supply', 'Negotiation/Review', 80, 25000.01, 'USD', 25000.010000,
   CURRENT_DATE + 14, 'Cold Call', 'Agree delivery schedule', NULL,
   '', NULL, NULL, NULL, 'u-pnair', 'u-pnair', now() - interval '50 days', now() - interval '6 days', NULL, 'suitecrm'),
  ('d-acme-cold', 'Acme Supply – Cold storage retrofit', 'acc-acme-supply', 'Proposal/Price Quote', 65, 30000.00, 'USD', 30000.000000,
   CURRENT_DATE + 30, 'Existing Customer', 'Proposal review on site', NULL,
   'approved', 'u-mchen', 30000.00, now() - interval '3 days', 'u-pnair', 'u-pnair', now() - interval '35 days', now() - interval '3 days', NULL, 'suitecrm'),
  ('d-acme-won', 'Acme Supply – Packaging 2025', 'acc-acme-supply', 'Closed Won', 100, 18200.00, 'USD', 18200.000000,
   CURRENT_DATE - 120, 'Existing Customer', NULL, NULL,
   '', NULL, NULL, NULL, 'u-pnair', 'u-pnair', now() - interval '200 days', now() - interval '120 days', NULL, 'suitecrm'),
  ('d-acme-lost', 'Acme Supply – Floor care pilot', 'acc-acme-supply', 'Closed Lost', 0, 6400.00, 'USD', 6400.000000,
   CURRENT_DATE - 60, 'Cold Call', NULL, NULL,
   '', NULL, NULL, NULL, 'u-pnair', 'u-pnair', now() - interval '150 days', now() - interval '60 days', NULL, 'suitecrm'),
  ('d-acme-safety', 'Acme Supply – Safety signage', 'acc-acme-supply', 'Perception Analysis', 50, 4300.00, 'USD', 4300.000000,
   CURRENT_DATE + 40, 'Cold Call', 'Samples sent', NULL,
   '', NULL, NULL, NULL, 'u-jweber', 'u-jweber', now() - interval '25 days', now() - interval '8 days', NULL, 'suitecrm'),
  ('d-acme-old', 'Acme Supply – Mop heads (cancelled)', 'acc-acme-supply', 'Qualification', 20, 2100.00, 'USD', 2100.000000,
   CURRENT_DATE - 10, NULL, NULL, NULL,
   '', NULL, NULL, NULL, 'u-pnair', 'u-pnair', now() - interval '80 days', now() - interval '70 days', now() - interval '70 days', 'suitecrm'),
  ('d-eur-24000', 'Acme Supplies Ltd – EU distribution', 'acc-acme-supplies-ltd', 'Negotiation/Review', 80, 24000.00, 'EUR', 26086.956522,
   CURRENT_DATE + 21, 'Existing Customer', 'Confirm VAT handling', 'Priced in euros for the EU parent company.',
   '', NULL, NULL, NULL, 'u-jweber', 'u-jweber', now() - interval '40 days', now() - interval '5 days', NULL, 'suitecrm'),
  ('d-eur-23000', 'Acme Supplies Ltd – Spare parts', 'acc-acme-supplies-ltd', 'Negotiation/Review', 80, 23000.00, 'EUR', 25000.000000,
   CURRENT_DATE + 18, 'Existing Customer', NULL, NULL,
   '', NULL, NULL, NULL, 'u-jweber', 'u-jweber', now() - interval '30 days', now() - interval '7 days', NULL, 'suitecrm'),
  ('d-unowned', 'Acme Supplies Ltd – Service contract', 'acc-acme-supplies-ltd', 'Perception Analysis', 50, 27500.00, 'USD', 27500.000000,
   CURRENT_DATE + 35, NULL, NULL, 'Owner left the company; not yet reassigned.',
   'requested', NULL, NULL, NULL, NULL, 'u-jweber', now() - interval '70 days', now() - interval '20 days', NULL, 'suitecrm'),
  ('d-northwind', 'Northwind Clinics – Sterilisation carts', 'acc-northwind', 'Value Proposition', 30, 14750.00, 'USD', 14750.000000,
   CURRENT_DATE + 33, 'Web Site', 'Demo at Worcester site', NULL,
   '', NULL, NULL, NULL, 'u-mchen', 'u-mchen', now() - interval '28 days', now() - interval '9 days', NULL, 'suitecrm'),
  ('d-bluebird-imaging', 'Bluebird – Imaging carts', 'acc-bluebird', 'Negotiation/Review', 80, 38000.00, 'USD', 38000.000000,
   CURRENT_DATE + 25, 'Trade Show', 'Revise discount', NULL,
   'rejected', NULL, NULL, NULL, 'u-pnair', 'u-pnair', now() - interval '55 days', now() - interval '15 days', NULL, 'suitecrm'),
  ('d-bluebird-linen', 'Bluebird – Linen service', 'acc-bluebird', 'Qualification', 20, 9200.00, 'USD', 9200.000000,
   CURRENT_DATE + 60, 'Existing Customer', 'Discovery call', NULL,
   '', NULL, NULL, NULL, 'u-pnair', 'u-pnair', now() - interval '12 days', now() - interval '12 days', NULL, 'suitecrm'),
  ('d-orchard-lanes', 'Orchard Lane – Checkout lanes', 'acc-orchard', 'Prospecting', 10, 12000.00, 'USD', 12000.000000,
   CURRENT_DATE + 75, 'Web Site', 'Intro meeting', NULL,
   '', NULL, NULL, NULL, 'u-pnair', 'u-pnair', now() - interval '6 days', now() - interval '6 days', NULL, 'workspace'),
  ('d-granite-pilot', 'Granite Peak – Shelving pilot', 'acc-granite', 'Needs Analysis', 25, 7800.00, 'USD', 7800.000000,
   CURRENT_DATE + 50, 'Cold Call', 'Measure store', NULL,
   '', NULL, NULL, NULL, 'u-jweber', 'u-jweber', now() - interval '20 days', now() - interval '10 days', NULL, 'suitecrm'),
  ('d-acme-inc-intro', 'Acme Supply Inc – Intro order', 'acc-acme-supply-inc', 'Id. Decision Makers', 40, 5200.00, 'USD', 5200.000000,
   CURRENT_DATE + 45, 'Cold Call', NULL, NULL,
   '', NULL, NULL, NULL, 'u-jweber', 'u-jweber', now() - interval '15 days', now() - interval '15 days', NULL, 'suitecrm'),
  ('d-acmeco-fleet', 'ACME Supply Co. – Fleet supplies', 'acc-acme-supply-co', 'Negotiation/Review', 80, 62000.00, 'USD', 62000.000000,
   CURRENT_DATE + 15, 'Trade Show', 'Manager approval', NULL,
   'requested', NULL, NULL, NULL, 'u-sokafor', 'u-sokafor', now() - interval '48 days', now() - interval '1 day', NULL, 'suitecrm'),
  ('d-harborview-pos', 'Harborview – POS refresh', 'acc-harborview', 'Value Proposition', 30, 12400.00, 'USD', 12400.000000,
   CURRENT_DATE + 40, 'Existing Customer', NULL, NULL,
   '', NULL, NULL, NULL, 'u-rellis', 'u-rellis', now() - interval '22 days', now() - interval '2 days', NULL, 'suitecrm'),
  ('d-harborview-won', 'Harborview – Store fixtures 2025', 'acc-harborview', 'Closed Won', 100, 52000.00, 'USD', 52000.000000,
   CURRENT_DATE - 90, 'Existing Customer', NULL, NULL,
   'approved', 'u-ohaddad', 52000.00, now() - interval '95 days', 'u-rellis', 'u-rellis', now() - interval '160 days', now() - interval '90 days', NULL, 'suitecrm'),
  ('d-harborview-displays', 'Harborview – Seasonal displays', 'acc-harborview', 'Qualification', 20, 8800.00, 'USD', 8800.000000,
   CURRENT_DATE + 55, NULL, NULL, NULL,
   '', NULL, NULL, NULL, 'u-treyes', 'u-treyes', now() - interval '400 days', now() - interval '380 days', NULL, 'suitecrm'),
  ('d-cedar-safety', 'Cedar Grove – Safety gear', 'acc-cedar-grove', 'Proposal/Price Quote', 65, 41000.00, 'USD', 41000.000000,
   CURRENT_DATE + 28, 'Cold Call', 'Pricing sign-off', NULL,
   '', NULL, NULL, NULL, 'u-sokafor', 'u-sokafor', now() - interval '33 days', now() - interval '4 days', NULL, 'suitecrm'),
  ('d-summit-kits', 'Summit Ridge – Patient room kits', 'acc-summit', 'Prospecting', 10, 18000.00, 'USD', 18000.000000,
   CURRENT_DATE + 90, 'Web Site', NULL, NULL,
   '', NULL, NULL, NULL, 'u-ohaddad', 'u-ohaddad', now() - interval '8 days', now() - interval '8 days', NULL, 'workspace'),
  ('d-pine-racks', 'Pine Hollow – Outdoor racks', 'acc-pine-hollow', 'Qualification', 20, 6100.00, 'USD', 6100.000000,
   CURRENT_DATE + 30, 'Existing Customer', NULL, NULL,
   '', NULL, NULL, NULL, 'u-pnair', 'u-rellis', now() - interval '18 days', now() - interval '9 days', NULL, 'suitecrm');

INSERT INTO deal_contacts (deal_id, contact_id, role) VALUES
  ('d-acme-shelving', 'c-maria-lopez', 'Primary Decision Maker'),
  ('d-acme-shelving', 'c-dev-patel', 'Technical Evaluator'),
  ('d-acme-shelving', 'c-nadia-petrov', 'Influencer'),
  ('d-acme-25001', 'c-maria-lopez', 'Primary Decision Maker'),
  ('d-eur-24000', 'c-owen-shaw', 'Business Decision Maker'),
  ('d-acmeco-fleet', 'c-luis-ortega', 'Primary Decision Maker'),
  ('d-bluebird-imaging', 'c-lucy-tran', 'Primary Decision Maker');

-- ------------------------------------------------------------------------------------------------- leads
INSERT INTO leads (id, first_name, last_name, company, title, email, phone, city, status, lead_source, description,
                   converted, converted_contact_id, converted_account_id, converted_deal_id, owner_id, created_by,
                   created_at, updated_at, deleted_at, source) VALUES
  ('l-ethan-brooks', 'Ethan', 'Brooks', '  acme   SUPPLY ', 'Facilities Manager', 'ethan.brooks@acme-supply.example', '(518) 555-0188',
   'Albany', 'New', 'Web Site', 'Asked for a quote on shelving for a second warehouse.', false, NULL, NULL, NULL,
   'u-pnair', 'u-pnair', now() - interval '2 days', now() - interval '1 day', NULL, 'workspace'),
  ('l-nora-fields', 'Nora', 'Fields', 'Acme Supplies', 'Buyer', 'nora.fields@acmesupplies.example', '(860) 555-0177',
   'Hartford', 'Assigned', 'Trade Show', NULL, false, NULL, NULL, NULL,
   'u-jweber', 'u-jweber', now() - interval '9 days', now() - interval '9 days', NULL, 'suitecrm'),
  ('l-olivia-grant', 'Olivia', 'Grant', 'Brightwater Dental', 'Office Manager', 'olivia.grant@brightwater-dental.example', '(603) 555-0115',
   'Concord', 'In Process', 'Cold Call', NULL, false, NULL, NULL, NULL,
   'u-pnair', 'u-pnair', now() - interval '20 days', now() - interval '6 days', NULL, 'suitecrm'),
  ('l-greg-lowe', 'Greg', 'Lowe', 'Granite Peak Hardware', 'Store Owner', 'greg.lowe@granite-peak.example', NULL,
   'Manchester', 'New', 'Trade Show', NULL, false, NULL, NULL, NULL,
   'u-jweber', 'u-jweber', now() - interval '4 days', now() - interval '4 days', NULL, 'suitecrm'),
  ('l-quinn-harper', 'Quinn', 'Harper', 'Orchard Lane Grocers', 'Store Manager', 'quinn.harper@orchard-lane.example', '(802) 555-0170',
   'Burlington', 'Converted', 'Web Site', NULL, true, 'c-quinn-harper', 'acc-orchard', NULL,
   'u-pnair', 'u-pnair', now() - interval '45 days', now() - interval '40 days', NULL, 'suitecrm'),
  ('l-old', 'Iris', 'Vance', 'Old Mill Traders', 'Owner', NULL, NULL, 'Troy', 'Dead', NULL, NULL, false, NULL, NULL, NULL,
   'u-pnair', 'u-pnair', now() - interval '500 days', now() - interval '300 days', now() - interval '300 days', 'suitecrm'),
  ('l-paul-iverson', 'Paul', 'Iverson', 'Cascade Outdoor Co.', 'Owner', 'paul@cascade-outdoor.example', '(541) 555-0190',
   'Eugene', 'New', 'Web Site', NULL, false, NULL, NULL, NULL,
   'u-rellis', 'u-rellis', now() - interval '3 days', now() - interval '3 days', NULL, 'suitecrm'),
  ('l-rita-mendes', 'Rita', 'Mendes', 'ACME Supply Co.', 'Store Manager', 'rita.mendes@acme-supply-co.example', '(503) 555-0166',
   'Portland', 'Assigned', 'Existing Customer', NULL, false, NULL, NULL, NULL,
   'u-sokafor', 'u-sokafor', now() - interval '7 days', now() - interval '7 days', NULL, 'suitecrm');

INSERT INTO lead_conversions (lead_id, request_key, contact_id, account_id, deal_id, account_created, converted_by, converted_at)
VALUES ('l-quinn-harper', 'fixture-quinn-harper', 'c-quinn-harper', 'acc-orchard', NULL, false, 'u-pnair', now() - interval '40 days');

-- ------------------------------------------------------------------------------------------------- notes
INSERT INTO notes (id, subject, body, parent_type, parent_id, contact_id, owner_id, created_by, created_at, updated_at,
                   deleted_at, source) VALUES
  ('n-acme-renewal', 'Renewal kickoff', 'Dev confirmed budget for the warehouse shelving expansion. Anything above $25k needs Maya''s sign-off before we close.',
   'account', 'acc-acme-supply', 'c-dev-patel', 'u-pnair', 'u-pnair', now() - interval '3 days', now() - interval '3 days', NULL, 'workspace'),
  ('n-acme-qbr', 'Quarterly business review', 'Reviewed spend, service levels and open issues. Maria wants consolidated invoicing before the renewal.',
   'account', 'acc-acme-supply', 'c-maria-lopez', 'u-pnair', 'u-pnair', now() - interval '12 days', now() - interval '12 days', NULL, 'suitecrm'),
  ('n-acme-pricing', 'Pricing call', 'Discussed volume pricing on janitorial consumables. Revised quote sent the same day.',
   'account', 'acc-acme-supply', NULL, 'u-jweber', 'u-jweber', now() - interval '40 days', now() - interval '40 days', NULL, 'suitecrm'),
  ('n-acme-west', 'West team intro', 'Nadia asked about joint purchasing with the Portland office.',
   'account', 'acc-acme-supply', NULL, 'u-sokafor', 'u-sokafor', now() - interval '20 days', now() - interval '20 days', NULL, 'suitecrm'),
  ('n-acme-deleted', 'Duplicate note', 'Entered twice by mistake.',
   'account', 'acc-acme-supply', NULL, 'u-pnair', 'u-pnair', now() - interval '30 days', now() - interval '29 days', now() - interval '29 days', 'suitecrm'),
  ('n-shelving', 'Approval requested', 'Requested manager approval for the shelving deal before closing.',
   'deal', 'd-acme-shelving', 'c-maria-lopez', 'u-pnair', 'u-pnair', now() - interval '2 days', now() - interval '2 days', NULL, 'workspace'),
  ('n-ethan', 'Inbound web request', 'Asked for a quote on shelving for the Albany warehouse.',
   'lead', 'l-ethan-brooks', NULL, 'u-pnair', 'u-pnair', now() - interval '1 day', now() - interval '1 day', NULL, 'workspace'),
  ('n-maria', 'Prefers e-mail', 'Maria prefers e-mail before 10am; copy Dev on anything about the warehouse.',
   'contact', 'c-maria-lopez', 'c-maria-lopez', 'u-pnair', 'u-pnair', now() - interval '100 days', now() - interval '100 days', NULL, 'suitecrm'),
  ('n-acmeco-fleet', 'Fleet supplies scope', '42 vans; quarterly restock.',
   'deal', 'd-acmeco-fleet', 'c-luis-ortega', 'u-sokafor', 'u-sokafor', now() - interval '10 days', now() - interval '10 days', NULL, 'suitecrm');

-- ------------------------------------------------------------------------------------------------- tasks
INSERT INTO tasks (id, subject, status, priority, due_at, parent_type, parent_id, contact_id, description, owner_id,
                   created_by, created_at, updated_at, deleted_at, source) VALUES
  ('t-renewal-proposal', 'Send renewal proposal', 'Not Started', 'High', date_trunc('day', now()) + interval '2 days 17 hours',
   'account', 'acc-acme-supply', 'c-maria-lopez', NULL, 'u-pnair', 'u-pnair', now() - interval '5 days', now() - interval '5 days', NULL, 'workspace'),
  ('t-call-maria', 'Call Maria about the shelving approval', 'In Progress', 'High', date_trunc('day', now()) + interval '23 hours',
   'deal', 'd-acme-shelving', 'c-maria-lopez', NULL, 'u-pnair', 'u-pnair', now() - interval '2 days', now() - interval '2 days', NULL, 'workspace'),
  ('t-contract-terms', 'Update contract terms', 'Not Started', 'Medium', date_trunc('day', now()) - interval '2 days' + interval '17 hours',
   'account', 'acc-acme-supply', NULL, NULL, 'u-pnair', 'u-pnair', now() - interval '9 days', now() - interval '9 days', NULL, 'suitecrm'),
  ('t-qbr-deck', 'Prepare QBR deck', 'Completed', 'Medium', date_trunc('day', now()) - interval '14 days' + interval '17 hours',
   'account', 'acc-acme-supply', NULL, NULL, 'u-pnair', 'u-pnair', now() - interval '20 days', now() - interval '13 days', NULL, 'suitecrm'),
  ('t-ethan-followup', 'Follow up with Ethan Brooks', 'Not Started', 'Medium', date_trunc('day', now()) + interval '1 day 17 hours',
   'lead', 'l-ethan-brooks', NULL, NULL, 'u-pnair', 'u-pnair', now() - interval '1 day', now() - interval '1 day', NULL, 'workspace'),
  ('t-review-approvals', 'Review large deal approvals', 'Not Started', 'High', date_trunc('day', now()) + interval '1 day 12 hours',
   NULL, NULL, NULL, 'Weekly pass over requested approvals.', 'u-mchen', 'u-mchen', now() - interval '3 days', now() - interval '3 days', NULL, 'workspace'),
  ('t-site-visit', 'Book site visit at Acme Supplies Ltd', 'Not Started', 'Low', date_trunc('day', now()) + interval '5 days 15 hours',
   'account', 'acc-acme-supplies-ltd', 'c-owen-shaw', NULL, 'u-jweber', 'u-jweber', now() - interval '4 days', now() - interval '4 days', NULL, 'suitecrm'),
  ('t-fleet-dates', 'Confirm fleet delivery dates', 'Pending Input', 'Medium', date_trunc('day', now()) + interval '3 days 17 hours',
   'deal', 'd-acmeco-fleet', 'c-luis-ortega', NULL, 'u-sokafor', 'u-sokafor', now() - interval '2 days', now() - interval '2 days', NULL, 'suitecrm'),
  ('t-deleted', 'Old reminder', 'Not Started', 'Low', date_trunc('day', now()) + interval '1 day',
   'account', 'acc-acme-supply', NULL, NULL, 'u-pnair', 'u-pnair', now() - interval '30 days', now() - interval '29 days', now() - interval '29 days', 'suitecrm');

-- ------------------------------------------------------------------------------------------------- teams of records
-- Migrated records belong to their owner's team; the exceptions follow.
INSERT INTO record_teams (entity, record_id, team_id)
SELECT 'accounts', a.id, ut.team_id FROM accounts a JOIN user_teams ut ON ut.user_id = a.owner_id
WHERE a.id NOT IN ('acc-pine-hollow');
INSERT INTO record_teams (entity, record_id, team_id)
SELECT 'contacts', c.id, ut.team_id FROM contacts c JOIN user_teams ut ON ut.user_id = c.owner_id;
INSERT INTO record_teams (entity, record_id, team_id)
SELECT 'deals', d.id, ut.team_id FROM deals d JOIN user_teams ut ON ut.user_id = d.owner_id
WHERE d.id NOT IN ('d-pine-racks');
INSERT INTO record_teams (entity, record_id, team_id)
SELECT 'leads', l.id, ut.team_id FROM leads l JOIN user_teams ut ON ut.user_id = l.owner_id;
INSERT INTO record_teams (entity, record_id, team_id)
SELECT 'notes', n.id, ut.team_id FROM notes n JOIN user_teams ut ON ut.user_id = n.owner_id;
INSERT INTO record_teams (entity, record_id, team_id)
SELECT 'tasks', t.id, ut.team_id FROM tasks t JOIN user_teams ut ON ut.user_id = t.owner_id;
-- Pine Hollow is a West account (and deal) assigned to Priya (East); the unowned deal is in East Sales.
INSERT INTO record_teams (entity, record_id, team_id) VALUES
  ('accounts', 'acc-pine-hollow', 't-west'),
  ('deals', 'd-pine-racks', 't-west'),
  ('deals', 'd-unowned', 't-east');

-- ------------------------------------------------------------------------------------------------- history and links
INSERT INTO audit_log (entity, record_id, field, before, after, changed_by, changed_at, source) VALUES
  ('deals', 'd-acme-shelving', 'amount', '42000', '48500', 'u-pnair', now() - interval '20 days', 'suitecrm'),
  ('deals', 'd-acme-shelving', 'stage', 'Proposal/Price Quote', 'Negotiation/Review', 'u-pnair', now() - interval '9 days', 'suitecrm'),
  ('deals', 'd-acme-shelving', 'approval_status', '', 'requested', 'u-pnair', now() - interval '2 days', 'suitecrm'),
  ('deals', 'd-acmeco-fleet', 'approval_status', '', 'requested', 'u-sokafor', now() - interval '1 day', 'suitecrm'),
  ('deals', 'd-unowned', 'approval_status', '', 'requested', 'u-jweber', now() - interval '20 days', 'suitecrm');

INSERT INTO external_links (entity, record_id, system, kind, count, url) VALUES
  ('accounts', 'acc-acme-supply', 'SuiteCRM', 'Support cases', 3,
   'http://localhost:8081/index.php?module=Cases&action=index&query=true&account_name_advanced=Acme+Supply'),
  ('accounts', 'acc-acme-supply', 'SuiteCRM', 'Meetings', 2,
   'http://localhost:8081/index.php?module=Meetings&action=index&query=true&parent_name_advanced=Acme+Supply'),
  ('accounts', 'acc-acme-supply', 'SuiteCRM', 'Calls', 5,
   'http://localhost:8081/index.php?module=Calls&action=index&query=true&parent_name_advanced=Acme+Supply'),
  ('deals', 'd-acme-shelving', 'SuiteCRM', 'Meetings', 1,
   'http://localhost:8081/index.php?module=Meetings&action=index&query=true&parent_name_advanced=Warehouse+shelving'),
  ('contacts', 'c-maria-lopez', 'SuiteCRM', 'Calls', 2,
   'http://localhost:8081/index.php?module=Calls&action=index&query=true&contact_name_advanced=Maria+Lopez');
