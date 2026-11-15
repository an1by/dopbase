import { ref } from "vue";
import { startSsoReauth } from "~/services/auth.api";
import { onReauthenticationRequired } from "~/services/http.client";
import { useAuthStore } from "~/stores/auth.store";

const isOpen = ref(false);
const error = ref<string | null>(null);
const submitting = ref(false);
/** True while a single sign-on popup is waiting for the user. */
const confirmingWithSso = ref(false);
/** Why the dialog is asking, when the caller says; otherwise a default. */
const reason = ref<string | null>(null);

interface PendingOperation {
  action: () => Promise<void>;
  resolve: () => void;
  reject: (cause: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

const pending: PendingOperation[] = [];

/** How often the page checks whether the popup confirmed the session. */
export const SSO_POLL_MS = 1000;
/** Give up after this long, in case the popup was left open. */
const SSO_TIMEOUT_MS = 5 * 60 * 1000;

/** Open the dialog. Requests that opt out of auth events call this. */
export function requestConfirmation(why: string | null = null): void {
  error.value = null;
  reason.value = why;
  isOpen.value = true;
  // Refresh which confirmations this account can use. Best effort: the
  // password form still shows if it fails.
  try {
    void useAuthStore()
      .fetchSession()
      .catch(() => undefined);
  } catch {
    // No active store outside the app, as in isolated tests.
  }
}

// One listener serves every caller. Mounting a panel no longer grows the
// HTTP client's global listener set.
onReauthenticationRequired(() => requestConfirmation());

function isChallenge(cause: unknown): boolean {
  return (
    cause instanceof Object &&
    "status" in cause &&
    (cause as { status: number }).status === 403 &&
    "hasCode" in cause &&
    (cause as { hasCode: (code: string) => boolean }).hasCode(
      "RECENT_AUTHENTICATION_REQUIRED",
    )
  );
}

/** The session itself ended, so confirming cannot help. */
function isSignedOut(cause: unknown): boolean {
  return (
    cause instanceof Object &&
    "status" in cause &&
    (cause as { status: number }).status === 401
  );
}

function cancellation(): DOMException {
  return new DOMException(
    "The reauthentication operation was cancelled.",
    "AbortError",
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useReauthentication() {
  const auth = useAuthStore();

  /** Close the dialog and re-run every action that was waiting for it. */
  async function resumePending(): Promise<void> {
    isOpen.value = false;
    const operations = pending.splice(0);
    await Promise.allSettled(
      operations.map(async (operation) => {
        if (operation.abort) {
          operation.signal?.removeEventListener("abort", operation.abort);
        }
        if (operation.signal?.aborted) {
          operation.reject(cancellation());
          return;
        }
        try {
          await operation.action();
          operation.resolve();
        } catch (cause) {
          operation.reject(cause);
        }
      }),
    );
  }

  /** Close the dialog and fail every waiting action with `cause`. */
  function rejectPending(cause: () => unknown): void {
    isOpen.value = false;
    error.value = null;
    for (const operation of pending.splice(0)) {
      if (operation.abort) {
        operation.signal?.removeEventListener("abort", operation.abort);
      }
      operation.reject(cause());
    }
  }

  async function submit(password: string): Promise<boolean> {
    submitting.value = true;
    error.value = null;
    try {
      await auth.reauthenticate(password);
    } catch (cause) {
      submitting.value = false;
      // A session that ended meanwhile is not a wrong password: hand the
      // 401 to the waiting actions so their page can send people to sign in.
      if (isSignedOut(cause)) rejectPending(() => cause);
      else error.value = "The password is incorrect.";
      return false;
    }
    submitting.value = false;
    await resumePending();
    return true;
  }

  /**
   * Confirm at the identity provider in a popup, for accounts without a
   * password. Call it straight from a click: the popup opens before any
   * request so browsers do not block it. The provider's redirect lands on a
   * page that closes the popup, and the session is polled meanwhile.
   */
  async function confirmWithSso(): Promise<boolean> {
    error.value = null;
    const popup = window.open(
      "about:blank",
      "dopbase-sso",
      "popup,width=520,height=700",
    );
    if (!popup) {
      error.value = "Allow pop-ups for this site, then try again.";
      return false;
    }
    confirmingWithSso.value = true;
    try {
      popup.location.href = await startSsoReauth();
      const deadline = Date.now() + SSO_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await wait(SSO_POLL_MS);
        const closed = popup.closed;
        await auth.fetchSession();
        if (auth.session?.recentAuthentication) {
          if (!popup.closed) popup.close();
          await resumePending();
          return true;
        }
        if (closed) {
          error.value =
            "The sign-in window closed before confirming. Try again.";
          return false;
        }
      }
      if (!popup.closed) popup.close();
      error.value = "Confirmation timed out. Try again.";
      return false;
    } catch (cause) {
      if (!popup.closed) popup.close();
      if (isSignedOut(cause)) rejectPending(() => cause);
      else error.value = "Could not start single sign-on. Try again.";
      return false;
    } finally {
      confirmingWithSso.value = false;
    }
  }

  function dismiss(): void {
    if (submitting.value || confirmingWithSso.value) return;
    rejectPending(cancellation);
  }

  /** Resolves only when the operation completes, including a parked retry. */
  async function runWithReauth(
    action: () => Promise<void>,
    signal?: AbortSignal,
    onPark?: () => void,
  ): Promise<void> {
    if (signal?.aborted) throw cancellation();
    try {
      await action();
    } catch (cause) {
      if (!isChallenge(cause)) throw cause;
      if (signal?.aborted) throw cancellation();
      onPark?.();
      await new Promise<void>((resolve, reject) => {
        const operation: PendingOperation = { action, resolve, reject, signal };
        if (signal) {
          operation.abort = () => {
            const index = pending.indexOf(operation);
            if (index >= 0) pending.splice(index, 1);
            reject(cancellation());
          };
          signal.addEventListener("abort", operation.abort, { once: true });
        }
        pending.push(operation);
      });
    }
  }

  return {
    isOpen,
    error,
    reason,
    submitting,
    confirmingWithSso,
    submit,
    confirmWithSso,
    dismiss,
    runWithReauth,
  };
}
