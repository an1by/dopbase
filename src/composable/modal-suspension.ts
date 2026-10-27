import { ref } from "vue";

/**
 * Hides every dialog except the session layer while the browser session is
 * gone. A save that fails because the session expired must not leave its
 * form on screen above, or in place of, the "Session expired" dialog.
 *
 * Set by the dashboard shell from the auth store, so the dialog primitive
 * itself stays free of store access.
 */
export const modalsSuspended = ref(false);
