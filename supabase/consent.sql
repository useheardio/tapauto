-- ============================================================
-- Tap Auto - self-serve consent (run AFTER schema.sql)
-- Lets a driver opt themselves in to text/email reminders from the
-- customer app. This is the legally cleaner path (the driver consents,
-- not the shop on their behalf).
--
-- SECURITY DEFINER so an anonymous Tier-0 tap can record consent for the
-- customer who owns the tapped tag's vehicle. It can only set consent and
-- fill in contact details; it cannot read anyone's data back.
--
-- HARDENING (next step): gate this behind a phone OTP (Tier 1) so we prove
-- the number belongs to the person tapping before trusting the opt-in.
-- ============================================================
create or replace function record_consent(
  p_token    text,
  p_email    text default null,
  p_sms      boolean default null,
  p_email_ok boolean default null,
  p_phone    text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_veh uuid; v_cust uuid;
begin
  select t.vehicle_id into v_veh from tags t where t.token = p_token and t.status = 'assigned';
  if v_veh is null then return jsonb_build_object('ok', false, 'error', 'tag not found'); end if;

  select o.customer_id into v_cust from vehicle_ownership o
    where o.vehicle_id = v_veh and o.active limit 1;
  if v_cust is null then return jsonb_build_object('ok', false, 'error', 'no owner on file'); end if;

  update customers set
    consent_sms   = coalesce(p_sms, consent_sms),
    consent_email = coalesce(p_email_ok, consent_email),
    email         = coalesce(nullif(btrim(p_email), ''), email),
    phone         = coalesce(nullif(btrim(p_phone), ''), phone)
  where id = v_cust;

  return jsonb_build_object('ok', true);
end $$;

grant execute on function record_consent(text,text,boolean,boolean,text) to anon, authenticated;
