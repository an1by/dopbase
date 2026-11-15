import { apiRequest } from "./http.client";

/** What restoring a Dopbase 0.1.x backup changed on the way in. */
export interface UpgradeReport {
  upgradedFrom: string;
  tables: Record<string, number>;
  dropped: { table: string; rows: number; reason: string }[];
  changed: { table: string; rows: number; reason: string }[];
  archivedAuditRecords: number;
  auditArchive?: string | null;
}

export interface BackupItem {
  key: string;
  size: number;
  createdAt: string;
  /** Set when the uploaded file came from 0.1.x and was upgraded. */
  upgrade?: UpgradeReport;
}

interface RawBackupItem {
  key: string;
  size: number;
  created_at: string;
  upgrade?: UpgradeReport;
}

/** One sentence on what upgrading a 0.1.x backup did. */
export function upgradeSummary(report: UpgradeReport): string {
  const count = (notes: UpgradeReport["dropped"]) =>
    notes.reduce((total, note) => total + note.rows, 0);
  const parts = [
    `${count(report.dropped)} rows left out`,
    `${count(report.changed)} values changed`,
  ];
  if (report.archivedAuditRecords > 0) {
    parts.push(
      `${report.archivedAuditRecords} audit records from before the hash chain archived`,
    );
  }
  return `It was made by Dopbase 0.1.x and upgraded: ${parts.join(", ")}. Restoring it signs everyone out.`;
}

export async function fetchBackups(
  signal?: AbortSignal,
): Promise<BackupItem[]> {
  const result = await apiRequest<RawBackupItem[]>("/api/v1/backups", {
    signal,
  });
  return (result.data || []).map((item) => ({
    key: item.key,
    size: item.size,
    createdAt: item.created_at,
  }));
}

export async function createBackup(name?: string): Promise<BackupItem> {
  const result = await apiRequest<RawBackupItem>("/api/v1/backups", {
    method: "POST",
    body: { name: name?.trim() ? name.trim() : undefined },
  });
  return {
    key: result.data.key,
    size: result.data.size,
    createdAt: result.data.created_at,
    upgrade: result.data.upgrade,
  };
}

export async function uploadBackup(
  file: File,
  masterKey?: File | string,
): Promise<BackupItem> {
  const formData = new FormData();
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
  const result = await apiRequest<RawBackupItem>("/api/v1/backups/upload", {
    method: "POST",
    body: formData,
  });
  return {
    key: result.data.key,
    size: result.data.size,
    createdAt: result.data.created_at,
    upgrade: result.data.upgrade,
  };
}

export async function restoreBackup(
  key: string,
  masterKey?: string,
): Promise<void> {
  await apiRequest(`/api/v1/backups/${encodeURIComponent(key)}/restore`, {
    method: "POST",
    body: masterKey ? { master_key: masterKey.trim() } : undefined,
  });
}

export async function deleteBackup(key: string): Promise<void> {
  await apiRequest(`/api/v1/backups/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

export function downloadBackupUrl(key: string): string {
  return `/api/v1/backups/${encodeURIComponent(key)}`;
}

export async function downloadMasterKeyBlob(): Promise<Blob> {
  const result = await apiRequest<Blob>("/api/v1/backups/master-key", {
    method: "GET",
    responseType: "blob",
  });
  return result.data;
}
