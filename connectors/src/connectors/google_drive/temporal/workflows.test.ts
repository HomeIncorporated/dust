import { GDRIVE_BASE_INCREMENTAL_SYNC_INTERVAL_MS } from "@connectors/connectors/google_drive/temporal/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CONNECTOR_ID = 123;

const mocks = vi.hoisted(() => {
  const activityMocks = {
    getDrivesDueForSync: vi.fn(),
    shouldGarbageCollect: vi.fn(),
    syncStarted: vi.fn(),
    syncSucceeded: vi.fn(),
  };

  return {
    ...activityMocks,
    continueAsNew: vi.fn(),
    executeChild: vi.fn(),
    isCancellation: vi.fn(),
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
  });

  it("continues without sync status churn when no drives are due", async () => {
    mocks.getDrivesDueForSync.mockResolvedValue([]);

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
});
