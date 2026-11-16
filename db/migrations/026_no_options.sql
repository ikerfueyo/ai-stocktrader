-- The app trades stocks only: options (021_options.sql) were removed. Nothing is dropped yet, since the release before this one
-- reads these tables and columns while a deploy rolls out; a later migration drops them. This one refuses to run while an account still
-- holds option contracts or has an option order working, which the app could no longer value, close or match. Closed option trades
-- and their fees stay in the ledger as history.
BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM sim_lots WHERE qty <> 0 AND symbol ~ '^[A-Z.]{1,6}[0-9]{6}[CP][0-9]{8}$') THEN
        RAISE EXCEPTION 'An account still holds option contracts: close them before deploying the stocks-only app';
    END IF;
    IF EXISTS (SELECT 1 FROM sim_orders WHERE status IN ('new', 'accepted', 'partially_filled', 'held', 'pending_new', 'pending_cancel', 'pending_replace')
               AND (order_class = 'mleg' OR symbol ~ '^[A-Z.]{1,6}[0-9]{6}[CP][0-9]{8}$')) THEN
        RAISE EXCEPTION 'An option order is still working: cancel it before deploying the stocks-only app';
    END IF;
    IF EXISTS (SELECT 1 FROM sim_option_instructions) THEN
        RAISE EXCEPTION 'Do-not-exercise instructions are still on file: remove them before deploying the stocks-only app';
    END IF;
    IF EXISTS (SELECT 1 FROM sim_options_approvals WHERE status = 'PENDING') THEN
        RAISE EXCEPTION 'An options approval request is still pending: decide or remove it before deploying the stocks-only app';
    END IF;
END $$;

COMMIT;
