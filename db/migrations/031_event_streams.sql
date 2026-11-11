-- The app's event consumer keeps a checkpoint per stream (app:<broker>:<stream>, rows of event_checkpoints, written as events are
-- handled; the one per broker, app:<broker>, stays as where a stream without its own resumes from once), and the events it couldn't
-- handle, which the events job retries with backoff (next_attempt_at null once it gives up, kept to look at by hand).
BEGIN;

CREATE TABLE IF NOT EXISTS failed_events (
    consumer VARCHAR(64) NOT NULL,
    stream VARCHAR(16) NOT NULL,
    event_id VARCHAR(64) NOT NULL,
    account_id TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    next_attempt_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, stream, event_id)
);
CREATE INDEX IF NOT EXISTS failed_events_due ON failed_events (consumer, next_attempt_at) WHERE next_attempt_at IS NOT NULL;

COMMIT;
