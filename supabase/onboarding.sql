-- ============================================================
-- Tap Auto - first-run onboarding (run AFTER schema.sql)
-- Lets a brand-new signed-in user bootstrap their own shop.
--
-- The problem: RLS scopes every table to the caller's shop via
-- staff_shop(). A new user has no staff row yet, so staff_shop()
-- is null and they cannot insert a shop or a staff row directly.
--
-- The fix: one SECURITY DEFINER function that, for the calling
-- user only, creates the shop + first location + the owner staff
-- row (and an optional first offer) in a single trusted step.
-- It refuses if the caller already belongs to a shop.
-- ============================================================

create or replace function create_shop(
  p_shop_name        text,
  p_shop_address     text default null,
  p_owner_name       text default null,
  p_location_name    text default 'Main bay',
  p_location_address text default null,
  p_branding         jsonb default '{}'::jsonb,
  p_offer_title      text default null,
  p_offer_code       text default null,
  p_offer_value_cents int default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_shop uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if exists (select 1 from staff where user_id = v_uid) then
    raise exception 'this account already belongs to a shop';
  end if;
  if p_shop_name is null or btrim(p_shop_name) = '' then
    raise exception 'shop name is required';
  end if;

  insert into shops(name, address, branding)
    values (btrim(p_shop_name), p_shop_address, coalesce(p_branding,'{}'::jsonb))
    returning id into v_shop;

  insert into locations(shop_id, name, address)
    values (v_shop, coalesce(nullif(btrim(p_location_name),''),'Main bay'), p_location_address);

  insert into staff(user_id, shop_id, name, role)
    values (v_uid, v_shop, p_owner_name, 'owner');

  if p_offer_title is not null and btrim(p_offer_title) <> '' then
    insert into offers(shop_id, kind, code, title, value_cents, active)
      values (v_shop, 'due', p_offer_code, btrim(p_offer_title), p_offer_value_cents, true);
  end if;

  return v_shop;
end $$;

grant execute on function create_shop(text,text,text,text,text,jsonb,text,text,int) to authenticated;

-- ============================================================
-- Done. A signed-in user with no shop can now call:
--   supabase.rpc('create_shop', { p_shop_name: '...', ... })
-- and they become the owner of a fresh, RLS-isolated shop.
-- ============================================================
