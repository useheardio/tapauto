-- ============================================================
-- Tap Auto — Supabase schema, security, and tap resolver (v1)
-- Run in Supabase: Database > SQL Editor > New query > paste > Run.
-- Safe to run on a fresh project. Re-running: drop the schema first.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- enums ----------
do $$ begin
  create type tag_status as enum ('unassigned','assigned','retired');
exception when duplicate_object then null; end $$;
do $$ begin
  create type staff_role as enum ('owner','manager','tech');
exception when duplicate_object then null; end $$;
do $$ begin
  create type offer_kind as enum ('thanks','due','winback','custom');
exception when duplicate_object then null; end $$;

-- ---------- core tables ----------
create table if not exists shops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  branding jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null,
  address text,
  created_at timestamptz default now()
);

-- a staff member is a Supabase Auth user tied to one shop + a role
create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  shop_id uuid not null references shops(id) on delete cascade,
  name text,
  role staff_role not null default 'tech',
  created_at timestamptz default now()
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null, -- set when the driver verifies their phone (Tier 1/2)
  name text,
  email text,
  phone text,
  consent_sms boolean default false,   -- TCPA: required before any marketing text
  consent_email boolean default false, -- CAN-SPAM: required before marketing email
  stripe_customer_id text,
  created_at timestamptz default now()
);

create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  vin text,
  plate text,
  year int, make text, model text,
  oil_type text default '0W-20 Syn',
  interval_miles int default 5000,
  last_service_mileage int,
  last_service_at timestamptz,
  created_at timestamptz default now()
);

-- separate table so resale reassigns cleanly and history stays attributed
create table if not exists vehicle_ownership (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  active boolean default true,
  started_at timestamptz default now(),
  ended_at timestamptz
);

-- the tag is a dumb pointer; all intelligence is here
create table if not exists tags (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  uid text,                     -- NFC chip UID
  token text not null unique,   -- value carried in the tag URL: /t/{token}
  status tag_status not null default 'unassigned',
  vehicle_id uuid references vehicles(id) on delete set null,
  location_id uuid references locations(id) on delete set null,
  locked_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists service_records (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  performed_by uuid references staff(id) on delete set null,
  performed_at timestamptz default now(),
  mileage int,
  oil_type text,
  services jsonb default '[]'::jsonb,
  total_cents int,
  next_due_mileage int,
  created_at timestamptz default now()
);

create table if not exists offers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  kind offer_kind not null default 'custom',
  code text,
  title text not null,
  value_cents int,
  active boolean default true,
  valid_from timestamptz default now(),
  valid_to timestamptz,
  created_at timestamptz default now()
);

-- the active offer a given car sees when it taps (set by the journey buckets)
create table if not exists vehicle_offers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  offer_id uuid not null references offers(id) on delete cascade,
  active boolean default true,
  created_at timestamptz default now()
);

-- every tap: analytics goldmine + security tripwire
create table if not exists taps (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references shops(id) on delete set null,
  tag_id uuid references tags(id) on delete set null,
  vehicle_id uuid references vehicles(id) on delete set null,
  counter int,            -- NTAG 424 SDM read counter
  cmac_valid boolean,     -- did the signature verify
  tier text,              -- 0 / 1 / 2
  coarse_geo text,
  occurred_at timestamptz default now()
);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  service_record_id uuid references service_records(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  amount_cents int not null,
  stripe_payment_intent text,
  status text default 'pending',
  created_at timestamptz default now()
);

-- audit log: who touched what (trust + dispute resolution)
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references shops(id) on delete set null,
  actor uuid references auth.users(id) on delete set null,
  action text,
  entity text,
  entity_id uuid,
  at timestamptz default now()
);

-- ---------- helper: shop_id for the signed-in staff member ----------
create or replace function staff_shop()
returns uuid language sql stable security definer set search_path = public as $$
  select shop_id from staff where user_id = auth.uid() limit 1;
$$;

-- ============================================================
-- Row-Level Security
-- Default = deny. Staff see only their shop. Drivers see only their car.
-- Anonymous taps NEVER read tables directly (see tap_public below).
-- ============================================================
alter table shops enable row level security;
alter table locations enable row level security;
alter table staff enable row level security;
alter table customers enable row level security;
alter table vehicles enable row level security;
alter table vehicle_ownership enable row level security;
alter table tags enable row level security;
alter table service_records enable row level security;
alter table offers enable row level security;
alter table vehicle_offers enable row level security;
alter table taps enable row level security;
alter table payments enable row level security;
alter table audit_log enable row level security;

-- staff can read their own membership row
create policy staff_self on staff for select using (user_id = auth.uid());

-- shop-scoped full access for staff (one policy per shop-scoped table)
create policy shop_rw  on shops             for all using (id = staff_shop())       with check (id = staff_shop());
create policy loc_rw   on locations         for all using (shop_id = staff_shop())  with check (shop_id = staff_shop());
create policy cust_rw  on customers         for all using (shop_id = staff_shop())  with check (shop_id = staff_shop());
create policy veh_rw   on vehicles          for all using (shop_id = staff_shop())  with check (shop_id = staff_shop());
create policy own_rw   on vehicle_ownership for all using (shop_id = staff_shop())  with check (shop_id = staff_shop());
create policy tag_rw   on tags              for all using (shop_id = staff_shop())  with check (shop_id = staff_shop());
create policy sr_rw    on service_records   for all using (shop_id = staff_shop())  with check (shop_id = staff_shop());
create policy off_rw   on offers            for all using (shop_id = staff_shop())  with check (shop_id = staff_shop());
create policy voff_rw  on vehicle_offers    for all using (shop_id = staff_shop())  with check (shop_id = staff_shop());
create policy tap_rw   on taps              for all using (shop_id = staff_shop())  with check (shop_id = staff_shop());
create policy pay_rw   on payments          for all using (shop_id = staff_shop())  with check (shop_id = staff_shop());
create policy audit_rw on audit_log         for select using (shop_id = staff_shop());

-- driver self-access (Tier 1/2): a verified phone sees only their own data
create policy cust_self on customers for select using (auth_user_id = auth.uid());
create policy veh_self on vehicles for select using (
  exists (select 1 from vehicle_ownership o join customers c on c.id = o.customer_id
          where o.vehicle_id = vehicles.id and o.active and c.auth_user_id = auth.uid()));
create policy sr_self on service_records for select using (
  exists (select 1 from vehicle_ownership o join customers c on c.id = o.customer_id
          where o.vehicle_id = service_records.vehicle_id and o.active and c.auth_user_id = auth.uid()));

-- ============================================================
-- Tier 0 public tap resolver
-- Anonymous taps call THIS, not the tables. Returns the benign public
-- view only: car make/model, due estimate, active offer. Never PII.
-- ============================================================
create or replace function tap_public(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object(
        'found', true,
        'vehicle', jsonb_build_object('year', v.year, 'make', v.make, 'model', v.model),
        'interval_miles', v.interval_miles,
        'last_service_mileage', v.last_service_mileage,
        'last_service_at', v.last_service_at,
        'offer', (select jsonb_build_object('title', o.title, 'code', o.code, 'value_cents', o.value_cents)
                  from vehicle_offers vo join offers o on o.id = vo.offer_id
                  where vo.vehicle_id = v.id and vo.active and o.active
                  order by vo.created_at desc limit 1)
      )
     from tags t join vehicles v on v.id = t.vehicle_id
     where t.token = p_token and t.status = 'assigned'),
    jsonb_build_object('found', false)
  );
$$;
grant execute on function tap_public(text) to anon, authenticated;

-- record a tap (anon-safe, write-only insert via function)
create or replace function log_tap(p_token text, p_counter int, p_cmac_valid boolean, p_tier text)
returns void language plpgsql security definer set search_path = public as $$
declare v_tag tags;
begin
  select * into v_tag from tags where token = p_token;
  if found then
    insert into taps(shop_id, tag_id, vehicle_id, counter, cmac_valid, tier)
    values (v_tag.shop_id, v_tag.id, v_tag.vehicle_id, p_counter, p_cmac_valid, p_tier);
  end if;
end $$;
grant execute on function log_tap(text,int,boolean,text) to anon, authenticated;

-- ============================================================
-- Done. Next: scaffold the Next.js app and wire these with the
-- anon key (browser) + service_role key (server / tap resolver, SDM CMAC check).
-- ============================================================
