import {
  clearWorkspacePoolDepleted,
  setWorkspaceCreditPoolStatus,
  setWorkspacePoolDepleted,
} from "@app/lib/metronome/user_block";
import type { WorkspaceResource } from "@app/lib/resources/workspace_resource";
import { invalidateCacheAfterCommit } from "@app/lib/utils/cache";
import logger from "@app/logger/logger";
import type { WorkspacePoolCreditState } from "@app/types/credits";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";
import type { Transaction } from "sequelize";

export type WorkspaceCreditContext = {
  workspaceId: string;
  paygEnabled: boolean;
};

export type WorkspaceCreditEvent =
  /** Workspace pool commit balance reached zero. */
  | { type: "pool_exhausted" }
  /** Workspace-level PAYG cap reached. */
  | { type: "payg_cap_reached" }
  /**
   * A new commit segment became spendable: either a billing-cycle renewal
   * of the recurring pool commit, or an admin top-up. From the workspace state
   * machine's point of view these are indistinguishable and both bring the
   * pool back online.
   */
  | { type: "credits_added"; balanceAwu: number }
  /**
   * PAYG was turned off by an operator. Workspaces in `overage` were
   * surviving on PAYG: with PAYG gone they have nothing left to spend, so
   * they must move to `depleted`. `active` workspaces are unaffected — the
   * pool will route correctly on the next `pool_exhausted`.
   */
  | { type: "payg_disabled" }
  /**
   * PAYG was turned on (or its cap raised) by an operator. Workspaces in
   * `depleted` that were blocked for lack of PAYG can now spend against it,
   * so they move to `overage`. `active` and `overage` workspaces are
   * unaffected.
   */
  | { type: "payg_enabled" }
  /**
   * Pool balance dropped below a low-balance alert threshold. Carries the
   * remaining balance so the state machine routes to the matching active
   * sub-state. Only throttles when PAYG is off, and never ratchets the active
   * sub-state back up — balance recovery arrives as `credits_added`.
   */
  | { type: "low_balance"; balanceAwu: number };

// Thresholds for low-balance state routing (in credits).
const LOW_BALANCE_THRESHOLD = 100;
const CRITICAL_BALANCE_THRESHOLD = 10;

type WorkspaceCreditGuard = (
  ctx: WorkspaceCreditContext,
  event: WorkspaceCreditEvent
) => boolean;

type WorkspaceCreditTransition = {
  from: WorkspacePoolCreditState | WorkspacePoolCreditState[];
  event: WorkspaceCreditEvent["type"];
  guard?: WorkspaceCreditGuard;
  to: WorkspacePoolCreditState;
};

const whenPayg: WorkspaceCreditGuard = (ctx) => ctx.paygEnabled;
const whenNoPayg: WorkspaceCreditGuard = (ctx) => !ctx.paygEnabled;

// Matches only when every composed guard matches.
function and(...guards: WorkspaceCreditGuard[]): WorkspaceCreditGuard {
  return (ctx, event) => guards.every((guard) => guard(ctx, event));
}

function isBalanceEvent(
  event: WorkspaceCreditEvent
): event is Extract<WorkspaceCreditEvent, { balanceAwu: number }> {
  return event.type === "credits_added" || event.type === "low_balance";
}

// Matches a balance-carrying event (`credits_added` / `low_balance`) whose new
// balance is at or below the given threshold (in AWU credits). Combined with
// findTransition's first-match semantics, transitions must list the lowest
// threshold first so a balance of e.g. 5 routes to `active_critical_balance`
// rather than `active_low_balance`.
function balanceAtMost(thresholdAwu: number): WorkspaceCreditGuard {
  return (_ctx, event) =>
    isBalanceEvent(event) && event.balanceAwu <= thresholdAwu;
}

function syncWorkspacePoolCacheForState(
  state: WorkspacePoolCreditState,
  ctx: WorkspaceCreditContext,
  transaction: Transaction | undefined
): void {
  switch (state) {
    case "active":
    case "overage":
      invalidateCacheAfterCommit(transaction, () =>
        clearWorkspacePoolDepleted(ctx.workspaceId)
      );
      invalidateCacheAfterCommit(transaction, () =>
        setWorkspaceCreditPoolStatus(ctx.workspaceId, state)
      );
      return;

    case "active_low_balance":
    case "active_critical_balance":
      invalidateCacheAfterCommit(transaction, () =>
        clearWorkspacePoolDepleted(ctx.workspaceId)
      );
      invalidateCacheAfterCommit(transaction, () =>
        setWorkspaceCreditPoolStatus(ctx.workspaceId, state)
      );
      return;

    case "depleted":
      invalidateCacheAfterCommit(transaction, () =>
        setWorkspacePoolDepleted(ctx.workspaceId)
      );
      invalidateCacheAfterCommit(transaction, () =>
        setWorkspaceCreditPoolStatus(ctx.workspaceId, state)
      );
      return;

    default:
      assertNever(state);
  }
}

const TRANSITIONS: WorkspaceCreditTransition[] = [
  // Common transitions

  // A new commit segment starting (admin top-up or billing-cycle renewal of the
  // recurring pool commit) brings the pool back online. The destination active
  // sub-state depends on the new balance: the guards encode the thresholds and
  // the lowest one is listed first because findTransition returns the first
  // match.
  {
    from: [
      "active",
      "active_low_balance",
      "active_critical_balance",
      "depleted",
      "overage",
    ],
    event: "credits_added",
    guard: balanceAtMost(CRITICAL_BALANCE_THRESHOLD),
    to: "active_critical_balance",
  },
  {
    from: [
      "active",
      "active_low_balance",
      "active_critical_balance",
      "depleted",
      "overage",
    ],
    event: "credits_added",
    guard: balanceAtMost(LOW_BALANCE_THRESHOLD),
    to: "active_low_balance",
  },
  {
    from: [
      "active",
      "active_low_balance",
      "active_critical_balance",
      "depleted",
      "overage",
    ],
    event: "credits_added",
    to: "active",
  },
  {
    from: [
      "active",
      "active_low_balance",
      "active_critical_balance",
      "overage",
    ],
    event: "pool_exhausted",
    guard: whenPayg,
    to: "overage",
  },
  {
    from: [
      "active",
      "active_low_balance",
      "active_critical_balance",
      "depleted",
    ],
    event: "pool_exhausted",
    guard: whenNoPayg,
    to: "depleted",
  },

  // active -> ...
  {
    from: "active",
    event: "payg_enabled",
    to: "active",
  },
  {
    from: "active",
    event: "payg_disabled",
    to: "active",
  },
  // Low balance only throttles when PAYG is off (with PAYG the workspace keeps
  // spending against it). The reported balance picks the active sub-state,
  // lowest threshold first; the final unguarded row covers the PAYG-enabled and
  // already-healthy (above the low threshold) cases as a no-op.
  {
    from: "active",
    event: "low_balance",
    guard: and(whenNoPayg, balanceAtMost(CRITICAL_BALANCE_THRESHOLD)),
    to: "active_critical_balance",
  },
  {
    from: "active",
    event: "low_balance",
    guard: and(whenNoPayg, balanceAtMost(LOW_BALANCE_THRESHOLD)),
    to: "active_low_balance",
  },
  {
    from: "active",
    event: "low_balance",
    to: "active",
  },

  // active_low_balance -> ...
  // A low_balance event only ratchets down: drop to critical when PAYG is off
  // and the balance is critical, otherwise stay (higher balances, PAYG enabled,
  // or out-of-order alerts).
  {
    from: "active_low_balance",
    event: "low_balance",
    guard: and(whenNoPayg, balanceAtMost(CRITICAL_BALANCE_THRESHOLD)),
    to: "active_critical_balance",
  },
  {
    from: "active_low_balance",
    event: "low_balance",
    to: "active_low_balance",
  },
  {
    from: "active_low_balance",
    event: "payg_enabled",
    to: "active",
  },
  {
    from: "active_low_balance",
    event: "payg_disabled",
    to: "active_low_balance",
  },

  // active_critical_balance -> ...
  // Already at the floor of the active sub-states: any low_balance event stays.
  {
    from: "active_critical_balance",
    event: "low_balance",
    to: "active_critical_balance",
  },
  {
    from: "active_critical_balance",
    event: "payg_enabled",
    to: "active",
  },
  {
    from: "active_critical_balance",
    event: "payg_disabled",
    to: "active_critical_balance",
  },

  // overage -> ...
  {
    from: "overage",
    event: "payg_cap_reached",
    to: "depleted",
  },
  {
    from: "overage",
    event: "payg_disabled",
    to: "depleted",
  },
  {
    from: "overage",
    event: "payg_enabled",
    to: "overage",
  },

  // depleted -> ...
  {
    from: "depleted",
    event: "payg_cap_reached",
    to: "depleted",
  },
  {
    from: "depleted",
    event: "payg_enabled",
    to: "overage",
  },
  {
    from: "depleted",
    event: "payg_disabled",
    to: "depleted",
  },
];

function findTransition(
  current: WorkspacePoolCreditState,
  event: WorkspaceCreditEvent,
  ctx: WorkspaceCreditContext
): WorkspaceCreditTransition | undefined {
  return TRANSITIONS.find((t) => {
    const fromMatch = Array.isArray(t.from)
      ? t.from.includes(current)
      : t.from === current;
    return (
      fromMatch && t.event === event.type && (!t.guard || t.guard(ctx, event))
    );
  });
}

export async function transitionWorkspaceCreditState(
  workspace: WorkspaceResource,
  event: WorkspaceCreditEvent,
  ctx: WorkspaceCreditContext,
  { transaction }: { transaction?: Transaction } = {}
): Promise<Result<WorkspacePoolCreditState, Error>> {
  const currentState = workspace.poolCreditState;
  const match = findTransition(currentState, event, ctx);

  if (!match) {
    logger.warn(
      {
        workspaceId: ctx.workspaceId,
        currentState,
        event,
      },
      "[WorkspaceCreditStateMachine] No matching transition: skipping"
    );
    return new Err(
      new Error(
        `[WorkspaceCreditStateMachine] Illegal transition: ${currentState} + ${event.type}`
      )
    );
  }

  const targetState = match.to;

  if (currentState !== targetState) {
    await workspace.updatePoolCreditState(targetState, transaction);
  }
  syncWorkspacePoolCacheForState(targetState, ctx, transaction);
  logger.info(
    {
      workspaceId: ctx.workspaceId,
      fromState: currentState,
      toState: targetState,
      eventType: event.type,
      wasStateChanged: currentState !== targetState,
    },
    "[WorkspaceCreditStateMachine] Transition applied"
  );

  return new Ok(targetState);
}
