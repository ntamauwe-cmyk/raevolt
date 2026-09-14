import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const c = cronJobs();

// Webhook dispatcher: every minute, bounded batch (prompt §30, §48).
c.interval(
  "dispatch-webhooks",
  { minutes: 1 },
  internal.webhooks.dispatchDue,
  {},
);

export default c;
