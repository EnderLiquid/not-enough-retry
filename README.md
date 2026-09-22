# Not Enough Retry

English | [简体中文](README.zh.md)

pi's built-in retry matches error text against a whitelist: overloaded, rate limit, connection error, stream ended... The list is not short, but reality keeps throwing more at you — streams drop mid-flight, and model providers or relay services serve up brand-new error wording every day. When an error doesn't match, pi never retries it. You come back to check on your long-running task, only to find it quietly died, leaving behind an error message that should have triggered a retry. Sound familiar?

## Summary

`not-enough-retry` makes pi's built-in retry take over all non-permanent errors with one small change: it tags error messages so the native retry recognizes them.

## Two predecessors

Two popular retry plugins already exist in the community, each solving half of the problem.

`@narumitw/pi-retry` translates errors into something pi understands: on `message_end` it appends the phrase `provider returned error` to certain error texts, and pi's built-in matcher takes over. Minimally invasive and semantically correct — but it only recognizes a handful of error patterns.

`@monotykamary/pi-retry` implements its own retry loop instead: everything outside a blacklist is retried indefinitely, and it works remarkably well. The price is that every retry is a full hidden turn — an `agent_settled` storm keeps firing completion-notification plugins, and every retry instruction enters the model context as a user message.

`not-enough-retry` stitches the two together: the translation channel from `@narumitw/pi-retry`, the blacklist from `@monotykamary/pi-retry`.

## How it works

On `message_end`, assistant error messages are checked against a blacklist (authentication failures, unknown models — 9 patterns in total). Blacklisted errors pass through untouched; everything else gets a `provider returned error` tag. pi's native retry then takes over completely: attempt limits, backoff, TUI status, and abort handling are all stock behavior. Zero context pollution, no extra message entries, and completion-notification plugins are none the wiser.

## Install

### npm package

```bash
pi install npm:not-enough-retry
```

### Git repository

```bash
pi install git:github.com/EnderLiquid/not-enough-retry
```

## Requirements

Requires Pi 0.87.0 or later.

Versions up to 0.3.x shipped an optional mixin patch that capped the native backoff and carried its own retry limit. It is gone in 0.4.0 because the reason for it disappeared: Pi 0.86.0 capped agent-level retry backoff on its own (`retry.maxAgentDelayMs`, 60s by default, see pi issue [#8826](https://github.com/earendil-works/pi/issues/8826)), and since 0.87.0 the failed attempt is durably omitted from model context through the canonical session manager instead of the message-array surgery the patch relied on.

When upgrading from 0.3.x or earlier:

- Remove `--ner-no-mixin` from your launch scripts. Pi rejects unknown extension flags and will refuse to start with `Unknown option: --ner-no-mixin`.
- The `not-enough-retry.mixin` section in `settings.json` becomes inert and can be deleted.

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
