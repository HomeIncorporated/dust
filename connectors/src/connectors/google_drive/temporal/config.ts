const GDRIVE_FULL_SYNC_QUEUE_VERSION = 6;
const GDRIVE_INCREMENTAL_SYNC_QUEUE_VERSION = 9;
const MINUTE_IN_MS = 60 * 1000;

export const GDRIVE_FULL_SYNC_QUEUE_NAME = `google-queue-fullsync-v${GDRIVE_FULL_SYNC_QUEUE_VERSION}`;
export const GDRIVE_INCREMENTAL_SYNC_QUEUE_NAME = `google-queue-incremental-v${GDRIVE_INCREMENTAL_SYNC_QUEUE_VERSION}`;

// Maximum number of folders to sync in parallel for parallel sync workflows.
export const GDRIVE_MAX_CONCURRENT_FOLDER_SYNCS = 5;

export const GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS = 5 * MINUTE_IN_MS;
export const GDRIVE_MAX_INCREMENTAL_SYNC_INTERVAL_MS = 20 * MINUTE_IN_MS;
