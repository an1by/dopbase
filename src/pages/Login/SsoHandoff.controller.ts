import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "~/stores/auth.store";
import { isSafeRedirect } from "~/utils/validation";

/**
 * Single sign-on handoff: the provider callback lands here with a one-time
 * code in the URL fragment. The fragment never reaches the server or its
 * logs. The controller removes it from the address bar, trades it for a
 * session, and continues to where the sign-in started.
 */
export function useSsoHandoffController() {
  const router = useRouter();
  const auth = useAuthStore();
  const error = ref<string | null>(null);

  function takeCode(): string | null {
    const match = /(?:^#|&)code=([^&]+)/.exec(window.location.hash);
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname,
    );
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }

  async function complete(): Promise<void> {
    const code = takeCode();
    if (!code) {
      error.value = "This sign-in link is incomplete. Start again.";
      return;
    }
    try {
      const redirect = await auth.completeSso(code);
      await router.replace(
        redirect && isSafeRedirect(redirect) ? redirect : { name: "projects" },
      );
    } catch {
      error.value =
        "This sign-in expired or was opened in another browser. Start again.";
    }
  }

  onMounted(complete);

  return { error, complete };
}
