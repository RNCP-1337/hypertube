-- identify a torrent by its source url/magnet, not info_hash - keying the
-- upsert on info_hash was creating a duplicate row once the hash got filled in

DELETE FROM movie_torrents t
      USING movie_torrents keep
      WHERE t.movie_id = keep.movie_id
        AND COALESCE(t.torrent_url, t.magnet_uri, '') = COALESCE(keep.torrent_url, keep.magnet_uri, '')
        AND t.id > keep.id;

DROP INDEX IF EXISTS uq_movie_torrents_variant;

CREATE UNIQUE INDEX IF NOT EXISTS uq_movie_torrents_source
    ON movie_torrents (movie_id, COALESCE(torrent_url, magnet_uri, ''));
