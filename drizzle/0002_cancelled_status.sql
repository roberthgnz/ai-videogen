-- Renders stopped by the user used to be stored as errors.
UPDATE `videos` SET `status` = 'cancelled', `error` = NULL WHERE `status` = 'error' AND `error` = 'Render cancelado.';
