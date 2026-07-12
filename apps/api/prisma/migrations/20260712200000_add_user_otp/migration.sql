-- Authenticator-app (TOTP) second factor for the magic-link login.
-- user_otp: one row per user; enabled NULL = pending enrolment (secret issued,
-- first valid code not yet entered), enabled set = logins must pass the OTP
-- challenge. otp_recovery_code: single-use fallback codes, SHA-256 hex hashes
-- only, consumed by an atomic conditional UPDATE like login_token.

CREATE TABLE public.user_otp (
    user_id uuid NOT NULL,
    secret character varying(64) NOT NULL,
    created timestamp(6) with time zone NOT NULL,
    enabled timestamp(6) with time zone,
    CONSTRAINT user_otp_pkey PRIMARY KEY (user_id),
    CONSTRAINT user_otp_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES public."user"(user_id) ON UPDATE CASCADE ON DELETE CASCADE
);
COMMENT ON TABLE public.user_otp IS 'TOTP second factor; enabled NULL = pending enrolment';

CREATE TABLE public.otp_recovery_code (
    recovery_code_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    code_hash character varying(64) NOT NULL,
    created timestamp(6) with time zone NOT NULL,
    used timestamp(6) with time zone,
    CONSTRAINT otp_recovery_code_pkey PRIMARY KEY (recovery_code_id),
    CONSTRAINT otp_recovery_code_hash_key UNIQUE (code_hash),
    CONSTRAINT otp_recovery_code_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES public."user"(user_id) ON UPDATE CASCADE ON DELETE CASCADE
);
COMMENT ON TABLE public.otp_recovery_code IS 'Single-use OTP recovery codes (SHA-256 hash only)';

CREATE INDEX idx_otp_recovery_code_user ON public.otp_recovery_code(user_id);
