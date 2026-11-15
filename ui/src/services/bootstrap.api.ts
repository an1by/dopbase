import { apiRequest } from "./http.client";

/**
 * Public bootstrap state. Only `setupRequired` or `ready` is ever revealed.
 * anything else is normalized to `ready`.
 */
export interface BootstrapStatus {
  state: string;
}

export interface BootstrapAdminRequest {
  setupToken: string;
  email: string;
  password: string;
}

export interface BootstrapAdminResponse {
  adminId: string;
  email: string;
  csrfToken: string;
  role?: "root" | "admin";
  lastLoginAt?: string | null;
}

const BASE = "/api/v1/bootstrap";

export async function fetchBootstrapStatus(): Promise<BootstrapStatus> {
  const { data } = await apiRequest<BootstrapStatus>(`${BASE}/status`);
  return data;
}

/** Claims an uninitialized server. Starts the returned browser session. */
export async function bootstrapAdmin(
  request: BootstrapAdminRequest,
): Promise<BootstrapAdminResponse> {
  const { data } = await apiRequest<BootstrapAdminResponse>(`${BASE}/admin`, {
    method: "POST",
    body: {
      setupToken: request.setupToken,
      email: request.email,
      password: request.password,
    },
    anonymous: true,
  });
  return data;
}

export interface BootstrapRestoreResponse {
  message: string;
  restored: boolean;
  key: string;
  size: number;
  /** Set when the backup came from 0.1.x and was upgraded. */
  upgrade?: import("./backups.api").UpgradeReport;
}

/** Restores an uninitialized server from an encrypted .dop backup file and optional master key. */
export async function bootstrapRestore(
  file: File,
  setupToken: string,
  masterKey?: File | string,
): Promise<BootstrapRestoreResponse> {
  // The token goes before the file: the server checks it before reading
  // the upload.
  const formData = new FormData();
  formData.append("setup_token", setupToken.trim());
  formData.append("file", file);
  if (masterKey) {
    if (typeof masterKey === "string") {
      formData.append(
        "master_key",
        new Blob([masterKey.trim()], { type: "text/plain" }),
        "master.key",
      );
    } else {
      formData.append("master_key", masterKey);
    }
  }
  const { data } = await apiRequest<BootstrapRestoreResponse>(
    `${BASE}/restore`,
    {
      method: "POST",
      body: formData,
      anonymous: true,
    },
  );
  return data;
}
