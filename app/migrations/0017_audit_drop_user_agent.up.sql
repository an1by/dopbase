-- Nothing ever recorded a user agent, so the column only ever held NULL.
ALTER TABLE audit_events DROP COLUMN user_agent;
