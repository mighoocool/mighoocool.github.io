---
layout: default
title: 学习文档 10 - 性能、内存与调试
---

# 10. 性能、内存与调试

本文说明 Lichtblick 中性能、内存与调试相关的主要机制：消息帧如何限速，订阅如何合并，面板如何避免拖慢播放器，worker 与文件缓存如何控制资源，错误如何进入 UI，以及遇到卡顿、内存增长、消息错序、脚本异常时应该沿哪条源码链路排查。

阅读本文时建议同时打开以下源码：

- `packages/suite-base/src/components/MessagePipeline/index.tsx`
- `packages/suite-base/src/components/MessagePipeline/store.ts`
- `packages/suite-base/src/components/MessagePipeline/subscriptions.ts`
- `packages/suite-base/src/components/MessagePipeline/MessageOrderTracker.ts`
- `packages/suite-base/src/components/MessagePipeline/pauseFrameForPromise.ts`
- `packages/suite-base/src/context/PerformanceContext.ts`
- `packages/suite-base/src/panels/PlaybackPerformance/index.tsx`
- `packages/suite-base/src/components/Panel.tsx`
- `packages/suite-base/src/components/PanelErrorBoundary.tsx`
- `packages/suite-base/src/components/PanelLogs.tsx`
- `packages/suite-base/src/components/MemoryUseIndicator.tsx`
- `packages/suite-base/src/players/messageMemoryEstimation.ts`
- `packages/suite-base/src/util/CachedFilelike.ts`
- `packages/suite-base/src/util/VirtualLRUBuffer.ts`
- `packages/suite-base/src/util/WebWorkerManager.ts`
- `packages/suite-base/src/util/RpcWorkerUtils.ts`
- `packages/suite-base/src/players/UserScriptPlayer/index.ts`
- `packages/suite-base/src/components/TimeBasedChart/index.tsx`
- `packages/suite-base/src/components/AppSettingsDialog/settings.tsx`

## 1. 本篇定位

性能、内存和调试不是独立模块。

它们分布在播放器、MessagePipeline、面板容器、worker、文件读取、用户脚本和全局 UI 中。

学习这部分时，重点不是背 API，而是建立三个判断：

- 数据是否被过量拉取。
- 数据是否被过量保留。
- UI 是否在一帧内做了过多工作。

Lichtblick 的多数性能设计都围绕这三点展开。

## 2. 性能问题的主路径

典型消息路径是：

```text
Data Source / Player
  -> wrapper players
  -> MessagePipelineProvider
  -> MessagePipeline store
  -> subscriber buckets
  -> Panels / Extension renderState / converters
  -> React render / canvas render / worker render
```

任何一层都可能造成卡顿。

排查时不要只看 React，也不要只看数据源。先确认瓶颈在“读取”、“转换”、“分发”、“渲染”还是“资源释放”。

## 3. MessagePipeline 是性能核心

`MessagePipelineProvider` 是播放器状态进入 UI 的中心。

它负责：

- 接收 player emit 的 `PlayerState`。
- 控制每帧更新节奏。
- 合并 panel 订阅。
- 把消息按 subscriber id 分桶。
- 维护 last message cache。
- 暴露 playback control、publish、service、asset、batch iterator 等能力。
- 在 player 切换时重建 store 并释放旧 player。

因此卡顿、消息错序、订阅异常、面板数据不更新，都应该优先检查 MessagePipeline 周边。

## 4. MessagePipeline store 的状态边界

`store.ts` 里的 state 分为内部状态和 public context。

内部状态包含：

- 当前 player。
- subscriptions by subscriber id。
- publishers by id。
- topic 到 subscriber id 的映射。
- last message by topic。
- last capabilities。
- renderDone 回调。

public context 包含：

- playerState。
- messageEventsBySubscriberId。
- subscriptions。
- sortedTopics。
- sortedServices。
- datatypes。
- playback control 函数。
- publish、service、asset、batch iterator 函数。
- pauseFrame。

这个分层的意义是：UI 只通过 public context 消费必要状态，内部映射和缓存可以独立维护。

## 5. player 切换时为什么重建 store

`MessagePipelineProvider` 在 `player` 变化时创建新的 Zustand store。

这样做会丢弃旧 player 的 subscribers、publishers、last messages 和 public state。

这不是浪费，而是避免旧数据源状态泄漏到新数据源。

代码注释中明确提到：Workspace 会在 player 改变时重新挂载 panels，所以 panel 会重新注册订阅。

## 6. player listener 的内存泄漏防护

`createPlayerListener` 被抽成模块级函数，而不是直接写在 React effect 内。

原因是 V8 closure 可能让内部函数共享外层 context。只要其中一个 closure 还活着，就可能保留外层变量，包括旧 player state 和预加载消息块。

把 listener 创建逻辑移到模块级函数后，它不会捕获组件 effect 中的无关变量，从而降低 player 切换后旧状态被链式保留的风险。

这是本项目中非常明确的内存泄漏防护点。

## 7. listener 如何防止帧重入

`createPlayerListener` 中维护 `resolveFn`。

如果上一帧还没有完成渲染确认，新的 `PlayerState` 又进来了，会抛出错误：

```text
New playerState was emitted before last playerState was rendered.
```

这条保护强制 player 等待 UI 管线完成一帧，避免消息无限堆积。

它不是简单限速，而是把数据生产方和 UI 消费方连接成背压链路。

## 8. messageRate 如何限帧

应用设置里有 `MESSAGE_RATE`。

`AppSettingsDialog/settings.tsx` 提供 1、3、5、10、15、20、30、60 Hz 选项。

`MessagePipelineProvider` 读取该设置，并计算：

```text
msPerFrame = 1000 / messageRate
```

每帧 renderDone 后，会根据已消耗时间计算剩余 frame time，再用 `setTimeout` 延迟 resolve。

如果用户把 message rate 降低，播放器进入 UI 的帧频会降低，从而减少面板渲染和消息分发压力。

## 9. renderDone 的作用

`renderDone` 是 MessagePipeline 等待 React commit 的回调。

store 更新时会把 `renderDone` 放进 state。

`MessagePipelineProvider` 用 layout effect 读取并调用它，表示本轮 React 渲染已经完成。

之后 MessagePipeline 才进入“等待异步面板渲染或 frame time”的阶段。

这让主线程 React 渲染和播放器推进之间形成明确同步点。

## 10. pauseFrame 的作用

`pauseFrame` 允许面板临时暂停 MessagePipeline 的下一帧推进。

它返回一个 resume 函数。

面板开始异步渲染时调用 `pauseFrame(name)`，完成后调用 resume。

如果面板没有及时 resume，`pauseFrameForPromises` 最多等待 5000ms，避免整个播放器永久卡住。

## 11. TimeBasedChart 如何使用 pauseFrame

`TimeBasedChart` 在数据变化开始渲染时调用：

```text
pauseFrame("TimeBasedChart")
```

渲染完成后，它通过 `requestAnimationFrame` 等待 offscreen canvas 呈现到屏幕，再调用 resume。

这样 streaming 时图表不会在前一帧还没画完时继续吞下一帧数据。

这是一种 UI 侧背压：不是让 worker 无限排队，而是让消息管线等图表完成。

## 12. pauseFrame 的调试含义

如果播放明显卡住，但数据源没有断开，需要检查是否有面板调用了 `pauseFrame` 后没有 resume。

相关路径是：

- `packages/suite-base/src/components/MessagePipeline/store.ts`
- `packages/suite-base/src/components/MessagePipeline/pauseFrameForPromise.ts`
- `packages/suite-base/src/components/TimeBasedChart/index.tsx`
- `packages/suite-base/src/components/PanelExtensionAdapter/PanelExtensionAdapter.tsx`

`pauseFrameForPromises` 超时时会吞掉 timeout，不直接抛出到 UI。它的目的不是让用户看到错误，而是让管线恢复推进。

## 13. 订阅合并是第一道减负

每个 panel 都可以注册自己的订阅。

如果直接把每个 panel 的订阅原样传给 player，底层 player 会重复读取同一个 topic。

`MessagePipeline/subscriptions.ts` 用 `mergeSubscriptions` 把所有订阅合并为 player 需要的一组最小订阅。

这减少底层数据读取、字段切片和网络流量。

## 14. subscription memoizer

`makeSubscriptionMemoizer` 使用 deep equal memoization 稳定订阅对象引用。

MessagePipeline 每次更新 subscriber 时都会重新计算合并订阅。

如果合并结果语义没变，稳定引用可以减少 player 侧订阅 churn。

这里的 cache size 是 Infinity，但注释说明需要由包含它的作用域管理。MessagePipeline store 在 player 切换和 reset 时会重新创建 memoizer。

## 15. fields 合并策略

同一 topic 的多个订阅会合并 fields。

如果任意订阅请求 all fields，合并结果就是 all fields。

如果多个订阅各自请求部分字段，则合并结果是字段并集。

这保证不会因为某个 panel 只要少数字段而破坏另一个 panel 的数据需求。

## 16. sampling 合并策略

sampling 只有在两个订阅使用相同 sampling mode 时才保留。

authorization 使用 OR 语义。

如果订阅之间 sampling mode 不一致，合并结果会丢弃 samplingRequest。

这个策略避免把不兼容的采样要求错误下推给 player。

## 17. full preload 与 partial 订阅

`mergeSubscriptions` 对 full preload 做特殊处理。

一个 full subscription 会隐含一个 partial subscription。

然后 full 和 partial 分别做 denormalize，再合并输出。

这样既能满足历史预加载，也能满足当前帧或局部字段读取。

## 18. 订阅更新为什么 debounce

`MessagePipelineProvider` 用 `_.debounce` 包装 `player.setSubscriptions`。

delay 是默认的 0ms。

目的不是延迟用户感知，而是在同一个事件循环中合并多个 panel 的订阅更新，避免 player 拉取马上会被丢弃的数据。

组件卸载或 debounce 函数变化时会 cancel pending 调用。

## 19. subscriber bucket 的作用

MessagePipeline 不把每帧所有消息都发给每个 panel。

它维护 `subscriberIdsByTopic`。

当 playerState 中有 messages 时，只把某个 topic 的消息放入订阅该 topic 的 subscriber id 队列。

public context 中的 `messageEventsBySubscriberId` 是按 subscriber 分桶后的结果。

这减少每个面板要扫描和过滤的消息量。

## 20. 为什么 subscriber ids 用数组

`subscriberIdsByTopic` 的 value 是数组，不是 Set。

源码注释说明：热路径需要频繁迭代 subscriber ids，数组迭代比 Set 更快。

代码仍然会避免同一个 id 重复加入数组。

这是一个典型热路径微优化。

## 21. lastMessageEventByTopic 的作用

MessagePipeline 保存每个 topic 最近一条消息。

当 panel 新订阅一个 topic 时，如果该 topic 已经收到过消息，MessagePipeline 可以立即给这个 subscriber 注入 last message。

这样新打开或刚改订阅的 panel 不必等下一条消息才显示内容。

## 22. stale last message 的清理

如果某个 subscriber 取消订阅 topic，并且没有其他 subscriber 订阅该 topic，MessagePipeline 会从 `lastMessageEventByTopic` 删除该 topic。

这样该 panel 之后重新订阅时，不会在 seek-backfill 之前拿到旧时间点的 stale message。

这是数据正确性和内存控制的共同点。

## 23. sortedTopics 的引用优化

`updatePlayerStateAction` 只有在 `activeData.topics` 引用变化时才重新计算 `sortedTopics`。

services 和 datatypes 也有类似引用比较。

这要求上游在数据没有语义变化时尽量保持引用稳定。

如果某一层每帧都创建新的 topics 数组，会导致下游不必要排序和重渲染。

## 24. capabilities 的 shallow equal

MessagePipeline 用 shallow equal 比较 player capabilities。

只有 capabilities 变化时，才重新绑定 `startPlayback`、`playUntil`、`pausePlayback`、`setPlaybackSpeed`、`seekPlayback`。

这避免每帧都创建新的控制函数引用，减少依赖这些函数的组件更新。

## 25. MessageOrderTracker

`MessageOrderTracker` 检测两类问题：

- message receiveTime 与 player currentTime 漂移超过阈值。
- 后处理消息时间倒退。

漂移检测会延迟 1 秒再 warning，因为 seek 后第一帧 backfill 可能天然与 currentTime 相差较大。

时间倒退会生成 `PlayerAlert`，最终合并进 `playerState.alerts`。

## 26. 为什么默认不记录错误消息对象

`MessageOrderTracker` 有 `#trackIncorrectMessages` 开关，默认 false。

注释说明：把错误消息对象打印到 console 会阻止它们被垃圾回收，直到 console 被清空。

这是一个容易忽略的调试陷阱。

如果为了排查临时打开详细消息记录，排查完要关闭并清理 console。

## 27. PlaybackPerformance 面板

`PlaybackPerformance` 面板从 MessagePipeline 读取 `playerState.activeData`。

它计算并展示四类指标：

- playback speed，相对 realtime。
- framerate。
- bag frame 时间跨度。
- Mbps。

它维护最近 5000ms 的 sparkline 点，并显示当前值和平均值。

这是用户可见的播放性能观察入口。

## 28. PlaybackPerformance 的数据来源

该面板比较当前 activeData 与上一帧 activeData。

如果正在播放、没有 seek、currentTime 变化，它用 player time delta 除以真实 render time 得到播放速度。

它还用 `totalBytesReceived` 的差值计算 Mbps。

因此如果 Mbps 很高但 fps 很低，瓶颈可能在消息处理或渲染。

如果 Mbps 很低但播放卡顿，瓶颈可能在数据源读取、网络、解码或等待异步面板。

## 29. PerformanceContext

`PerformanceContext` 定义了通用性能指标接口：

- register metric。
- unregister metric。
- add measurement。
- scope timer。

默认实现是 no-op。

当前源码中明确使用该接口的是 `UserScriptPlayer`，它注册 `"User scripts (total)"`，统计每帧用户脚本总耗时。

## 30. UserScriptPlayer 性能指标

`UserScriptPlayer` 在处理 activeData 时注册脚本总耗时指标，单位是 ms per frame。

处理帧时用 `scopeTimer` 包住脚本计算逻辑。

close 时会 unregister metric。

如果脚本导致播放卡顿，这个指标是定位脚本耗时的入口。

## 31. Panel 的开发态 profiler

`Panel.tsx` 用 React `Profiler` 包裹每个 panel。

在非 production 环境下，它会显示一个小的 perfInfo：

```text
render count
actualDuration ms
```

这个信息只在开发环境显示。

它用于快速判断某个 panel 是否频繁重渲染或单次渲染耗时过高。

## 32. PanelLogs

每个 panel context 中都有 `logError` 和 `logCount`。

`PanelErrorBoundary` 捕获 panel render error 后，会调用 `onLogError` 写入 panel logs。

`PanelLogs` 显示日志数量、时间、INFO/ERROR 前缀和错误堆栈。

日志面板可以关闭、清空，并支持拖拽调整高度。

## 33. PanelErrorBoundary

`PanelErrorBoundary` 只包 panel 子树。

某个 panel 渲染崩溃时，不会拉垮整个应用。

错误 UI 提供三个操作：

- Dismiss。
- Reset Panel。
- Remove Panel。

这让用户可以从坏配置或坏面板代码中恢复。

## 34. 全局 ErrorBoundary

`ErrorBoundary` 是更通用的错误边界。

它捕获 children 中的错误，调用 `reportError`，并展示可 dismiss 的错误界面。

与 `PanelErrorBoundary` 不同，它没有 panel reset/remove 语义。

## 35. CaptureErrorBoundary

`CaptureErrorBoundary` 捕获错误后只调用 `onError`，并停止渲染 children。

它适合需要把错误交给外部状态或测试断言处理的场景。

这个边界不展示 UI。

## 36. MemoryUseIndicator

`MemoryUseIndicator` 通过 `useMemoryInfo` 每 5000ms 读取一次 JS heap 信息。

它显示：

- usedJSHeapSize 占 jsHeapSizeLimit 的百分比。
- tooltip 中的 used MB 和 limit MB。

它受 `ENABLE_MEMORY_USE_INDICATOR` app setting 控制，显示在 AppBar 右侧。

如果浏览器环境不支持 memory info，则不渲染。

## 37. 内存指标的解释限制

JS heap 百分比只能说明 JavaScript heap 使用情况。

它不覆盖所有 native memory、GPU memory、worker 内部实现细节和浏览器缓存。

因此它适合观察趋势，不适合当成精确总内存。

如果 heap 持续增长且不回落，才优先怀疑对象保留、消息缓存、console 引用或未释放 worker。

## 38. messageMemoryEstimation

`messageMemoryEstimation.ts` 提供消息对象内存估算工具。

它基于 V8 对象模型估算：

- object base size。
- array base size。
- typed array size。
- primitive field size。
- dictionary mode object 额外开销。
- nested message 类型大小。

估算不保证精确，但在没有动态字符串和动态数组时，比序列化字节数更接近 JS 对象占用。

## 39. estimateMessageObjectSize

`estimateMessageObjectSize` 根据 schema definition 估算反序列化消息对象大小。

它使用 `knownTypeSizes` 缓存已计算类型。

如果遇到递归类型，会通过 `checkedTypes` 避免无限递归。

如果 schema 缺失，会抛出错误。

这类估算可用于判断某个 topic 在内存中比原始 bytes 膨胀多少。

## 40. estimateObjectSize

`estimateObjectSize` 用于估算任意 JS 值。

它支持：

- undefined。
- boolean。
- number。
- bigint。
- string。
- Array。
- typed array。
- Set。
- Map。
- object。

它不支持 symbol 和 function，会抛出错误。

这与用户脚本日志不允许函数也一致：函数不是适合进入可序列化数据管线的值。

## 41. CachedFilelike 的定位

`CachedFilelike` 是远程或流式文件读取的缓存层。

它实现 `Filelike`，用 `VirtualLRUBuffer` 尽量缓存已读字节范围。

它的目标是让 MCAP、bag 等文件读取可以按 range 请求，同时避免每次 seek 都重新下载或重新读取相同字节。

## 42. CachedFilelike 的 cacheSizeInBytes

构造参数 `cacheSizeInBytes` 控制最多缓存多少字节。

它同时也是单次 read 请求允许的最大长度。

如果请求长度超过缓存大小，会抛出错误。

这避免一次读取超过缓存容量，导致 VirtualLRUBuffer 无法保证后续 slice 可用。

## 43. CachedFilelike 的 read-ahead

当没有待处理 read requests 时，`CachedFilelike` 会尝试智能预读。

它偏好最近一次 resolved range 后面的数据。

如果缓存大小足够覆盖整个文件，则会尝试下载完整文件。

read-ahead 可以提升顺序读取性能，但也意味着打开大文件时要关注 cache size 和网络流量。

## 44. CachedFilelike 的连接切换

`CachedFilelike` 只维护一个当前 active connection。

如果新的 range 更合适，它会 destroy 当前 stream，再打开新的 fetch stream。

旧 stream 的 data 和 error 会被忽略，避免旧连接回调污染当前状态。

## 45. CachedFilelike 的错误恢复

stream error 时，如果设置了 `keepReconnectingCallback`，它会持续重试并通知 reconnecting 状态。

如果没有该 callback，短时间内连续两次错误会认为是严重错误，reject 所有剩余 read requests 并关闭。

这区分了“网络偶发抖动”和“数据源不可恢复错误”。

## 46. VirtualLRUBuffer

`VirtualLRUBuffer` 表示一个可能很大的虚拟连续字节空间。

内部用多个较小 block 存储实际数据。

它支持：

- `hasData(start, end)`。
- `getRangesWithData()`。
- `copyFrom(source, targetStart)`。
- `slice(start, end)`。

当 block 数超过限制时，会删除 least recently used block，并从 rangesWithData 中移除对应范围。

## 47. VirtualLRUBuffer 为什么不复用被删除 block

源码注释说明：不复用被淘汰 block，因为其他代码可能还持有 `slice` 返回的引用。

如果复用同一块内存，旧 slice 可能看到新数据。

因此淘汰时直接删除 block，让旧引用继续指向旧内容。

这是内存安全优先于复用的选择。

## 48. WebWorkerManager

`WebWorkerManager` 管理一组同类 worker。

它最多创建 `maxWorkerCount` 个 worker。

注册 listener 时：

- 如果 worker 数量未达上限，创建新 worker。
- 如果已达上限，把 listener 分配给 listener 数最少的 worker。

注销 listener 时，如果某个 worker 没有 listener，会 terminate worker 和 rpc。

## 49. Chart worker 的资源共享

`components/Chart/index.tsx` 使用 `WebWorkerManager(makeChartJSWorker, 4)`。

这意味着多个 chart 组件共享最多 4 个 Chart.js worker。

这样可以避免每个图表都创建独立 worker，导致线程和内存数量随面板数线性增长。

## 50. RpcWorkerUtils

`setupWorker` 会在非 test 环境中：

- 安装 notification handler。
- overwrite fetch。

worker 内部错误可以通过通知机制回到主线程。

overwrite fetch 用于统一 worker 环境下的 fetch 行为和错误处理。

用户脚本 worker 还有额外的 fetch blocking 逻辑，这在第 9 篇已经说明。

## 51. worker 泄漏排查

如果怀疑 worker 泄漏，优先检查：

- 创建 worker 的 manager 是否有 unregister。
- panel unmount 时是否注销 listener。
- player close 时是否 terminate worker。
- script registration terminate 是否执行。
- chart、plot、image decoder 等 worker 是否有复用上限。

相关路径包括 `WebWorkerManager`、`UserScriptPlayer.close()`、图表 worker 和各类 player worker。

## 52. UserScriptPlayer 的内存控制

`UserScriptPlayer` 中有多个内存控制点：

- script registration cache 会裁剪。
- batch iterator cache 会失效。
- runtime worker 会复用或 terminate。
- transform worker 会在 close 时关闭。
- `MAX_GLOBAL_BUFFER_SIZE` 限制共享 batch 缓存。
- alert store 只保存有限的 player alert 信息。

这些机制避免脚本编辑、历史读取和多消费者读取导致无限增长。

## 53. UserScriptPlayer 的调试入口

脚本相关性能或错误优先看：

- User Script Editor Alerts。
- User Script Editor Logs。
- `playerState.alerts`。
- `"User scripts (total)"` 性能指标。
- `batch-iterator-buffer-overflow` warning。
- runtime worker 错误。
- transformer diagnostics。

如果 UI 卡顿只在脚本启用后出现，优先排查脚本输入 topic 频率和脚本执行复杂度。

## 54. 面板重渲染排查

如果某个面板频繁重渲染，先看开发态 panel perfInfo。

然后检查：

- selector 是否返回新对象。
- topics、datatypes、services 引用是否每帧变化。
- config 是否在 render 中被写回。
- globalVariables 是否高频变化。
- converter 是否在变量变化时重跑。
- panel 是否订阅了过多高频 topics。

不要先改 memo。先确认哪一个输入引用在变化。

## 55. 消息过多排查

如果数据吞吐过高，按顺序检查：

- PlaybackPerformance 的 Mbps。
- Message rate 设置。
- panel 订阅 topics 数量。
- fields 是否请求 all fields。
- sampling 是否被合并策略丢弃。
- UserScriptPlayer 是否把虚拟订阅 remap 成多个真实输入 topic。
- 是否有 full preload 订阅。

目标是减少进入 player 和 MessagePipeline 的消息量，而不是只在 panel 里过滤。

## 56. 内存增长排查

如果 JS heap 持续增长，按顺序检查：

- 是否频繁切换 data source。
- MessagePipeline 是否正确 close old player。
- `createPlayerListener` 是否被修改为捕获外层大对象。
- `lastMessageEventByTopic` 是否保留不再订阅的 topic。
- panel logs 是否无限增长。
- console 是否打印了大消息对象。
- CachedFilelike cache size 是否过大。
- VirtualLRUBuffer 是否按 block 淘汰。
- worker 是否 terminate。
- UserScript batch cache 是否 overflow。

重点是找“谁还持有引用”，不是只看对象创建位置。

## 57. 消息错序排查

如果 UI 提示 Data went back in time，检查：

- 数据源是否 emit 了时间倒退的消息。
- seek 后是否更新了 `lastSeekTime`。
- UserScriptPlayer 是否在暂停态或重算时混入旧消息。
- batch iterator 是否按 receiveTime 合并。
- wrapper player 是否改变了消息顺序。

`MessageOrderTracker` 是最终检测点，但错误通常来自它之前的层。

## 58. 面板空白排查

面板空白不一定是数据源问题。

按顺序检查：

- panel 是否被 `PanelErrorBoundary` 捕获错误。
- PanelLogs 是否有 ERROR。
- MessagePipeline 中该 subscriber 是否有订阅。
- playerState 是否有 activeData。
- topic 是否出现在 sortedTopics。
- lastMessageEventByTopic 是否已有该 topic。
- converter 是否抛错。
- globalVariables 是否导致 converter 输出为空。

如果只是当前 panel 空白，不要先重启数据源。先看 panel 边界和订阅。

## 59. 变量导致性能问题

全局变量变化会进入多个链路：

- MessagePipeline 直接监听 layout 并调用 `player.setGlobalVariables`。
- UserScriptPlayer 用最新变量执行脚本。
- PanelExtensionAdapter 在 variables changed 时更新 renderState。
- message converters 可能在没有新 frame 时基于 last messages 重跑。

如果某个变量由 slider 高频写入，可能导致扩展面板和 converter 高频执行。

`VariableSlider` 已经对写入做 250ms debounce，但其他入口不一定有同样节流。

## 60. 为什么 MessagePipeline 直接监听 globalVariables

MessagePipeline 没有让全局变量变化触发整个 Provider 重渲染。

它直接监听 CurrentLayoutContext，并在变量对象引用变化时调用 player。

这是性能设计：变量高频变化时，避免整棵 MessagePipeline children 重新 render。

如果未来修改这段逻辑，要确认不会把变量变化变成全局 React 更新风暴。

## 61. alert、diagnostic、log 的区别

项目中有三类常见问题输出：

- alert：播放器或管线级问题，进入 `playerState.alerts` 或全局 alerts。
- diagnostic：脚本或编译类结构化诊断，通常有 severity、source、code 和位置。
- log：面板或用户脚本主动记录的信息，用于调试和辅助展示。

排查时要先分清是哪一类。

脚本类型错误看 diagnostics；播放器时间错序看 alerts；panel render 错误看 PanelLogs 和 ErrorBoundary。

## 62. reportError 的作用边界

`PanelErrorBoundary` 和 `ErrorBoundary` 都会调用 `reportError(new AppError(...))`。

这用于集中错误上报。

但上报不等于恢复。恢复能力来自错误边界 UI：dismiss、reset panel、remove panel 或重启 app。

## 63. 日志本身也可能占内存

PanelLogs 存在 React state 中。

如果一个 panel 高频记录大对象或错误堆栈，日志本身会保留对象和字符串。

UserScript logs 也类似，存储在 `UserScriptStateContext` 中。

因此日志适合调试，不适合作为高频数据通道。

## 64. console 调试的风险

浏览器 console 会保留被打印对象的引用。

这在 `MessageOrderTracker` 注释中被明确提到。

如果把大消息、frame、playerState 或 datatypes 打到 console，内存可能因为 console 引用而不释放。

排查内存问题时，要清理 console，并避免持续打印大对象。

## 65. 数据源读取与 UI 卡顿的区分

判断卡顿来源可以用这个顺序：

1. 看 PlaybackPerformance 的 Mbps 和 fps。
2. 降低 Message rate，看卡顿是否明显缓解。
3. 关闭重型 panel，例如 Plot、3D、图像面板。
4. 禁用或删除用户脚本。
5. 减少订阅 topic 和字段。
6. 切换本地/远程数据源对比。

如果降低 message rate 后明显缓解，瓶颈多半在 UI 分发或渲染。

如果关闭面板后缓解，瓶颈在 panel 或 converter。

如果任何 UI 降载都无效，继续看数据源读取和 worker。

## 66. Plot 和图表类面板的特殊性

Plot、TimeBasedChart、Chart worker 类组件通常不只是 React render。

它们可能：

- 在 worker 中构建 dataset。
- 在 canvas 或 offscreen canvas 中绘制。
- 使用 pauseFrame 控制帧同步。
- 保留历史数据窗口。

因此对图表卡顿不要只看 React profiler，也要看 worker、dataset、订阅和历史范围读取。

## 67. 3D 和图像面板的特殊性

3D、图像和模型渲染通常涉及 GPU、纹理、模型缓存和 worker decoder。

JS heap 指标不一定能反映 GPU memory。

如果关闭 3D 或图像面板后系统内存下降，但 JS heap 没明显变化，问题可能在 GPU 或 browser native 层。

这种情况需要结合浏览器任务管理器和 devtools memory 工具。

## 68. 远程文件缓存排查

远程 MCAP 或 bag 读取慢时，重点看：

- `CachedFilelike` 是否频繁 destroy connection。
- range 请求是否跳跃过大。
- cacheSizeInBytes 是否太小。
- read-ahead 是否有效。
- 网络错误是否触发连续重试。
- VirtualLRUBuffer 是否频繁淘汰刚读过的 block。

如果 seek 模式非常随机，再大的 read-ahead 也不一定有效。

## 69. 资源释放检查清单

切换数据源或关闭面板后，应该释放：

- player listener。
- old player。
- worker listener。
- worker RPC。
- script registrations。
- panel subscriptions。
- publishers。
- logs 或缓存中的临时状态。
- file stream。
- frame pause promise。

如果内存不降，就沿这些对象找引用链。

## 70. 测试入口

性能和调试相关测试分布在多个文件：

- `packages/suite-base/src/components/MessagePipeline/index.test.tsx`
- `packages/suite-base/src/components/MessagePipeline/subscriptions.test.ts`
- `packages/suite-base/src/components/MessagePipeline/MessageOrderTracker.test.ts`
- `packages/suite-base/src/players/messageMemoryEstimation.test.ts`
- `packages/suite-base/src/util/WebWorkerManager.test.ts`
- `packages/suite-base/src/util/CachedFilelike.test.ts`
- `packages/suite-base/src/components/PanelErrorBoundary.test.tsx`
- `packages/suite-base/src/components/PanelLogs.test.tsx`
- `packages/suite-base/src/players/UserScriptPlayer/index.test.ts`

学习时可以用这些测试反推边界条件。

## 71. 修改性能敏感代码的原则

改 MessagePipeline、subscription、worker、cache、panel render 时，优先遵守这些原则：

- 保持引用稳定。
- 不在热路径创建无意义对象。
- 不把所有消息广播给所有 panel。
- 不在 console 打印大对象。
- 不让 worker 或 listener 缺少 unregister。
- 不让变量变化触发整棵树重渲染。
- 不绕过 player close 和 panel unmount 清理。
- 不把调试日志当作数据通道。

这些原则比单个优化技巧更重要。

## 72. 性能问题的最短定位表

| 现象                   | 优先检查                          | 关键源码                                                                    |
| ---------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| fps 低、Mbps 高        | UI 分发和渲染                     | `packages/suite-base/src/components/MessagePipeline/index.tsx`              |
| fps 低、脚本启用后明显 | 用户脚本执行                      | `packages/suite-base/src/players/UserScriptPlayer/index.ts`                 |
| 新打开面板没有数据     | subscription 和 last message      | `packages/suite-base/src/components/MessagePipeline/store.ts`               |
| 切换数据源后内存不降   | player listener 和 old state 引用 | `packages/suite-base/src/components/MessagePipeline/index.tsx`              |
| 远程文件 seek 慢       | range cache 和 read-ahead         | `packages/suite-base/src/util/CachedFilelike.ts`                            |
| 图表播放拖慢           | pauseFrame 和 worker render       | `packages/suite-base/src/components/TimeBasedChart/index.tsx`               |
| 单个 panel 崩溃        | PanelErrorBoundary 和 PanelLogs   | `packages/suite-base/src/components/PanelErrorBoundary.tsx`                 |
| 消息时间倒退           | MessageOrderTracker               | `packages/suite-base/src/components/MessagePipeline/MessageOrderTracker.ts` |

## 73. 推荐阅读顺序

建议按这个顺序读源码：

1. 先读 `packages/suite-base/src/components/MessagePipeline/index.tsx`，理解帧背压和 listener。
2. 再读 `packages/suite-base/src/components/MessagePipeline/store.ts`，理解订阅、分桶和 last message。
3. 再读 `packages/suite-base/src/components/MessagePipeline/subscriptions.ts`，理解订阅合并。
4. 再读 `packages/suite-base/src/components/MessagePipeline/MessageOrderTracker.ts`，理解时间错序检测。
5. 再读 `packages/suite-base/src/components/Panel.tsx`、`packages/suite-base/src/components/PanelErrorBoundary.tsx` 和 `packages/suite-base/src/components/PanelLogs.tsx`，理解 panel 调试。
6. 再读 `packages/suite-base/src/util/CachedFilelike.ts` 和 `packages/suite-base/src/util/VirtualLRUBuffer.ts`，理解文件缓存和内存控制。
7. 最后读 `packages/suite-base/src/players/UserScriptPlayer/index.ts`，把脚本性能与 MessagePipeline 串起来。

## 74. 本篇结论

Lichtblick 的性能设计不是单点优化，而是一组贯穿数据流的控制机制：

- MessagePipeline 控制帧推进和订阅合并。
- subscriber buckets 控制消息分发范围。
- pauseFrame 让重型面板参与背压。
- PlaybackPerformance 和 panel profiler 提供观察入口。
- MemoryUseIndicator 和 message memory estimation 提供内存趋势与估算。
- CachedFilelike 和 VirtualLRUBuffer 控制远程文件读取缓存。
- WebWorkerManager 控制 worker 数量和生命周期。
- ErrorBoundary、PanelLogs、diagnostics 和 alerts 让错误可见且可恢复。

调试时要沿数据流定位：先确认数据是否进入，再确认订阅是否正确，再确认转换是否执行，最后确认 UI 是否渲染和释放资源。
