# Loop Stalled Or Timer Missing

## What it means

One or more scan, exit, or wallet-balance loops are no longer completing on schedule.

## Immediate checks

1. Inspect dashboard health loop timestamps.
2. Review PM2 logs for uncaught errors or repeated retries.
3. Check dependency health for the affected chain.
4. Confirm the process is not CPU-bound or blocked on slow external calls.

## Recovery

1. Fix the upstream or runtime issue first.
2. Restart the affected process if the loop does not recover on its own.
3. Confirm loop timestamps advance again after restart.
