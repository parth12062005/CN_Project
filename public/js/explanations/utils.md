# `utils.js` Explanation

## What it does
Provides shared UI references, mutable global state, logging/status helpers, SHA-256 hashing, and bandwidth tracking utilities.

## Defines
- Global DOM references and shared runtime variables.
- `computeSHA256()` and internal pure-JS SHA-256 implementation.
- `trackNetworkBytes()`, `log()`, and `setStatus()`.

## Why it is needed
Other modules rely on common utilities and shared app state; this file prevents duplicated helper logic and keeps cross-module behavior consistent.

