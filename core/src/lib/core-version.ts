/**
 * The version of the core's HTTP contract (the `/api/**` surface the public
 * shell and `@spectre/sdk` talk to). Bump this on any breaking change to that
 * contract; the shell pins to it and `/api/health` reports it so a mismatched
 * shell/core pair can be detected at startup.
 */
export const CORE_API_VERSION = 1;
