-- Pending magic-link login tokens for the passwordless email login flow.
-- No FK to "user": a token can be issued for an email address with no account
-- yet (the user is provisioned when the link is followed). Only a SHA-256 hex
-- hash of the token is stored, so a database read does not yield usable links.
-- A token is single-use: consumption is an atomic conditional UPDATE setting
-- "consumed" where it is still NULL and "expires" is in the future.

CREATE TABLE public.login_token (
    login_token_id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    token_hash character varying(64) NOT NULL,
    redirect_url text,
    created timestamp(6) with time zone NOT NULL,
    expires timestamp(6) with time zone NOT NULL,
    consumed timestamp(6) with time zone,
    CONSTRAINT login_token_pkey PRIMARY KEY (login_token_id),
    CONSTRAINT login_token_hash_key UNIQUE (token_hash)
);
COMMENT ON TABLE public.login_token IS 'Pending magic-link login tokens (SHA-256 hash only, single-use)';

-- Used when invalidating an email''s prior pending tokens on each new request.
CREATE INDEX idx_login_token_email ON public.login_token(email);

-- Magic-link logins look users up by email, always lowercased. Normalise the
-- existing rows once; fail loudly if two users' emails differ only by case
-- (must be resolved by hand before this migration can apply).
DO $$
BEGIN
    IF EXISTS (
        SELECT lower(email_address)
        FROM public."user"
        WHERE email_address IS NOT NULL
        GROUP BY lower(email_address)
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'user emails differing only by case exist; resolve duplicates before migrating';
    END IF;
END $$;

UPDATE public."user"
SET email_address = lower(email_address)
WHERE email_address IS NOT NULL AND email_address <> lower(email_address);
