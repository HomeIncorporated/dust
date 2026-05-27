import { randomUUID } from "node:crypto";

import { GOOGLE_DRIVE_USER_SPACE_VIRTUAL_DRIVE_ID } from "@connectors/connectors/google_drive/lib/consts";
import {
  GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS,
  GDRIVE_MAX_INCREMENTAL_SYNC_INTERVAL_MS,
} from "@connectors/connectors/google_drive/temporal/config";
import {
  GoogleDriveFoldersModel,
  GoogleDriveSyncTokenModel,
} from "@connectors/lib/models/google_drive";
import { ConnectorResource } from "@connectors/resources/connector_resource";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthObject: vi.fn(),
  getDrives: vi.fn(),
  getGoogleDriveObject: vi.fn(),
}));

vi.mock("@connectors/connectors/google_drive/lib/google_drive_api", () => ({
  getGoogleDriveObject: mocks.getGoogleDriveObject,
}));

vi.mock(
  "@connectors/connectors/google_drive/temporal/activities/common/utils",
  () => ({
    getDrives: mocks.getDrives,
  })
);

vi.mock("@connectors/connectors/google_drive/temporal/utils", () => ({
  getAuthObject: mocks.getAuthObject,
}));

import {
  getDrivesDueForSync,
  getGoogleDriveIncrementalSyncIntervalMs,
  shouldSyncGoogleDrive,
} from "./get_drives_to_sync";

const HALF_BASE_INTERVAL_MS = GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS / 2;
const DOUBLE_BASE_INTERVAL_MS = GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS * 2;
const HOUR_IN_MS = 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * HOUR_IN_MS;

async function makeConnector(suffix: string) {
  return ConnectorResource.makeNew(
    "google_drive",
    {
      connectionId: `connection-${suffix}`,
      dataSourceId: `data-source-${suffix}`,
      workspaceAPIKey: `api-key-${suffix}`,
      workspaceId: `workspace-${suffix}`,
    },
    {
      csvEnabled: false,
      largeFilesEnabled: false,
      pdfEnabled: false,
    }
  );
}

describe("google drive incremental sync cadence", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.getAuthObject.mockResolvedValue({});
  });

  it("computes the adaptive interval with base, backoff, and max cap", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    expect(
      getGoogleDriveIncrementalSyncIntervalMs({
        lastSyncAt: now,
        lastRelevantChangeAt: now,
      })
    ).toBe(GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS);

    expect(
      getGoogleDriveIncrementalSyncIntervalMs({
        lastSyncAt: new Date(now.getTime() - HALF_BASE_INTERVAL_MS),
        lastRelevantChangeAt: new Date(
          now.getTime() -
            HALF_BASE_INTERVAL_MS -
            GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS
        ),
      })
    ).toBe(DOUBLE_BASE_INTERVAL_MS);

    expect(
      getGoogleDriveIncrementalSyncIntervalMs({
        lastSyncAt: new Date(
          now.getTime() - GDRIVE_MAX_INCREMENTAL_SYNC_INTERVAL_MS
        ),
        lastRelevantChangeAt: new Date(now.getTime() - TWO_HOURS_MS),
      })
    ).toBe(GDRIVE_MAX_INCREMENTAL_SYNC_INTERVAL_MS);
  });

  it("respects missing timestamp, active, quiet, and capped states", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    expect(
      shouldSyncGoogleDrive({
        lastSyncAt: null,
        lastRelevantChangeAt: now,
        now,
      })
    ).toBe(true);
    expect(
      shouldSyncGoogleDrive({
        lastSyncAt: now,
        lastRelevantChangeAt: null,
        now,
      })
    ).toBe(true);
    expect(
      shouldSyncGoogleDrive({
        lastSyncAt: new Date(
          now.getTime() - GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS
        ),
        lastRelevantChangeAt: new Date(
          now.getTime() - GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS
        ),
        now,
      })
    ).toBe(true);
    expect(
      shouldSyncGoogleDrive({
        lastSyncAt: new Date(
          now.getTime() - GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS
        ),
        lastRelevantChangeAt: new Date(
          now.getTime() - DOUBLE_BASE_INTERVAL_MS
        ),
        now,
      })
    ).toBe(false);
    expect(
      shouldSyncGoogleDrive({
        lastSyncAt: new Date(
          now.getTime() - GDRIVE_MAX_INCREMENTAL_SYNC_INTERVAL_MS
        ),
        lastRelevantChangeAt: new Date(now.getTime() - TWO_HOURS_MS),
        now,
      })
    ).toBe(true);
  });

  it("returns userspace and only due shared drives", async () => {
    const suffix = randomUUID();
    const connector = await makeConnector(suffix);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const folderToDriveId = new Map([
      [`folder-active-${suffix}`, "drive-active"],
      [`folder-quiet-${suffix}`, "drive-quiet"],
      [`folder-missing-${suffix}`, "drive-missing"],
      [`folder-capped-${suffix}`, "drive-capped"],
    ]);

    await GoogleDriveFoldersModel.bulkCreate(
      [...folderToDriveId.keys()].map((folderId) => ({
        connectorId: connector.id,
        folderId,
      }))
    );

    mocks.getDrives.mockResolvedValue(
      [...folderToDriveId.values()].map((driveId) => ({
        id: driveId,
        name: driveId,
        isSharedDrive: true,
      }))
    );
    mocks.getGoogleDriveObject.mockImplementation(({ driveObjectId }) => {
      const driveId = folderToDriveId.get(driveObjectId);
      if (!driveId) {
        throw new Error(`Unexpected folder ${driveObjectId}`);
      }

      return {
        driveId,
        name: driveId,
        isInSharedDrive: true,
      };
    });

    await GoogleDriveSyncTokenModel.bulkCreate([
      {
        connectorId: connector.id,
        driveId: "drive-active",
        syncToken: "active-sync-token",
        lastSyncAt: new Date(
          now.getTime() - GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS
        ),
        lastRelevantChangeAt: new Date(
          now.getTime() - GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS
        ),
      },
      {
        connectorId: connector.id,
        driveId: "drive-quiet",
        syncToken: "quiet-sync-token",
        lastSyncAt: new Date(
          now.getTime() - GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS
        ),
        lastRelevantChangeAt: new Date(
          now.getTime() - DOUBLE_BASE_INTERVAL_MS
        ),
      },
      {
        connectorId: connector.id,
        driveId: "drive-capped",
        syncToken: "capped-sync-token",
        lastSyncAt: new Date(
          now.getTime() - GDRIVE_MAX_INCREMENTAL_SYNC_INTERVAL_MS
        ),
        lastRelevantChangeAt: new Date(now.getTime() - TWO_HOURS_MS),
      },
    ]);

    const syncPlan = await getDrivesDueForSync(connector.id, now.getTime());

    expect(syncPlan.candidateDrives.map((drive) => drive.id).sort()).toEqual(
      [
        GOOGLE_DRIVE_USER_SPACE_VIRTUAL_DRIVE_ID,
        "drive-active",
        "drive-capped",
        "drive-missing",
        "drive-quiet",
      ].sort()
    );
    expect(syncPlan.drivesToSync.map((drive) => drive.id).sort()).toEqual(
      [
        GOOGLE_DRIVE_USER_SPACE_VIRTUAL_DRIVE_ID,
        "drive-active",
        "drive-capped",
        "drive-missing",
      ].sort()
    );
    expect(syncPlan.includesAllCandidateDrives).toBe(false);
    expect(
      syncPlan.drivesToSync.find((drive) => drive.id === "drive-quiet")
    ).toBeUndefined();
    expect(
      syncPlan.drivesToSync.find(
        (drive) => drive.id === GOOGLE_DRIVE_USER_SPACE_VIRTUAL_DRIVE_ID
      )?.isShared
    ).toBe(false);
  });
});
