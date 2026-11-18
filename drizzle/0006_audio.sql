ALTER TABLE `projects` ADD `music` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `sfx` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` ADD `loudness_lufs` real;