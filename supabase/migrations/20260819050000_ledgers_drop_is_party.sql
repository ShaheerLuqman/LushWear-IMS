-- is_party never ended up used for anything other than filtering the bill
-- supplier picker, and that picker now just lists Liability-type ledgers
-- directly, so the flag is dead weight.
ALTER TABLE finances_ledgers DROP COLUMN IF EXISTS is_party;
