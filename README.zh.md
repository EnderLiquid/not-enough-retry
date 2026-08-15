# Not Enough Retry

[English](README.md) | 简体中文

pi 内置的 retry 按白名单匹配错误文本：overloaded、rate limit、connection error、stream ended……匹配规则不算少，但现实里的麻烦显然更多——流式传输常常中断，模型提供商或中转站每天都在返回措辞千奇百怪的新错误。匹配不上的错误，pi 一次都不会重试。长任务跑到一半偷偷中断，你满怀期待回来验收，现场却只留下了一则本应触发重试的错误信息——这是多少人的常态？

## 概要

`not-enough-retry` 用两处小改造让 pi 内置的 retry 接管所有非永久性错误：给错误信息打上能触发原生 retry 的标记；用可选的 mixin 补丁为原生退避补上封顶。

## 两位先驱

社区里已经有两个热门的 retry 插件，各自解决了问题的一半。

`@narumitw/pi-retry` 的思路是把错误翻译成 pi 认识的样子：在 `message_end` 时给特定错误文本追加一句 `provider returned error`，内置判定器就接盘了。侵入性极小、事件语义完全正确，但它只认识几种错误，也没有解决原生 retry 退避的问题。

`@monotykamary/pi-retry` 选择自己实现整个 retry 循环：黑名单之外的一切错误无限重试，效果立竿见影。代价是每次重试都是一次完整的隐藏 turn——`agent_settled` 事件风暴反复触发完成通知类插件，每条重试指令都会作为用户消息进入模型上下文。

`not-enough-retry` 把它们缝合起来：取 `@narumitw/pi-retry` 的翻译通道，用 `@monotykamary/pi-retry` 的黑名单。

## 工作原理

`message_end` 时检查 assistant 错误消息：命中黑名单（鉴权失败、模型不存在等，共 9 条）则放行，其余全部追加 `provider returned error` 标记。pi 的原生 retry 随即接管：重试次数、退避、TUI 状态、中断处理全部是原生行为。上下文零污染，不会多出任何消息记录，完成通知类插件也不会误报。

原生退避没有封顶，重试次数调大后单次等待时长会指数爆炸，导致会话冻结。（例如，默认第 12 次重试前要等待约 68 分钟）

可选的 mixin 补丁只替换退避来源：指数退避封顶到 `maxDelayMs`，次数上限独立配置，其余行为与原生逐字一致。补丁是温和的——配置关闭、启动参数关闭、或 pi 升级导致内部字段变化时，自动交还原生实现，最坏情况只是退回 pi 的默认行为。

## 安装

### npm package

```bash
pi install npm:not-enough-retry
```

### Git repository

```bash
pi install git:github.com/EnderLiquid/not-enough-retry
```

## 配置

默认开箱即用。在 pi 的 `settings.json` 中可配置：

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

- `enabled`：mixin 总开关，默认 `true`。关闭时完全交还 pi 原生 `_prepareRetry`；
- `maxRetries`：连续失败重试上限，替代 pi 的 `retry.maxRetries`，默认 16，仅启用 mixin 时生效；
- `baseDelayMs`：首次重试退避（毫秒），之后每次翻倍但不超过退避封顶，默认 2000，仅启用 mixin 时生效；
- `maxDelayMs`：退避封顶（毫秒），默认 30000，仅启用 mixin 时生效。

启动时附加 `--ner-no-mixin` 可临时禁用 mixin，无需改动配置文件，适合 pi 升级后应急。

settings.json 损坏或字段非法时，插件回退默认配置并在会话开始时发出 warning 通知。

## 兼容性

需要 Pi 0.84 或更高版本。mixin 补丁在 0.84.x 上验证；其他版本若内部结构变化，补丁会经 sanity check 安全地自动失效。

## 致谢

这个插件站在两个开源项目的肩膀上。

黑名单模式来自 `@monotykamary/pi-retry`（MIT），作者 Tom X Nguyen——"黑名单之外全部重试"的哲学构成了本插件最核心的思路；

hint 翻译通道则来自 `@narumitw/pi-retry`（MIT），作者 narumiruna——它证明了侵入最小解法的可行性，并率先趟过了这条路的每个坑。

两位作者各自贡献了一半答案，这个插件只是把它们缝到了一起。

> 和羹之美，在于合异。  
> ——《三国志·魏书·夏侯玄传》

感激不尽。

## 许可证

MIT License
