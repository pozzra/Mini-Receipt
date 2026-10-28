-- Create the invoices table used by the admin scanner + Supabase save flow.
create table if not exists public.invoices (
  id bigserial primary key,
  invoice_no text not null,
  customer_name text,
  customer_phone text,
  shop_name text,
  invoice_date date,
  payment_method text,
  status text,
  subtotal numeric,
  discount_pct numeric,
  tax_pct numeric,
  delivery numeric,
  total numeric,
  note text,
  items jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_invoices_invoice_date
  on public.invoices (invoice_date);

create index if not exists idx_invoices_status
  on public.invoices (status);
