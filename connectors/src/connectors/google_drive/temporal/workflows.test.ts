import { GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS } from "@connectors/connectors/google_drive/temporal/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CONNECTOR_ID = 123;

const mocks = vi.hoisted(() => {
  const activityMocks = {
    getDrivesDueForSync: vi.fn(),
    getDrivesToSync: vi.fn(),
    shouldGarbageCollect: vi.fn(),
    syncStarted: vi.fn(),
    syncSucceeded: vi.fn(),
  };

  return {
    ...activityMocks,
    continueAsNew: vi.fn(),
    executeChild: vi.fn(),
    isCancellation: vi.fn(),
    patched: vi.fn(),
    proxyActivities: vi.fn(() => activityMocks),
    sleep: vi.fn(),
    startChild: vi.fn(),
    workflowInfo: vi.fn(),
  };
});

vi.mock("@temporalio/workflow", () => ({
  continueAsNew: mocks.continueAsNew,
  defineSignal: vi.fn(() => Symbol("signal")),
  executeChild: mocks.executeChild,
  isCancellation: mocks.isCancellation,
  patched: mocks.patched,
  proxyActivities: mocks.proxyActivities,
  setHandler: vi.fn(),
  sleep: mocks.sleep,
  startChild: mocks.startChild,
  workflowInfo: mocks.workflowInfo,
}));

import { googleDriveIncrementalSyncV2 } from "./workflows";

describe("googleDriveIncrementalSyncV2", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.workflowInfo.mockReturnValue({
      historyLength: 0,
      memo: {},
    });
    mocks.patched.mockReturnValue(true);
    mocks.startChild.mockResolvedValue({
      result: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("continues without sync status churn when no drives are due", async () => {
    mocks.getDrivesDueForSync.mockResolvedValue({
      candidateDrives: [],
      drivesToSync: [],
      includesAllCandidateDrives: true,
    });

    await googleDriveIncrementalSyncV2(CONNECTOR_ID);

    expect(mocks.getDrivesDueForSync).toHaveBeenCalledWith(CONNECTOR_ID);
    expect(mocks.startChild).not.toHaveBeenCalled();
    expect(mocks.shouldGarbageCollect).not.toHaveBeenCalled();
    expect(mocks.executeChild).not.toHaveBeenCalled();
    expect(mocks.syncStarted).not.toHaveBeenCalled();
    expect(mocks.syncSucceeded).not.toHaveBeenCalled();
    expect(mocks.sleep).toHaveBeenCalledWith(
      GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS
    );
    expect(mocks.continueAsNew).toHaveBeenCalledWith(CONNECTOR_ID);
  });

  it("skips connector-wide garbage collection after a partial due-drive cycle", async () => {
    mocks.getDrivesDueForSync.mockResolvedValue({
      candidateDrives: [
        { id: "drive-due", isShared: true },
        { id: "drive-quiet", isShared: true },
      ],
      drivesToSync: [{ id: "drive-due", isShared: true }],
      includesAllCandidateDrives: false,
    });
    mocks.shouldGarbageCollect.mockResolvedValue(false);

    await googleDriveIncrementalSyncV2(CONNECTOR_ID);

    expect(mocks.startChild).toHaveBeenCalledOnce();
    expect(mocks.shouldGarbageCollect).toHaveBeenCalledWith(CONNECTOR_ID);
    expect(mocks.executeChild).not.toHaveBeenCalled();
    expect(mocks.syncStarted).toHaveBeenCalledWith(CONNECTOR_ID);
    expect(mocks.syncSucceeded).toHaveBeenCalledWith(CONNECTOR_ID);
  });

  it("syncs all candidate drives before connector-wide garbage collection", async () => {
    mocks.getDrivesDueForSync.mockResolvedValue({
      candidateDrives: [
        { id: "drive-due", isShared: true },
        { id: "drive-quiet", isShared: true },
      ],
      drivesToSync: [{ id: "drive-due", isShared: true }],
      includesAllCandidateDrives: false,
    });
    mocks.shouldGarbageCollect.mockResolvedValue(true);

    await googleDriveIncrementalSyncV2(CONNECTOR_ID);

    expect(mocks.startChild).toHaveBeenCalledTimes(2);
    expect(mocks.startChild.mock.calls.map(([, options]) => options)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          args: [
            expect.objectContaining({
              driveId: "drive-due",
            }),
          ],
        }),
        expect.objectContaining({
          args: [
            expect.objectContaining({
              driveId: "drive-quiet",
            }),
          ],
        }),
      ])
    );
    expect(mocks.executeChild).toHaveBeenCalledOnce();
  });

  it("keeps the legacy command order for pre-patch workflow histories", async () => {
    mocks.patched.mockReturnValue(false);
    mocks.getDrivesToSync.mockResolvedValue([]);
    mocks.shouldGarbageCollect.mockResolvedValue(false);

    await googleDriveIncrementalSyncV2(CONNECTOR_ID);

    expect(mocks.getDrivesDueForSync).not.toHaveBeenCalled();
    expect(mocks.syncStarted).toHaveBeenCalledWith(CONNECTOR_ID);
    expect(mocks.getDrivesToSync).toHaveBeenCalledWith(CONNECTOR_ID);
    const syncStartedCallOrder =
      mocks.syncStarted.mock.invocationCallOrder[0];
    const getDrivesToSyncCallOrder =
      mocks.getDrivesToSync.mock.invocationCallOrder[0];
    if (
      syncStartedCallOrder === undefined ||
      getDrivesToSyncCallOrder === undefined
    ) {
      throw new Error("Expected calls to be recorded");
    }
    expect(syncStartedCallOrder).toBeLessThan(getDrivesToSyncCallOrder);
    expect(mocks.startChild).toHaveBeenCalledOnce();
    expect(mocks.sleep).toHaveBeenCalledWith(
      2 * GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS
    );
  });
});
