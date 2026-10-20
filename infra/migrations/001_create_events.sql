CREATE TABLE events (
    event_id UUID PRIMARY KEY,
    event_type TEXT NOT NULL,
    source TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL,
    stored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);