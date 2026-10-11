-- 070 — Delivery: which vehicle carries each order (motorcycle or van), with a per-driver default.
--   dt_drivers.vehicle : the driver's usual vehicle, pre-selected on new orders.
--   dt_orders.vehicle  : the vehicle actually used for that order.
-- Existing rows become 'Motorcycle'. dt_orders_guard needs no change (delivery.orders users may edit
-- today's orders in full; delivery.settle users still can only change paid / paid_at).
alter table public.dt_drivers add column if not exists vehicle text not null default 'Motorcycle';
alter table public.dt_orders  add column if not exists vehicle text not null default 'Motorcycle';

alter table public.dt_drivers drop constraint if exists dt_drivers_vehicle_check;
alter table public.dt_drivers add constraint dt_drivers_vehicle_check check (vehicle in ('Motorcycle', 'Van'));
alter table public.dt_orders  drop constraint if exists dt_orders_vehicle_check;
alter table public.dt_orders  add constraint dt_orders_vehicle_check  check (vehicle in ('Motorcycle', 'Van'));
