-- ============================================================
-- Tap Auto - demo seed data (run AFTER schema.sql)
-- Creates one shop, one vehicle, an active offer, and a tag with
-- token = 'demo'. Lets you test the real tap resolver end to end:
--   /api/tap?token=demo   and   /demo.html?t=demo
-- ============================================================
do $$
declare s uuid; l uuid; v uuid; o uuid;
begin
  insert into shops(name, address) values ('Sir Walter Quick Lube','Raleigh, NC') returning id into s;
  insert into locations(shop_id, name, address) values (s,'Main bay','Raleigh, NC') returning id into l;

  insert into vehicles(shop_id, vin, plate, year, make, model, oil_type, interval_miles, last_service_mileage, last_service_at)
    values (s,'JTMRWRFV8MD000001','KRT-4471',2021,'Toyota','RAV4','0W-20 Syn',5000,42180, now() - interval '30 days')
    returning id into v;

  insert into offers(shop_id, kind, code, title, value_cents, active)
    values (s,'due','OIL15','$15 off your next oil change',1500,true)
    returning id into o;

  insert into vehicle_offers(shop_id, vehicle_id, offer_id, active) values (s, v, o, true);

  insert into tags(shop_id, token, uid, status, vehicle_id, location_id, locked_at)
    values (s,'demo','04:DEMO:TAG','assigned', v, l, now());
end $$;
