CREATE TABLE IF NOT EXISTS special_search_runs (
    run_id uuid PRIMARY KEY,
    started_at timestamptz NOT NULL DEFAULT NOW(),
    completed_at timestamptz,
    status text NOT NULL DEFAULT 'running',
    planned_search_terms integer NOT NULL DEFAULT 0,
    total_result_observations integer NOT NULL DEFAULT 0,
    total_unique_result_urls integer NOT NULL DEFAULT 0,
    total_existing_posts integer NOT NULL DEFAULT 0,
    total_cross_term_duplicates integer NOT NULL DEFAULT 0,
    total_new_candidates integer NOT NULL DEFAULT 0,
    total_inserted integer NOT NULL DEFAULT 0,
    total_failed integer NOT NULL DEFAULT 0,
    run_error text
);

CREATE TABLE IF NOT EXISTS special_search_term_runs (
    run_id uuid NOT NULL REFERENCES special_search_runs(run_id) ON DELETE CASCADE,
    search_term text NOT NULL,
    source_kind text NOT NULL,
    expected_lead_types text[] NOT NULL DEFAULT ARRAY[]::text[],
    distance_miles integer,
    date_filter text,
    observations integer NOT NULL DEFAULT 0,
    unique_posts integer NOT NULL DEFAULT 0,
    existing_posts integer NOT NULL DEFAULT 0,
    cross_term_duplicates integer NOT NULL DEFAULT 0,
    fresh_candidates integer NOT NULL DEFAULT 0,
    inserted integer NOT NULL DEFAULT 0,
    failed integer NOT NULL DEFAULT 0,
    started_at timestamptz NOT NULL DEFAULT NOW(),
    completed_at timestamptz,
    PRIMARY KEY (run_id, search_term)
);

CREATE TABLE IF NOT EXISTS special_search_results (
    id bigserial PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES special_search_runs(run_id) ON DELETE CASCADE,
    search_term text NOT NULL,
    source_kind text NOT NULL,
    expected_lead_types text[] NOT NULL DEFAULT ARRAY[]::text[],
    result_position integer,
    post_url text NOT NULL,
    preview text,
    was_existing boolean NOT NULL DEFAULT false,
    cross_term_duplicate boolean NOT NULL DEFAULT false,
    inserted_new boolean NOT NULL DEFAULT false,
    inserted_lead_id bigint,
    scraper_error text,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    expires_at timestamptz NOT NULL DEFAULT (NOW() + INTERVAL '35 days'),
    UNIQUE (run_id, search_term, post_url)
);

CREATE INDEX IF NOT EXISTS special_search_results_term_created_idx
    ON special_search_results (search_term, created_at DESC);

CREATE INDEX IF NOT EXISTS special_search_results_post_url_idx
    ON special_search_results (post_url);

CREATE INDEX IF NOT EXISTS special_search_term_runs_term_started_idx
    ON special_search_term_runs (search_term, started_at DESC);
