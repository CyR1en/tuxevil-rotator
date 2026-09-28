# Telemetry

tuxevil-rotator collects **anonymous usage telemetry** to help understand how the tool is used and — most importantly — to improve the anti-flag algorithm that protects your accounts.

## What Is Collected

**Heartbeat** (at boot, every 1 hour, at shutdown):
- Random install ID (UUID — not tied to any account or person)
- Rotator version, Node.js version, OS, architecture
- Account count, models in use, total request count, uptime
- Routing health state (`healthy`/`paused`/`stopped`)
- Flagged/disabled/pro/free account counts
- Per-model token usage (input/output tokens + request count per model)
- Feature usage flags (dashboard opened, login used, etc. — booleans only)

**Flag events** (sent immediately when Google flags an account):
- HTTP status that triggered the flag (`401` or `403`)
- Provider reason code (for example `VALIDATION_REQUIRED`) and a short, filtered message (for example `Verify your account to continue.`), when available
- Which known patterns matched (e.g. `infring`, `abus`, `suspend` — from a fixed allowlist)
- Model being requested, quota timer type, quota percentage
- Account request velocity (requests/hour), concurrent requests, lifetime requests
- Pool state: size, healthy count, whether protective pause triggered
- Time since previous flag

Flag data is the most valuable signal. It lets us study what behavior patterns lead to flags and improve the rotation algorithm to avoid them — benefiting everyone.

## What Is NOT Collected

- Email addresses
- OAuth tokens or API keys
- Google project IDs
- Request/response bodies
- Raw error responses, links, account addresses, and credential-bearing messages
- IP addresses (not part of the JSON payload; transport layer only)

## Opting Out

Set the environment variable before starting:

```bash
export TUXEVIL_ROTATOR_TELEMETRY=off
```

Any of `TUXEVIL_ROTATOR_TELEMETRY=off`, `TUXEVIL_ROTATOR_TELEMETRY=false`, or `TUXEVIL_ROTATOR_TELEMETRY=0` disables telemetry.

## Self-Hosted Receiver

You can point telemetry at your own receiver:

```bash
export TUXEVIL_ROTATOR_TELEMETRY_URL=https://your-receiver.example.com/v1/events
```

The default endpoint is `https://telemetry.tuxevil.com/v1/events`.

A reference implementation of the telemetry receiver is included in this repository at [`tools/telemetry-receiver/`](../tools/telemetry-receiver/). It is a zero-dependency Node.js server that stores events as JSONL files, provides an admin dashboard, and supports operator broadcast notifications.
