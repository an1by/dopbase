import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { fetchSsoIdentity, startSsoLink, unlinkSso } from "~/services/auth.api";
import { useReauthentication } from "~/composable/reauthentication";
import { useAuthStore } from "~/stores/auth.store";
import type { SsoIdentity } from "~/services/auth.api";
import { ApiError } from "~/services/http.client";
import { ssoErrorMessage } from "~/utils/sso";

/**
 * Account single sign-on card: shows whether this account is linked and
 * starts a link. Linking by hand covers sign-ins that cannot match by
 * email, such as an unverified email at the provider.
 */
export function useSsoLinkCardController() {
  const route = useRoute();
  const router = useRouter();
  const auth = useAuthStore();
  const { runWithReauth } = useReauthentication();
  const identity = ref<SsoIdentity | null>(null);
  const linking = ref(false);
  const unlinking = ref(false);
  /** Unlinking needs a password to fall back on. */
  const canUnlink = computed(
    () =>
      identity.value?.linked === true && auth.session?.hasPassword !== false,
  );
  const notice = ref<string | null>(null);
  const error = ref<string | null>(null);

  const visible = computed(
    () =>
      identity.value !== null &&
      (identity.value.available || identity.value.linked),
  );

  function readCallback(): void {
    if (route.query.sso === "linked") {
      notice.value = "Single sign-on is linked. You can use it to sign in.";
    }
    const message = ssoErrorMessage(route.query.sso_error);
    if (message) error.value = message;
    if (route.query.sso || route.query.sso_error) {
      void router.replace({ query: {} });
    }
  }

  async function load(): Promise<void> {
    try {
      identity.value = await fetchSsoIdentity();
    } catch {
      identity.value = null;
    }
  }

  async function link(): Promise<void> {
    error.value = null;
    linking.value = true;
    try {
      window.location.assign(await startSsoLink());
    } catch (cause) {
      error.value =
        cause instanceof ApiError
          ? cause.message
          : "Could not start linking. Try again.";
      linking.value = false;
    }
  }

  async function unlink(): Promise<void> {
    error.value = null;
    notice.value = null;
    unlinking.value = true;
    try {
      await runWithReauth(unlinkSso);
      notice.value = "Single sign-on is unlinked. Sign in with your password.";
      await load();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      error.value =
        cause instanceof ApiError
          ? cause.message
          : "Could not unlink. Try again.";
    } finally {
      unlinking.value = false;
    }
  }

  onMounted(() => {
    readCallback();
    void load();
  });

  return {
    identity,
    visible,
    linking,
    unlinking,
    canUnlink,
    notice,
    error,
    load,
    link,
    unlink,
  };
}
