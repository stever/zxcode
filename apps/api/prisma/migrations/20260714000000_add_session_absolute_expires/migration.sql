-- Sliding session expiry: `expires` becomes the idle deadline (extended on
-- access by the auth service), `absolute_expires` the hard cap set at login
-- that renewal never pushes past. Existing rows get cap = current expiry,
-- so pre-migration sessions keep their original fixed lifetime.
ALTER TABLE "session" ADD COLUMN "absolute_expires" TIMESTAMPTZ(6);
UPDATE "session" SET "absolute_expires" = "expires";
ALTER TABLE "session" ALTER COLUMN "absolute_expires" SET NOT NULL;
