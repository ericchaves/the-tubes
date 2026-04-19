/**
 * This file is intentionally empty.
 *
 * The premature-local-data scenario tested here has been eliminated by the
 * on-demand socket architecture (the-tubes v2).  Local sockets are now opened
 * only after the server sends pair.open, so there is no longer any speculative
 * local connection that could be poisoned by early data from a previous request.
 *
 * The original test validated a data-poisoning guard that no longer exists in
 * the codebase.  Keeping it here as a documented tombstone avoids confusion if
 * the file appears in git history.
 */
