select execute($$ 

insert into migrations (id, description) values ('0001', 'transactions');

create type account_type as enum ('channel', 'owner', 'uphold');
create type transaction_type as enum ('contribution', 'referral', 'settlement', 'scaleup', 'manual');

create table transactions(
  id uuid primary key,
  created_at timestamp with time zone not null default current_timestamp,
  description text,

  transaction_type transaction_type not null,
  document_id text,

  from_account_type account_type not null,
  from_account text not null,

  to_account_type account_type not null,
  to_account text not null,
  -- numeric(precision, scale), precision is total sig figs, scale is fractional digits - after decimal point
  -- for BAT the scale is 18, there are 2 billion tokens so precision should be 18 + 9 = 27
  amount numeric(27, 18) not null check (amount > 0.0),

  -- for settlement only, value in currency the publisher chose to be paid in
  settlement_currency text,
  settlement_amount numeric(27, 18) check (settlement_amount > 0.0)
);

create index on transactions(from_account);
create index on transactions(to_account);

create view account_transactions(
  created_at,
  description,
  transaction_type,
  document_id,
  account_type,
  account_id,
  amount,
  settlement_currency,
  settlement_amount
) as 
  select
    transactions.created_at,
    transactions.description,
    transactions.transaction_type,
    transactions.document_id,
    transactions.from_account_type,
    transactions.from_account,
    (0.0 - transactions.amount),
    transactions.settlement_currency,
    transactions.settlement_amount
  from transactions
union all
  select
    transactions.created_at,
    transactions.description,
    transactions.transaction_type,
    transactions.document_id,
    transactions.to_account_type,
    transactions.to_account,
    transactions.amount,
    transactions.settlement_currency,
    transactions.settlement_amount
  from transactions;

create materialized view account_balances(
  account_type,
  account_id,
  balance
) as
  select
    account_transactions.account_type,
    account_transactions.account_id,
    coalesce(sum(account_transactions.amount), 0.0)
  from account_transactions
  group by (account_transactions.account_type, account_transactions.account_id);

create unique index on account_balances(account_type, account_id);

$$) where not exists (select * from migrations where id = '0001');
