-- The app's event consumer keeps one checkpoint per broker (app:sim, app:alpaca), since the simulator's event IDs and Alpaca's mean
-- nothing to each other. Its one checkpoint so far, "app", was the simulator's.
BEGIN;

UPDATE event_checkpoints SET consumer = 'app:sim' WHERE consumer = 'app'
  AND NOT EXISTS (SELECT 1 FROM event_checkpoints WHERE consumer = 'app:sim');

COMMIT;
