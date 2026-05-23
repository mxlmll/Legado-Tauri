import { invokeWithTimeout } from "./useInvoke";

export type BackupCategoryId =
  | "app_settings"
  | "reader_settings"
  | "bookshelf"
  | "bookshelf_cache"
  | "booksources"
  | "extensions"
  | "script_config"
  | "sync_state"
  | "user_fonts"
  | "other_frontend";

export interface BackupCategoryStat {
  id: BackupCategoryId;
  label: string;
  description: string;
  itemCount: number;
  byteSize: number;
}

export interface BackupInspectReport {
  categories: BackupCategoryStat[];
  totalBytes: number;
}

export interface BackupManifest {
  format: string;
  version: number;
  createdAt: number;
  appVersion: string;
  categories: BackupCategoryStat[];
}

export interface BackupCreateResult {
  outputPath: string;
  byteSize: number;
  categories: BackupCategoryStat[];
}

export interface BackupPeekReport {
  manifest: BackupManifest;
  unknownCategories: string[];
}

export interface BackupRestoreResult {
  restored: BackupCategoryStat[];
  skipped: string[];
}

const ALL_CATEGORIES: BackupCategoryId[] = [
  "app_settings",
  "reader_settings",
  "bookshelf",
  "bookshelf_cache",
  "booksources",
  "extensions",
  "script_config",
  "sync_state",
  "user_fonts",
  "other_frontend",
];

export function listAllBackupCategories(): BackupCategoryId[] {
  return [...ALL_CATEGORIES];
}

export async function inspectBackup(): Promise<BackupInspectReport> {
  return await invokeWithTimeout<BackupInspectReport>(
    "backup_inspect",
    {},
    60_000,
  );
}

export async function createBackup(
  outputPath: string,
  categories: BackupCategoryId[],
): Promise<BackupCreateResult> {
  return await invokeWithTimeout<BackupCreateResult>(
    "backup_create",
    { outputPath, categories },
    10 * 60_000,
  );
}

export async function peekBackup(zipPath: string): Promise<BackupPeekReport> {
  return await invokeWithTimeout<BackupPeekReport>(
    "backup_peek",
    { zipPath },
    60_000,
  );
}

export async function restoreBackup(
  zipPath: string,
  categories: BackupCategoryId[],
): Promise<BackupRestoreResult> {
  return await invokeWithTimeout<BackupRestoreResult>(
    "backup_restore",
    { zipPath, categories },
    10 * 60_000,
  );
}
