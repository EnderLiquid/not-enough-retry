# Not Enough Retry

English | [简体中文](README.zh.md)

pi's built-in retry matches error text against a whitelist: overloaded, rate limit, connection error, stream ended... The list is not short, but reality keeps throwing more at you — streams drop mid-flight, and model providers or relay services serve up brand-new error wording every day. When an error doesn't match, pi never retries it. You come back to check on your long-running task, only to find it quietly died, leaving behind an error message that should have triggered a retry. Sound familiar?

## Summary

`not-enough-retry` makes pi's built-in retry take over all non-permanent errors with two small changes: it tags error messages so the native retry recognizes them, and it adds an optional mixin patch that caps the native backoff.

## Two predecessors

Two popular retry plugins already exist in the community, each solving half of the problem.

`@narumitw/pi-retry` translates errors into something pi understands: on `message_end` it appends the phrase `provider returned error` to certain error texts, and pi's built-in matcher takes over. Minimally invasive and semantically correct — but it only recognizes a handful of error patterns, and it does nothing about the uncapped native backoff.

`@monotykamary/pi-retry` implements its own retry loop instead: everything outside a blacklist is retried indefinitely, and it works remarkably well. The price is that every retry is a full hidden turn — an `agent_settled` storm keeps firing completion-notification plugins, and every retry instruction enters the model context as a user message.

`not-enough-retry` stitches the two together: the translation channel from `@narumitw/pi-retry`, the blacklist from `@monotykamary/pi-retry`.

## How it works

On `message_end`, assistant error messages are checked against a blacklist (authentication failures, unknown models — 9 patterns in total). Blacklisted errors pass through untouched; everything else gets a `provider returned error` tag. pi's native retry then takes over completely: attempt limits, backoff, TUI status, and abort handling are all stock behavior. Zero context pollution, no extra message entries, and completion-notification plugins are none the wiser.

The native backoff has no cap, so a large retry limit means exponentially exploding wait times that freeze the session. (For example, the 12th retry waits about 68 minutes by default.)

The optional mixin patch replaces only the backoff source: exponential backoff capped at `maxDelayMs`, with an independent attempt limit. Everything else behaves exactly like the original. The patch is gentle — if you disable it in config, pass a CLI flag, or pi's internals change after an upgrade, it hands control back to the native implementation. The worst case is simply pi's default behavior.

## Install

### npm package

```bash
pi install npm:not-enough-retry
```

### Git repository

```bash
pi install git:github.com/EnderLiquid/not-enough-retry
```

## Configuration

Works out of the box. Optional settings go in pi's `settings.json`:

```json
{
  "not-enough-retry": {
    "mixin": {
      "enabled": true,
      "maxRetries": 16,
      "baseDelayMs": 2000,
      "maxDelayMs": 30000
    }
  }
}
```

- `enabled`: mixin switch, defaults to `true`. When off, pi's native `_prepareRetry` runs untouched.
- `maxRetries`: consecutive-failure retry limit, replacing pi's `retry.maxRetries`. Defaults to 16, only applies when the mixin is on.
- `baseDelayMs`: initial retry backoff in milliseconds, doubling each attempt but never exceeding the cap. Defaults to 2000, only applies when the mixin is on.
- `maxDelayMs`: backoff cap in milliseconds. Defaults to 30000, only applies when the mixin is on.

Pass `--ner-no-mixin` at startup to disable the mixin temporarily without editing any config — handy right after a pi upgrade.

If `settings.json` is corrupted or contains invalid values, the plugin falls back to defaults and shows a warning notification at session start.

## Compatibility

Requires Pi 0.84 or later. The mixin patch is verified on 0.84.x; if internals change in other versions, the sanity check safely disables the patch.

## Acknowledgements

This plugin stands on the shoulders of two open-source projects.

The blacklist patterns come from `@monotykamary/pi-retry` (MIT) by Tom X Nguyen — the "retry everything except a blacklist" philosophy is the core idea of this plugin.

The hint translation channel comes from `@narumitw/pi-retry` (MIT) by narumiruna — it proved that the least invasive approach is viable, and it already waded through every pitfall on this road.

Each author contributed half of the answer; this plugin simply sews them together.

> "The beauty of a fine soup lies in blending different flavors."  
> — *Records of the Three Kingdoms*, Biography of Xiahou Xuan  
> （和羹之美，在于合异。《三国志·魏书·夏侯玄传》）

Endless gratitude.

## License

MIT License
