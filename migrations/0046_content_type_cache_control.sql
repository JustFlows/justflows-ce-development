-- Content-type response policy. NULL inherits site defaults.
ALTER TABLE content_types ADD COLUMN cache_control VARCHAR(512) NULL;
