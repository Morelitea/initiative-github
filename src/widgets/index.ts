import type { Widget } from "initiative-app-kit";

import { dependabotAlertsWidget } from "./dependabot-alerts.js";
import { issueThroughputWidget } from "./issue-throughput.js";
import { openIssuesWidget } from "./open-issues.js";
import { reviewQueueWidget } from "./review-queue.js";

export const WIDGETS: readonly Widget[] = [
  openIssuesWidget,
  reviewQueueWidget,
  dependabotAlertsWidget,
  issueThroughputWidget,
];
