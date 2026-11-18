CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`topic` text DEFAULT '' NOT NULL,
	`target_duration_sec` integer DEFAULT 45 NOT NULL,
	`tone` text DEFAULT 'informativo' NOT NULL,
	`format` text DEFAULT 'vertical' NOT NULL,
	`voice_id` text,
	`script_status` text DEFAULT 'idle' NOT NULL,
	`script_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`position` integer NOT NULL,
	`template` text NOT NULL,
	`narration` text DEFAULT '' NOT NULL,
	`content` text DEFAULT '{}' NOT NULL,
	`tts_status` text DEFAULT 'idle' NOT NULL,
	`tts_error` text,
	`audio_hash` text,
	`audio_path` text,
	`audio_duration_sec` real,
	`words` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scenes_project_position_idx` ON `scenes` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `videos` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text,
	`progress` real DEFAULT 0 NOT NULL,
	`format` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`expected_duration_sec` real,
	`duration_sec` real,
	`build_dir` text,
	`output_path` text,
	`error` text,
	`log` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `videos_project_created_idx` ON `videos` (`project_id`,`created_at`);