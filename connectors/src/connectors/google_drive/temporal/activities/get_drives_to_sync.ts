import { getGoogleDriveObject } from "@connectors/connectors/google_drive/lib/google_drive_api";
import { GOOGLE_DRIVE_USER_SPACE_VIRTUAL_DRIVE_ID } from "@connectors/connectors/google_drive/lib/consts";
import {
  GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS,
  GDRIVE_MAX_INCREMENTAL_SYNC_INTERVAL_MS,
} from "@connectors/connectors/google_drive/temporal/config";
import type { LightGoogleDrive } from "@connectors/connectors/google_drive/temporal/activities/common/types";
import { getDrives } from "@connectors/connectors/google_drive/temporal/activities/common/utils";
import { getAuthObject } from "@connectors/connectors/google_drive/temporal/utils";
import {
  GoogleDriveFoldersModel,
  GoogleDriveSyncTokenModel,
} from "@connectors/lib/models/google_drive";
import { ConnectorResource } from "@connectors/resources/connector_resource";
import type { ModelId } from "@connectors/types";

const GDRIVE_QUIET_DRIVE_BACKOFF_MULTIPLIER = 2;

type GoogleDriveIncrementalSyncDrive = {
  id: string;
  isShared: boolean;
};

type GoogleDriveIncrementalSyncPlan = {
  candidateDrives: GoogleDriveIncrementalSyncDrive[];
  drivesToSync: GoogleDriveIncrementalSyncDrive[];
  includesAllCandidateDrives: boolean;
};

export function getGoogleDriveIncrementalSyncIntervalMs({
  lastSyncAt,
  lastRelevantChangeAt,
}: {
  lastSyncAt: Date;
  lastRelevantChangeAt: Date;
}) {
  const intervalMs =
    GDRIVE_QUIET_DRIVE_BACKOFF_MULTIPLIER *
    (lastSyncAt.getTime() - lastRelevantChangeAt.getTime());

  return Math.min(
    Math.max(intervalMs, GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS),
    GDRIVE_MAX_INCREMENTAL_SYNC_INTERVAL_MS
  );
}

export function shouldSyncGoogleDrive({
  lastSyncAt,
  lastRelevantChangeAt,
  now,
}: {
  lastSyncAt: Date | null;
  lastRelevantChangeAt: Date | null;
  now: Date;
}) {
  if (!lastSyncAt || !lastRelevantChangeAt) {
    return true;
  }

  const intervalMs = getGoogleDriveIncrementalSyncIntervalMs({
    lastSyncAt,
    lastRelevantChangeAt,
  });

  return now.getTime() - lastSyncAt.getTime() >= intervalMs;
}

// Get the list of drives that have folders selected for sync.
export async function getDrivesToSync(
  connectorId: ModelId
): Promise<LightGoogleDrive[]> {
  const selectedFolders = await GoogleDriveFoldersModel.findAll({
    where: {
      connectorId: connectorId,
    },
  });
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }
  const allSharedDrives = await getDrives(connectorId);
  const authCredentials = await getAuthObject(connector.connectionId);
  const drives: Record<string, LightGoogleDrive> = {};

  for (const folder of selectedFolders) {
    const remoteFolder = await getGoogleDriveObject({
      connectorId,
      authCredentials,
      driveObjectId: folder.folderId,
    });
    if (remoteFolder) {
      if (!remoteFolder.driveId) {
        throw new Error(`Folder ${folder.folderId} does not have a driveId.`);
      }
      // A selected folder can be in a shared drive we don't have access to,
      // so we need to filter them out.
      // This is the case for files "shared with me" for example.
      if (allSharedDrives.find((d) => d.id === remoteFolder.driveId)) {
        drives[remoteFolder.driveId] = {
          id: remoteFolder.driveId,
          name: remoteFolder.name,
          isSharedDrive: remoteFolder.isInSharedDrive,
        };
      }
    }
  }

  return Object.values(drives);
}

export async function getDrivesDueForSync(
  connectorId: ModelId,
  nowMs = Date.now()
): Promise<GoogleDriveIncrementalSyncPlan> {
  const drives = await getDrivesToSync(connectorId);
  const candidateDrives = drives
    .map((drive) => ({
      id: drive.id,
      isShared: drive.isSharedDrive,
    }))
    .concat({
      id: GOOGLE_DRIVE_USER_SPACE_VIRTUAL_DRIVE_ID,
      isShared: false,
    });

  // Uses the existing unique (connectorId, driveId) index and only fetches
  // candidate drive tokens.
  const syncTokens = await GoogleDriveSyncTokenModel.findAll({
    where: {
      connectorId,
      driveId: candidateDrives.map((drive) => drive.id),
    },
  });
  const syncTokenByDriveId = new Map(
    syncTokens.map((syncToken) => [syncToken.driveId, syncToken])
  );
  const now = new Date(nowMs);

  const drivesToSync = candidateDrives.filter((drive) => {
    const syncToken = syncTokenByDriveId.get(drive.id);
    if (!syncToken) {
      return true;
    }

    return shouldSyncGoogleDrive({
      lastSyncAt: syncToken.lastSyncAt,
      lastRelevantChangeAt: syncToken.lastRelevantChangeAt,
      now,
    });
  });

  return {
    candidateDrives,
    drivesToSync,
    includesAllCandidateDrives: drivesToSync.length === candidateDrives.length,
  };
}
