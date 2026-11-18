CREATE TABLE `global_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`source` text DEFAULT 'upload' NOT NULL,
	`path` text NOT NULL,
	`duration` real DEFAULT 0 NOT NULL,
	`width` integer DEFAULT 0 NOT NULL,
	`height` integer DEFAULT 0 NOT NULL,
	`has_audio` integer DEFAULT false NOT NULL,
	`context` text DEFAULT '' NOT NULL,
	`project_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `global_assets_created_idx` ON `global_assets` (`created_at`);--> statement-breakpoint
CREATE INDEX `global_assets_kind_idx` ON `global_assets` (`kind`);--> statement-breakpoint
CREATE INDEX `global_assets_source_idx` ON `global_assets` (`source`);--> statement-breakpoint
CREATE INDEX `global_assets_path_idx` ON `global_assets` (`path`);