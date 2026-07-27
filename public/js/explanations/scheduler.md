# `scheduler.js` Explanation

## What it does
Runs periodic decision-making to choose which chunks should be fetched next and with what priority.

## Defines
- `Scheduler` class with:
  - Tick loop (`start`, `stop`, `_tick`)
  - Playhead updates (`updateSegment`)
  - Fetch-list planner (`_computeFetchList`) across urgent/safety/future/far-past zones
  - Controlled concurrency and in-flight tracking

## Why it is needed
Playback quality and P2P efficiency depend on intelligent prefetch order; this file provides that policy engine.

