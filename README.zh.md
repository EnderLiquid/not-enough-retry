# Not Enough Retry

[English](README.md) | 简体中文

pi 内置的 retry 按白名单匹配错误文本：overloaded、rate limit、connection error、stream ended……匹配规则不算少，但现实里的麻烦显然更多——流式传输常常中断，模型提供商或中转站每天都在返回措辞千奇百怪的新错误。匹配不上的错误，pi 一次都不会重试。长任务跑到一半偷偷中断，你满怀期待回来验收，现场却只留下了一则本应触发重试的错误信息——这是多少人的常态？

## 概要

`not-enough-retry` 用一处小改造让 pi 内置的 retry 接管所有非永久性错误：给错误信息打上能触发原生 retry 的标记。

## 两位先驱

社区里已经有两个热门的 retry 插件，各自解决了问题的一半。

`@narumitw/pi-retry` 的思路是把错误翻译成 pi 认识的样子：在 `message_end` 时给特定错误文本追加一句 `provider returned error`，内置判定器就接盘了。侵入性极小、事件语义完全正确，但它只认识几种错误。

`@monotykamary/pi-retry` 选择自己实现整个 retry 循环：黑名单之外的一切错误无限重试，效果立竿见影。代价是每次重试都是一次完整的隐藏 turn——`agent_settled` 事件风暴反复触发完成通知类插件，每条重试指令都会作为用户消息进入模型上下文。

`not-enough-retry` 把它们缝合起来：取 `@narumitw/pi-retry` 的翻译通道，用 `@monotykamary/pi-retry` 的黑名单。

## 工作原理

`message_end` 时检查 assistant 错误消息：命中黑名单（鉴权失败、模型不存在等，共 9 条）则放行，其余全部追加 `provider returned error` 标记。pi 的原生 retry 随即接管：重试次数、退避、TUI 状态、中断处理全部是原生行为。上下文零污染，不会多出任何消息记录，完成通知类插件也不会误报。

## 安装

### npm package

```bash
pi install npm:not-enough-retry
```

### Git repository

```bash
pi install git:github.com/EnderLiquid/not-enough-retry
```

## 版本要求

需要 Pi 0.87.0 或更高版本。

0.3.x 及以前的版本附带一个可选的 mixin 补丁，用于给原生退避补上封顶并提供独立的重试次数上限。0.4.0 移除了它，因为它的存在理由已经消失：Pi 0.86.0 已自行修复退避无封顶的问题（`retry.maxAgentDelayMs`，默认 60 秒，见 pi issue [#8826](https://github.com/earendil-works/pi/issues/8826)）；0.87.0 起失败的尝试改由 canonical 的 session manager 持久省略，旧补丁依赖的消息数组摘除手法也随之失效。

从 0.3.x 或更早版本升级时请注意：

- 从启动脚本中移除 `--ner-no-mixin`。pi 会拒绝未注册的扩展 flag，残留会导致启动失败并报 `Unknown option: --ner-no-mixin`。
- `settings.json` 中的 `not-enough-retry.mixin` 配置段将不再生效，可直接删除。

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
