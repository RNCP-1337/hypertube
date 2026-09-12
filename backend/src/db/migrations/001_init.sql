-- Hypertube initial schema

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- users
CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    username        CITEXT      NOT NULL UNIQUE
                    CHECK (username ~ '^[A-Za-z0-9_.-]{3,20}$'),
    email           CITEXT      NOT NULL UNIQUE
                    CHECK (position('@' IN email) > 1 AND length(email) <= 254),
    first_name      TEXT        NOT NULL CHECK (length(first_name) BETWEEN 1 AND 50),
    last_name       TEXT        NOT NULL CHECK (length(last_name)  BETWEEN 1 AND 50),
    -- NULL when the account was created through OmniAuth only
    password_hash   TEXT,
    avatar_path     TEXT,
    language        TEXT        NOT NULL DEFAULT 'en' CHECK (language IN ('en','fr','es')),
    email_verified  BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OmniAuth identities
CREATE TABLE IF NOT EXISTS oauth_identities (
    id               BIGSERIAL PRIMARY KEY,
    user_id          BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider         TEXT        NOT NULL CHECK (provider IN ('42','google','github','discord')),
    provider_user_id TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities(user_id);

-- password reset flow
CREATE TABLE IF NOT EXISTS password_resets (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- SHA-256 digest, never the token itself
    token_hash  TEXT        NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

-- refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT        NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- OAuth2 clients for the REST API
CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id      TEXT PRIMARY KEY,
    client_secret  TEXT        NOT NULL,
    name           TEXT        NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
    code_hash   TEXT PRIMARY KEY,
    client_id   TEXT        NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT       NOT NULL,
    scope       TEXT        NOT NULL DEFAULT 'read',
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- movies
CREATE TABLE IF NOT EXISTS movies (
    id            BIGSERIAL PRIMARY KEY,
    source        TEXT        NOT NULL,          -- 'archive' | 'publicdomain'
    source_id     TEXT        NOT NULL,
    title         TEXT        NOT NULL,
    slug          TEXT        NOT NULL,
    year          INTEGER,
    rating        NUMERIC(3,1),                  -- IMDb / TMDb grade, 0.0 - 10.0
    runtime       INTEGER,                       -- minutes
    summary       TEXT,
    cover_url     TEXT,
    backdrop_url  TEXT,
    genres        TEXT[]      NOT NULL DEFAULT '{}',
    cast_members  TEXT[]      NOT NULL DEFAULT '{}',
    director      TEXT,
    producer      TEXT,
    imdb_id       TEXT,
    tmdb_id       INTEGER,
    language      TEXT,                          -- original audio language
    popularity    DOUBLE PRECISION NOT NULL DEFAULT 0,  -- seeders / downloads
    metadata_fetched_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_movies_title_trgm  ON movies USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_movies_year        ON movies(year);
CREATE INDEX IF NOT EXISTS idx_movies_rating      ON movies(rating);
CREATE INDEX IF NOT EXISTS idx_movies_popularity  ON movies(popularity DESC);
CREATE INDEX IF NOT EXISTS idx_movies_genres      ON movies USING gin (genres);

-- torrents attached to each movie
-- one row per available quality
CREATE TABLE IF NOT EXISTS movie_torrents (
    id          BIGSERIAL PRIMARY KEY,
    movie_id    BIGINT      NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
    quality     TEXT        NOT NULL DEFAULT 'unknown',
    container   TEXT,
    size_bytes  BIGINT,
    seeders     INTEGER     NOT NULL DEFAULT 0,
    leechers    INTEGER     NOT NULL DEFAULT 0,
    info_hash   TEXT,                            -- hex, 40 chars, when known
    magnet_uri  TEXT,
    torrent_url TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_movie_torrents_movie ON movie_torrents(movie_id);
-- Expression-based uniqueness (a table constraint cannot hold COALESCE).
CREATE UNIQUE INDEX IF NOT EXISTS uq_movie_torrents_variant
    ON movie_torrents (movie_id, quality, COALESCE(info_hash, ''));

-- download / cache state
CREATE TABLE IF NOT EXISTS downloads (
    info_hash        TEXT PRIMARY KEY CHECK (info_hash ~ '^[0-9a-f]{40}$'),
    movie_id         BIGINT      REFERENCES movies(id) ON DELETE SET NULL,
    torrent_id       BIGINT      REFERENCES movie_torrents(id) ON DELETE SET NULL,
    file_path        TEXT,                       -- largest video file on disk
    file_name        TEXT,
    total_bytes      BIGINT      NOT NULL DEFAULT 0,
    downloaded_bytes BIGINT      NOT NULL DEFAULT 0,
    status           TEXT        NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','downloading','ready','completed','error','removed')),
    error_message    TEXT,
    peers            INTEGER     NOT NULL DEFAULT 0,
    download_rate    BIGINT      NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ,
    -- retention clock
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_downloads_last_accessed ON downloads(last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_downloads_movie ON downloads(movie_id);

-- subtitles
CREATE TABLE IF NOT EXISTS subtitles (
    id          BIGSERIAL PRIMARY KEY,
    movie_id    BIGINT      NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
    language    TEXT        NOT NULL,
    label       TEXT        NOT NULL,
    file_path   TEXT        NOT NULL,           -- WebVTT on disk
    source      TEXT        NOT NULL DEFAULT 'embedded',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (movie_id, language, source)
);
CREATE INDEX IF NOT EXISTS idx_subtitles_movie ON subtitles(movie_id);

-- comments
CREATE TABLE IF NOT EXISTS comments (
    id          BIGSERIAL PRIMARY KEY,
    movie_id    BIGINT      NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
    user_id     BIGINT      NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    content     TEXT        NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 2000),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_movie   ON comments(movie_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at DESC);

-- watch history
CREATE TABLE IF NOT EXISTS watch_history (
    user_id      BIGINT      NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    movie_id     BIGINT      NOT NULL REFERENCES movies(id)  ON DELETE CASCADE,
    position_sec INTEGER     NOT NULL DEFAULT 0,
    completed    BOOLEAN     NOT NULL DEFAULT FALSE,
    watched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, movie_id)
);
CREATE INDEX IF NOT EXISTS idx_watch_history_movie ON watch_history(movie_id);

-- updated_at trigger
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_touch    ON users;
DROP TRIGGER IF EXISTS movies_touch   ON movies;
DROP TRIGGER IF EXISTS comments_touch ON comments;

CREATE TRIGGER users_touch    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER movies_touch   BEFORE UPDATE ON movies
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER comments_touch BEFORE UPDATE ON comments
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
