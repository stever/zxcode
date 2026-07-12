-- RFC 6238 one-time use: record the last accepted TOTP time step so a code
-- cannot be replayed within its verification window.
ALTER TABLE "user_otp" ADD COLUMN "last_used_step" INTEGER;
