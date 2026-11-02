CREATE TABLE `app_usage_day` (
	`app_id` text NOT NULL,
	`day` text NOT NULL,
	`organization_id` text NOT NULL,
	`requests` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`cached_input_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`errors` integer NOT NULL,
	PRIMARY KEY(`app_id`, `day`)
);
--> statement-breakpoint
CREATE INDEX `idx_app_usage_day_organization` ON `app_usage_day` (`organization_id`);--> statement-breakpoint
CREATE TABLE `app_usage_day_window` (
	`id` integer PRIMARY KEY NOT NULL,
	`sealed_from` text NOT NULL,
	`sealed_until` text NOT NULL,
	CONSTRAINT "app_usage_day_window_singleton_check" CHECK("app_usage_day_window"."id" = 1),
	CONSTRAINT "app_usage_day_window_order_check" CHECK("app_usage_day_window"."sealed_from" <= "app_usage_day_window"."sealed_until")
);
--> statement-breakpoint
-- Hand-written below: drizzle-kit generates neither data copies nor triggers,
-- and a regenerated file must keep these.
--
-- Sealed days answer from `app_usage_day`; every other day from raw events or
-- the rollup. A row of a sealed day must equal its raw events at all times, so
-- these three triggers move it whenever an event of a sealed day changes:
-- a straggler inserted after its day was sealed, a repricing, a deletion.
-- They write nothing for an event of an unsealed day, which is every event a
-- proxied request records: today is never sealed, so the request path pays
-- one window lookup and no write.
CREATE TRIGGER app_usage_day_after_insert
AFTER INSERT ON app_usage_event
WHEN EXISTS (SELECT 1 FROM app_usage_day_window AS w
	WHERE substr(NEW.created_at, 1, 10) >= w.sealed_from
		AND substr(NEW.created_at, 1, 10) < w.sealed_until)
BEGIN
	INSERT INTO app_usage_day(
		app_id, day, organization_id, requests, input_tokens, cached_input_tokens,
		cache_write_tokens, output_tokens, cost_usd, errors
	) VALUES (
		NEW.app_id, substr(NEW.created_at, 1, 10), NEW.organization_id, 1,
		NEW.input_tokens, NEW.cached_input_tokens, NEW.cache_write_tokens,
		NEW.output_tokens, NEW.cost_usd, NEW.status = 'provider_error'
	)
	ON CONFLICT(app_id, day) DO UPDATE SET
		requests = requests + excluded.requests,
		input_tokens = input_tokens + excluded.input_tokens,
		cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
		cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
		output_tokens = output_tokens + excluded.output_tokens,
		cost_usd = cost_usd + excluded.cost_usd,
		errors = errors + excluded.errors;
END;--> statement-breakpoint
-- Compaction deletes only days below the window, because the nightly run
-- raises the window past the retention cutoff first, so this fires for a
-- sealed day only when something else removes its events.
CREATE TRIGGER app_usage_day_after_delete
AFTER DELETE ON app_usage_event
WHEN EXISTS (SELECT 1 FROM app_usage_day_window AS w
	WHERE substr(OLD.created_at, 1, 10) >= w.sealed_from
		AND substr(OLD.created_at, 1, 10) < w.sealed_until)
BEGIN
	UPDATE app_usage_day SET
		requests = requests - 1,
		input_tokens = input_tokens - OLD.input_tokens,
		cached_input_tokens = cached_input_tokens - OLD.cached_input_tokens,
		cache_write_tokens = cache_write_tokens - OLD.cache_write_tokens,
		output_tokens = output_tokens - OLD.output_tokens,
		cost_usd = cost_usd - OLD.cost_usd,
		errors = errors - (OLD.status = 'provider_error')
	WHERE app_id = OLD.app_id AND day = substr(OLD.created_at, 1, 10);
END;--> statement-breakpoint
-- Repricing changes cost_usd; nothing in the gateway changes the other
-- columns, but the old row is taken out and the new one put in so the totals
-- stay right whichever of them moves.
CREATE TRIGGER app_usage_day_after_update
AFTER UPDATE OF app_id, organization_id, created_at, input_tokens, cached_input_tokens,
	cache_write_tokens, output_tokens, cost_usd, status ON app_usage_event
WHEN EXISTS (SELECT 1 FROM app_usage_day_window AS w
	WHERE (substr(OLD.created_at, 1, 10) >= w.sealed_from
			AND substr(OLD.created_at, 1, 10) < w.sealed_until)
		OR (substr(NEW.created_at, 1, 10) >= w.sealed_from
			AND substr(NEW.created_at, 1, 10) < w.sealed_until))
BEGIN
	UPDATE app_usage_day SET
		requests = requests - 1,
		input_tokens = input_tokens - OLD.input_tokens,
		cached_input_tokens = cached_input_tokens - OLD.cached_input_tokens,
		cache_write_tokens = cache_write_tokens - OLD.cache_write_tokens,
		output_tokens = output_tokens - OLD.output_tokens,
		cost_usd = cost_usd - OLD.cost_usd,
		errors = errors - (OLD.status = 'provider_error')
	WHERE app_id = OLD.app_id AND day = substr(OLD.created_at, 1, 10)
		AND EXISTS (SELECT 1 FROM app_usage_day_window AS w
			WHERE substr(OLD.created_at, 1, 10) >= w.sealed_from
				AND substr(OLD.created_at, 1, 10) < w.sealed_until);

	INSERT INTO app_usage_day(
		app_id, day, organization_id, requests, input_tokens, cached_input_tokens,
		cache_write_tokens, output_tokens, cost_usd, errors
	)
	SELECT
		NEW.app_id, substr(NEW.created_at, 1, 10), NEW.organization_id, 1,
		NEW.input_tokens, NEW.cached_input_tokens, NEW.cache_write_tokens,
		NEW.output_tokens, NEW.cost_usd, NEW.status = 'provider_error'
	WHERE EXISTS (SELECT 1 FROM app_usage_day_window AS w
		WHERE substr(NEW.created_at, 1, 10) >= w.sealed_from
			AND substr(NEW.created_at, 1, 10) < w.sealed_until)
	ON CONFLICT(app_id, day) DO UPDATE SET
		requests = requests + excluded.requests,
		input_tokens = input_tokens + excluded.input_tokens,
		cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
		cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
		output_tokens = output_tokens + excluded.output_tokens,
		cost_usd = cost_usd + excluded.cost_usd,
		errors = errors + excluded.errors;
END;--> statement-breakpoint
-- The window starts at the retention cutoff, the floor the nightly run keeps
-- it at, and is sealed right away up to today when the database is small
-- enough to sum in one statement; otherwise it starts empty and the nightly
-- run seals forward a bounded number of days at a time, each unsealed day read
-- from its raw events meanwhile. Summing every retained event at once could
-- reach D1's 30s statement limit on a busy deployment and fail the migration.
--
-- Small is judged by the span of event ids, which SQLite reads from the two
-- ends of the table rather than by scanning it, and which is never less than
-- the number of events. A quarter of a million events sums in about a second.
--
-- The sum is driven from the window row (CROSS JOIN fixes that order), so an
-- empty window finds no row to start from and reads no events at all.
--
-- The window goes in first: an event landing for a sealed day between the two
-- statements — were they ever not one transaction — would make its day row
-- through the trigger and fail the insert below, rather than be missed.
INSERT INTO app_usage_day_window(id, sealed_from, sealed_until)
SELECT 1, date('now', '-90 days'),
	CASE WHEN (SELECT COALESCE(MAX(id) - MIN(id), 0) FROM app_usage_event) < 250000
		THEN date('now') ELSE date('now', '-90 days') END;--> statement-breakpoint
INSERT INTO app_usage_day(
	app_id, day, organization_id, requests, input_tokens, cached_input_tokens,
	cache_write_tokens, output_tokens, cost_usd, errors
)
SELECT
	events.app_id, substr(events.created_at, 1, 10), events.organization_id, COUNT(*),
	SUM(events.input_tokens), SUM(events.cached_input_tokens), SUM(events.cache_write_tokens),
	SUM(events.output_tokens), SUM(events.cost_usd), SUM(events.status = 'provider_error')
FROM app_usage_day_window AS w
CROSS JOIN app_usage_event AS events
WHERE w.id = 1 AND w.sealed_until > w.sealed_from
	AND events.created_at >= w.sealed_from AND events.created_at < w.sealed_until
GROUP BY events.organization_id, events.app_id, substr(events.created_at, 1, 10);
