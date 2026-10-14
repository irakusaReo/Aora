-- CONTRACT migration (owner approval of 2026-10-13, for these three tables only).
--
-- Drops tables retired when sign-in moved to Clerk (ADR 0019): AORA's own
-- one-time codes, sessions and simulated SMS. They hold only sandbox data. No
-- code has read or written them since the release that introduced Clerk, which
-- is what is running on staging, so dropping them cannot break a running release.

drop table identity.auth_challenge;
drop table identity.session;
drop table sim.sim_sms;
