# CairnKV 规格收口决议（M0 开工前）

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-29（第三版：并入三路审阅的修订，见 §2.4） |
| 性质 | 作者授权 Claude 代为决策。本文件给出每项的**最终决定 + 理由 + 证据**；只有 §6 的问题需要作者回答 |
| 权威性 | 分工见 §5（SC-43）：**字节布局以 `docs/file-format.md` 为准，协议与恢复以 `docs/durability.md` 为准**；本文件负责决定与理由。本文件与研究文档（D02 / D03 / iter 工件）冲突时，以本文件为准 |
| 引用约定 | `D02` / `D03` = `docs/research/DELIVERABLE-02/03-*.md`；`iter-NN` = `.autoresearch/work/iter-NN-*.md`；`FF` = `docs/file-format.md`；`DU` = `docs/durability.md`。源码引用 `<repo>/<path>:<line>` 指 `.autoresearch/third_party/` 下的钉版（`PINS.md`）。`.autoresearch/` 不在版本管理内，**只能在本机复核** |

---

## 0. 一页总结

- 第一版清单的 18 项已全部定案：16 项由我代为决定，模块路径（SC-13）、许可证（SC-14）2 项由你回答（§6）。另补了 SC-19（临时文件）、SC-20（公开错误集合），以及根据你对 Linux 环境的回答新增的 SC-21（Linux 验证环境，基于本机 Docker 实测，见 §2.2）。
- 这一轮核对又发现 **3 个新问题**（§1）。其中 F-1 是严重缺陷：照研究里的 WAL 判定表实现，**一次普通崩溃后数据库就可能打不开**；如果为了绕过它改成「遇到坏记录就截断」，又会**静默丢掉已确认的写入**。
- 新增 **8 项创新**（§3）。筛选标准有三条：有可查的工业或学术先例；能把一类「静默错误」变成可检测的错误或可执行的测试；代价小，在现有里程碑内就能完成。其中 I-1 修复 F-1，SC-11 消除 F-2。
- 编写正式规格时又补定了 21 项（SC-22 ~ SC-42，§2.3）。正式规格已写成 `docs/file-format.md` 与 `docs/durability.md`。
- 三路对抗式审阅（格式、协议、一致性）找出 11 个 P0、28 个 P1。主要问题有三类：
  - Open 顺序：崩溃两次后库就可能打不开；
  - 文件号复用、MANIFEST 并发追加、标记删除过早；
  - 文档之间的优先级写反了。
  
  全部修订记在 SC-43 ~ SC-58（§2.4），FF、DU 已改为第二版。
- 工作量估计（**估计，非测量**）：8 项创新合计约 +1.5～2 个人周单位（D03 §12 原计划共 14.5）。I-4、I-7 在时间紧时可以砍，回退到 D03 原方案。

---

## 1. 本轮新发现的问题

### F-1 · WAL 判定表与「崩溃不是损坏」冲突（严重）

- iter-05 的 9 条判定表第 4 行规定「CRC 不匹配 ⇒ 报 Corruption」，**不区分位置**（`iter-05…md:194`）。
- 但普通崩溃本身就会在文件尾留下 CRC 不匹配的残缺 chunk：未 fsync 的数据按页随机落盘（这正是 D03 M2-14 `CrashClone` 要模拟的模型）。如果 chunk 头所在的页落盘了、payload 所在的页没落盘，CRC 就会不匹配。
- 照表实现，崩溃后 `Open` 返回 `ErrCorruption`，崩溃克隆测试必然失败。实现者为了让测试通过，很可能改成「遇到 CRC 失败就截断」；这样一来，已 fsync 的区域一旦发生位翻转，**已确认的写入会被静默丢弃**（iter-05 自己在 `:208-210` 也警告过这种实现）。
- 工业做法：RocksDB 默认 `kPointInTimeRecovery`，遇到第一处不一致就停止重放（`rocksdb/include/rocksdb/options.h:438-442`），也就是上面的截断做法。Pebble 新增了 `FormatWALSyncChunks`：chunk 头带「已同步偏移」承诺，可以借助后面的 chunk 判断损坏区域是否早已同步（`pebble/record/record.go:87-98`、`pebble/format_major_version.go:204-209`）。
- **决定**：采用 I-1。

### F-2 · 魔数的字节序自相矛盾

- iter-10 §6 写道：SHA-256 前 8 字节为 `53 c9 fb 8c e5 08 ea 61`，所以 `magic = 0x53c9fb8ce508ea61`，并称「小端写入文件时字节序即为上式顺序」（`iter-10…md:180-182`）。**后半句不成立**：按小端写入 `0x53c9fb8ce508ea61`，文件里的字节是 `61 ea 08 e5 8c fb c9 53`，顺序正好相反。实现者按「数值」写和按「字节」写，会得到两种互不兼容的文件。（SHA-256 前缀本身已复算，无误。）
- **决定**：采用 SC-11，直接用字节数组作魔数，从根上消除字节序问题。

### F-3 · 没有规定 WAL 轮换前旧 WAL 必须完整 fsync

- 设想旧 WAL 末尾是几笔 `NoSync` 写入，没有 fsync 就切到了新 WAL，而新 WAL 里的写入已经同步确认。此时崩溃，旧 WAL 的尾部丢失、新 WAL 完好，恢复结果就「中间缺一段」，不对应任何真实存在过的时刻。
- Pebble 的做法是：只有**最后一个** WAL 允许不完整的尾部，其余 WAL 一律严格校验（`pebble/open.go:384`、`pebble/recovery.go:547-554`）。这隐含了「轮换前旧 WAL 已完整同步」。
- **决定**：新增不变量 **INV-6**：WAL 轮换前，旧 WAL 必须先 flush 再 fsync 完成。恢复时只有最后一个 WAL 适用 I-1 的 torn tail 规则，其余 WAL 只要出现无效 chunk 就报 `ErrCorruption`。

---

## 2. 逐项决议

| # | 决定 | 理由 |
|---|---|---|
| SC-01 footer | 采用 RocksDB format_version 6 式的 53 字节 footer（自带校验和与上下文校验和），索引、过滤器、属性块的句柄全部放进 metaindex。布局见 I-2 | D03 的写法放不进 53 字节；RocksDB v6 在同样 53 字节内还多了 footer 自校验 |
| SC-02 校验和类型 | 只支持 masked CRC32C（`checksumType = 1`），该字节保留作演进位；其他值 ⇒ `ErrCorruption` | 少一个旋钮；与 AS-4「不猜测」同一原则 |
| SC-03 WAL tag | WAL 条目直接复用内部键 kind（`1=Set 2=Delete`）；`0` 与未知值 ⇒ `ErrCorruption` | 全项目只有一个 kind 枚举，杜绝「全零 = 删除」 |
| SC-04 vfs | `File`：`Read` `ReadAt` `Write` `WriteAt` `Close` `Stat` `Sync` `SyncData` `SyncTo` `Truncate`。`FS`：`Create` `Open` `OpenDir` `Remove` `Rename` `MkdirAll` `Lock` `List` `Stat`。目录同步统一用 `OpenDir(dir)` + `Sync()`，另提供辅助函数 `vfs.SyncDir`。`Lock` 用 `flock`（SC-40）。**删掉** `Preallocate`、`Link`、`RemoveAll`。`vfs` 是**公开包**，稳定性为**实验级**，os 与内存两种实现都放在其中。故障注入包 `errorfs` 留在 `internal/`。**内存实现从 M0 起就要区分已同步与未同步的数据和目录项，并记录操作轨迹**（M1 的 I-4 依赖这一点） | 只保留用得到的方法：`Rename` 用于隔离孤儿表（DU R12），`Truncate` 用于 M1 的过渡实现（DU T4）；要加方法随时可以加。ext4 上 `fallocate` 生成的是未写入区段，写入时仍要改元数据，iter-04 声称的收益不成立（**推断，未实测**）。公开包让 `Options.VFS` 能被测试和示例注入（Pebble 也公开了 `vfs`） |
| SC-05 命名 | 统一使用权威名（`MaxLevels` / `LevelMultiplier` / `BaseLevelSize` / `MemTableCountLimit`），旧名只出现在 `options.go` 注释的「别名」行 | 文档勘误，没有语义变化 |
| SC-06 store 级版本 | 独立的 `marker.format-version.<iter>.<N>`，复用标记文件机制；打开时最先读它，版本越界 ⇒ 拒绝打开 | 必须在解析 MANIFEST 之前就知道格式版本（`pebble/format_major_version.go:426`）。同一把版本锁同时约束 SSTable 格式的上下限（iter-15 §5） |
| SC-07 IndexFilterBudget | 「常驻集 + 按层优先降级」，见 I-7 | 让第三笔预算有可执行、可单测的机制 |
| SC-08 WAL 文件头 | 48 字节，位于块 0 开头；块边界仍是 32 KiB 的整数倍；头部带自身校验和；MANIFEST 结构相同，魔数不同。布局见 §2.1 | 头部也在校验范围内；块对齐不被头部打乱 |
| SC-09 大小上限 | 常量 `MaxKeySize = 64 KiB`，超出 ⇒ `ErrKeyTooLarge`。批次的**内存表占用估算**（SC-53）超过 `MemTableSize / 2` ⇒ `ErrBatchTooLarge`，在 **WAL 写入之前**判定。`Open` 时校验 `64 KiB ≤ MemTableSize ≤ 1 GiB` | 阈值的量级与 Pebble 的大批次旁路一致（`pebble/open.go:160`）。将来实现旁路时，只是把「拒绝」放宽成「接受」，向后兼容。默认配置下单批约 2 MiB，要写进文档 |
| SC-10 比较器 | `Comparer` 接口放在根包（`Options.Comparer` 是公开字段），包含 `Compare`、`Name`、`Separator`、`Successor` 四个方法；默认实现为 `DefaultComparer`（字节序）。契约：`Separator(a, b)`（a < b）返回 x，满足 `a ≤ x < b`；`Successor(a)` 返回 x，满足 `x ≥ a`。写入端会再次检查返回值，不合法就回退（FF §5.5） | 缩短索引键，避免索引块膨胀。分隔键的封装规则按 Pebble（不要求比原键更短），详见 FF §5.5 |
| SC-11 魔数 | 三种文件都用 8 字节 ASCII 字节数组：`"CairnWAL"` / `"CairnMAN"` / `"CairnSST"`，**按字节写入，不当整数处理** | 消除 F-2；用 `xxd` 一眼就能认出（直接服务学习目标里的「手工解码」）；不再依赖模块路径，仓库搬家不影响磁盘格式 |
| SC-12 Go 版本 | `go 1.27`（本机为 go1.27.2 darwin/arm64） | 没有下游使用者，不必维护版本矩阵；I-6 用到的 `testing/synctest` 从 1.25 起正式可用 |
| SC-13 模块路径 | `github.com/LystranG/cairnkv`（H-1 已回答：用你的 GitHub 账号，账号名取自 `gh repo list`） | Go 模块路径允许大小写混用（如 `github.com/BurntSushi/toml`），与 GitHub 账号保持一致即可。魔数已不依赖它 |
| SC-14 许可证 | Apache-2.0（H-2 已回答），M0 加入 `LICENSE`。移植规则：从 LevelDB / Pebble（BSD-3）或 Badger（Apache-2.0）移植的代码，文件头保留原版权行并注明来源，原许可证全文放入 `LICENSES/<项目>.txt` | BSD-3 与 Apache-2.0 都要求保留版权声明；集中放置便于核对 |
| SC-15 Snappy | 使用 `github.com/klauspost/compress`：写入用 `s2.EncodeSnappy`（输出标准 Snappy 块），读取用 `s2.Decode` | 有正式 tag（2026-10-29 查得最新 `v1.20.3`，仓库未归档）；同一个依赖还提供 M5 要对照的 Zstd。README 写明可以生成完全兼容 Snappy 的块（`s2/README.md` 的 Blocks 一节）。M2 开工时我会用一组块和 `golang/snappy` 互相解码做验证，验证放在临时目录里，不进 `go.mod` |
| SC-16 任务管理 | 用 justfile（本机已安装 `just`），不建 Makefile | 两者只留一个 |
| SC-17 CI | 本地优先，`just ci` 分阶段扩充：<br>• **M0**：`gofmt -l`、`go vet`、`staticcheck`（用 `go run honnef.co/go/tools/cmd/staticcheck@<钉版>`，不写进 `go.mod`）、`go test ./...`、`go test -race ./...`、依赖方向检查（覆盖草案 §6.2 的全部禁止规则）。<br>• **之后**：D03 §9.2 其余门禁和 I-4、I-5、I-6 的检查，随所属里程碑加入。<br>`just test-linux` 在本机 Docker 中补跑 Linux（SC-21）。GitHub Actions 配置也一并备好，推送后生效（H-4） | 单人项目，每天真正在跑的门禁是本地这一道；开发机是 macOS，Linux 覆盖靠 Docker。D03 的门禁里有 M0 时还不存在的包，所以要分阶段 |
| SC-18 草案修订 | 已改为 v0.2（落实 C-1 / C-2 / C-3 与本文件的决议），文末附变更记录。v0.1 原文另存为 `docs/archive/cairnkv-design-overview-go-v0.1.md`（逐处反向还原，字节数与原文一致）。C-1 / C-2 / C-3 的定义见 D02 §16.3 | 你已授权代为决策 |
| SC-19 临时文件（新增） | SSTable **直接以最终文件名写入**，不经过 `.tmp` 再重命名；v1 不产生 `.tmp`，但启动清理仍删除任何 `*.tmp`（防御） | SSTable 只有被 MANIFEST 登记后才算存在，未登记的 `.sst` 启动时会被清理（iter-15 R6）。先写临时名再重命名不增加任何安全性，只多一次 rename 和一次目录同步。草案 P-06 要求的「原子切换」由标记文件实现：创建新标记文件这个目录项操作本身是原子的 |
| SC-20 公开错误集合（新增） | 公开错误共 10 个：`ErrNotFound` `ErrCorruption` `ErrUnsupported` `ErrEnginePoisoned` `ErrClosed` `ErrSequenceExhausted` `ErrKeyTooLarge` `ErrBatchTooLarge` `ErrWriteStall` `ErrInvalidOptions`（后补，见 SC-39）。`ErrArenaFull` **降为内部错误**；`ErrReadOnly` 删除（SC-55）。背压档位由 `WriteOptions.OnStall` 逐次选择：`StallBlock`（零值，默认）或 `StallReturnError` | D03 M0-2 漏了 `ErrClosed`；§4.2 列举的 `Apply` 返回值漏了 `ErrSequenceExhausted`；`ReturnError` 档既没有错误名，也没有选择方式。按内存表占用设上限，并按目标表容量组建写组（SC-53），保证批次一定装得进新内存表。拒绝点必须在写 WAL **之前**；通过准入之后，不得再因过载失败（D03 M3-5 的约束） |
| SC-21 Linux 验证环境（新增） | 用本机 Docker（OrbStack）跑 Linux 功能测试和 ext4 / xfs 冒烟测试；**不引入 testcontainers-go**；dm-log-writes 实验和最终性能数据不在本机做。详见 §2.2 | 基于 2026-10-29 本机实测 |

### 2.1 WAL / MANIFEST 文件头（SC-08 的字节布局）

- 决定：头部 48 字节，依次为魔数、版本、flags、blockSize、fileNum、dbID、reserved、头部校验和。块边界仍按 32 KiB 对齐，块 0 的可用区从偏移 48 开始。头部无效时视为「X = 0」，交给 I-1 规则判定。WAL、SSTable、MANIFEST 共用同一个文件号计数器。
- **逐字节布局与各字段的判定顺序只写在 FF §2.1 一处**（SC-43）。本节不再重复，避免两处维护。

### 2.2 Linux 验证环境（SC-21，2026-10-29 本机实测）

本机 Docker 是 OrbStack：Linux 内核 `7.2.12-orbstack`（arm64），容器根文件系统为 overlayfs，容器卷在 btrfs 上，没有 `/dev/kvm`。

| 测试项 | 结果 | 结论 |
|---|---|---|
| 容器里运行 Linux 版二进制 | 可行 | Linux 功能测试可以在本机做 |
| 特权容器 + loop 设备 + `mkfs.ext4` / `mkfs.xfs` + 挂载 | 可行 | 能在真实的 ext4 / xfs 代码路径上跑持久化测试 |
| `dm-log-writes` / `dm-flakey` | **不可用**：建设备映射返回 `Invalid argument`，`/proc/config.gz` 里没有这两个目标 | V-09 的真实文件系统崩溃实验**不能**在本机做 |
| 嵌套虚拟机（QEMU + KVM） | 不可用（没有 `/dev/kvm`） | 也没法在本机换一个内核来绕过 |
| 「追加 4 KiB + fsync」的 p50 延迟 | 宿主 APFS（F_FULLFSYNC）3.9 ms；容器卷 0.49 ms；容器根文件系统 0.43 ms；macOS 目录绑定挂载 0.15 ms；loop 上的 ext4 1.24 ms、xfs 0.77 ms | VM 里的 fsync 比宿主真正落盘便宜约 8 倍，**大概率没有做到 F_FULLFSYNC 那一级（推断）**。同步档位的性能差距在本机会被明显低估，只能作开发期参考 |

**决定**：

1. **用 Docker，不用 testcontainers-go。** testcontainers 的核心价值是在测试里拉起数据库、消息队列这类外部依赖；CairnKV 是嵌入式引擎，没有外部依赖，我们只需要「在 Linux 内核上跑自己的测试」，一条 `docker run` 就够了。testcontainers-go 最新版 v0.44.0 有 49 个直接依赖（包括 moby 客户端），和「核心模块不加非必要依赖」相悖。
   - **重新评估的触发条件**：M4 验收标准 5（「磁盘变慢时服务端内存不无限增长」）如果要在 Go 测试里断言容器状态（例如在内存上限下有没有被 OOM 杀掉），再考虑引入，而且放进独立的嵌套模块（如 `test/containers/go.mod`），不进主模块。
2. **`just test-linux`**（M0 起）：在 `golang:1.27` 容器里直接跑 `go test`（含 `-race`），模块缓存放在命名卷里复用，测试数据目录放在容器卷上。
3. **`just test-linux-fs`**（M1 起）：特权容器里建 loop 设备，分别格式化成 ext4 和 xfs，在上面跑 L2 故障注入和 I-4 崩溃检查的冒烟集。它验证的是「我们的系统调用序列在真实 Linux 文件系统上都能成功」，**不**验证掉电后的持久性。
4. **测试数据目录不得放在 macOS 目录的绑定挂载上**：那里的 fsync 只要 0.15 ms，语义被稀释了。
5. V-09（dm-log-writes 崩溃实验）和 M5 的最终性能数据需要带标准发行版内核的 Linux，见 §6.2 的 H-4 / H-5。

### 2.3 编写正式规格时补充的决议（SC-22 ~ SC-42）

三个子代理从研究工件中抽取细节时，又找出约 40 处空白或互相矛盾的地方。下表是逐项的决定，正文在 `docs/file-format.md`（下称 FF）与 `docs/durability.md`（下称 DU）。

| # | 决定 | 理由 / 依据 |
|---|---|---|
| SC-22 提交管线 | LevelDB 式 leader 串行：写 WAL →（需要时）fsync → 应用内存表 → 发布 → 唤醒整组；每个批次一条 WAL 记录（DU §3） | 研究给的是 LevelDB 与 Pebble 两种实现的混合，没有自洽的算法；串行管线与已采纳的单写者一致，并且天然满足 INV-7（`leveldb/db/db_impl.cc:1236-1257`） |
| SC-23 可见晚于持久 | 新增 INV-7：同步档批次在 fsync 成功之后才可见，fsync 失败的组永不可见 | 读者不会读到之后会消失的同步写入；Pebble 允许可见先于持久，这里是有意偏离 |
| SC-24 SyncAlways | 与 SyncGroupCommit 的持久性保证相同，只是独占一组、不共享 fsync | 研究没定义二者的机械区别；作为对照实验的基线 |
| SC-25 NoSync | 确认前字节已 `write()` 进内核：进程崩溃不丢，系统崩溃可能丢，直到后续同步写入、WAL 轮换、Flush 或 Close；没有时间上界 | LevelDB 每条记录写出后都刷到内核（`leveldb/db/log_writer.cc:103`）；iter-06 要求的「丢失窗口 X 可配置」不采纳 |
| SC-26 WriteOptions | 新增零值 `SyncDefault`，表示继承 `Options.SyncMode` | D03 的值类型设计无法表达「继承默认值」 |
| SC-27 序号约定 | 采用闭区间：`allocSeq`、`visibleSeq`、`LastSequence`，新库都是 9；用户序号 ∈ [10, 2^56 − 2]；2^56 − 1 作哨兵；kind 255 只用于查找目标与分隔键；不做 SeqNumZero | 研究混用开、闭两种约定，导致恢复公式相差 1 |
| SC-28 恢复序号 | `allocSeq = max(9, LastSequence, 重放出的最大序号)`；相继批次的序号必须连续 | 只靠 WAL 重建，在 WAL 为空时会出错；连续性检查几乎零成本 |
| SC-29 恢复时刷盘 | Open 把重放出的数据刷成 L0，新建 WAL 与 MANIFEST，删除旧 WAL | LevelDB 同法（`leveldb/db/db_impl.cc:494-497`）；Open 之后不再存在「靠旧 WAL 支撑的内存表」这种状态 |
| SC-30 空批次 | 直接返回 nil；WAL 中出现 `count = 0` ⇒ `ErrCorruption` | 研究未规定 |
| SC-31 快照 | 释放方法统一为 `Snapshot.Close()`；没有快照时，合并水位取合并开始时的 `visibleSeq` | D02 与 D03 命名不一；取 +∞ 会和合并期间新建的快照竞争 |
| SC-32 编码细则 | varint 必须是最短编码；长度字段用 `uvarint32` | 编码唯一，golden 向量才能逐字节比对 |
| SC-33 VersionEdit | CairnKV 自定 tag 1–7（含 DBID）；NewFile 带序号范围和自定义字段区（位 6 表示「必须理解」）；不持久化 CompactPointer | LevelDB 的 tag 7 没有自定义区，研究也没给出字段表 |
| SC-34 edit 规则 | 每条 edit 都带 LogNumber、NextFileNumber、LastSequence；首条是快照；对删除、新增做严格校验 | LevelDB 每条都盖这三个章（`leveldb/db/version_set.cc:777-790`）；严格校验把实现 bug 变成可检测的错误 |
| SC-35 MANIFEST 滚动 | 只看 128 MB 这一个阈值；每次 Open 都切换到新的 MANIFEST | 研究对滚动规则有六种互相矛盾的表述；Open 时新建 MANIFEST，就不会在残尾之后续写 |
| SC-36 毒化范围 | 任何同步失败，以及 WAL、MANIFEST、标记文件的写或创建失败 ⇒ 毒化；未登记 SSTable 的写失败、删除失败、读到损坏都不毒化 | 研究只讲了 fsync；标记文件 S1–S5 原本是「可重试 / panic」，统一改为毒化 |
| SC-37 标记文件 | 标记是空文件；名称只有 `manifest` 与 `format-version`；文件名无法解析、名称未知、最大迭代号并列 ⇒ `ErrCorruption` | 研究未规定 |
| SC-38 新库与半初始化 | 新库按 N1–N8 的顺序创建；没有 manifest 标记时，只要有 `.sst` 或含有效记录的 WAL 就拒绝打开，否则当作未完成的初始化处理 | 研究只看 `.sst` / `.wal` 文件在不在，会误删数据或误判 |
| SC-39 错误分类 | 结构不合法 ⇒ `ErrCorruption`；能识别但不支持 ⇒ `ErrUnsupported`；比较器不符或 Options 非法 ⇒ 新增 `ErrInvalidOptions` | 研究只写了「拒绝打开」 |
| SC-40 LOCK | 用 `flock`（非阻塞）代替 fcntl 锁 | fcntl 锁有两个坑：关闭同一文件的任意 fd 就会释放锁，同一进程重复加锁也检测不到（LevelDB 为此另建了进程内锁表）；bbolt 用的是 flock（`bbolt/bolt_unix.go:24,32`） |
| SC-41 SSTable 细则 | metaindex 紧贴 footer；用 metaindex 名称 `cairn.index` / `cairn.index.top` 标出单级还是两级索引；属性块的编码与名称；过滤器的位级算法（照 Pebble，哈希尾部字节按无符号处理）；压缩采用条件为 `压缩后 × 100 ≤ 原始 × 88`；只有数据块可以压缩；禁止空表 | 研究说的「结构自描述」并没有落实到任何字节上；三处压缩口径相差一个等号，会改变 golden 向量 |
| SC-42 关闭 | `Close` 会 fsync 活跃 WAL，但不刷内存表；毒化时只释放资源；规定返回值与幂等性 | 研究只规定了毒化状态下的关闭 |

### 2.4 三路审阅后的修订（SC-43 ~ SC-58）

2026-10-29 用三个子代理对 FF、DU 和全套文档做了对抗式审阅。下表是采纳的修订，正文已写入 FF / DU 的第二版。凡是审阅中有工业先例的项，都在源码中抽查过。

| # | 决定 | 解决的问题 |
|---|---|---|
| SC-43 文档分工 | 字节布局以 FF 为准，协议与恢复以 DU 为准，本文件只写决定和理由。本文件中原有的字节布局摘要（§2.1、I-1、I-2）已改为指向 FF / DU | 原先的优先级让本文件里过时的正文压过了正确的 FF：19 字节块尾规则、footer 校验和缺少上下文修正、metaindexSize 的歧义 |
| SC-44 格式参数由文件自带 | 块大小、restart 间隔、压缩方式都只是文件自己的记录，修改 Options 只影响新写的文件。打开时只核对比较器名、dbID、fileNum、格式版本。（**作者 2026-10-29 确认**，推翻 2026-09-29「打开时校验」的定夺） | 不会因为改了配置就打不开库，与 RocksDB / Pebble 一致 |
| SC-45 Open 顺序 | 改为「R7 计数器推进 → R9 重放结果刷成 L0 → R10 先提交（为新 WAL 预留编号 N）→ R11 再创建 N.wal → R12 最后清理」。R8 增加检查：存在编号更大的 WAL、而 WAL(LogNumber) 不存在 ⇒ `ErrCorruption`。MANIFEST 有残尾时，未登记的 SSTable 改为隔离成孤儿，不删除 | 旧顺序先建新 WAL、后切换 MANIFEST，中途崩溃会让带残尾的旧 WAL 不再是最后一个，从此每次打开都报损坏；计数器不推进还会造成文件号复用。新顺序与 Pebble 一致（`pebble/open.go:448-463`） |
| SC-46 MANIFEST 串行化 | 新增 INV-10：所有追加与切换都在 `manifestMu` 下执行，三项计数在持锁追加时才取值，持锁期间安装新版本 | 原先构造 edit 时就取值，刷盘和合并并发追加时会出现「计数减小」，健康的库也会被判为损坏；切换时生成的快照还可能漏掉并发的 edit |
| SC-47 标记移动顺序 | 新顺序：S2 → S3 → S5（目录 fsync，CP-2）→ S6 → 删除旧标记 | 按本规格的崩溃模型，先删旧标记可能一个标记都不剩。Pebble 的顺序依赖日志式文件系统按序提交，这一点不在我们的模型里 |
| SC-48 SyncTo | `SyncTo` 的错误同样毒化。实现只用 `SYNC_FILE_RANGE_WRITE`，不带 WAIT 标志。BytesPerSync 只用于 SSTable | 带 WAIT 的 `sync_file_range` 会推进 errseq，吞掉回写错误，导致之后的 fsync「成功」（**内核行为凭记忆，未在本仓库核验**；规则对两种情况都安全） |
| SC-49 父目录 fsync | 新增 D0：新建数据目录后逐级 fsync 父目录（`pebble/checkpoint.go:89-125`） | 否则崩溃后整个数据目录可能消失，再打开时会静默建出一个空库 |
| SC-50 作证扫描 | 从 X+1 逐字节扫到文件尾，包括同一块的剩余部分。CRC 正确但违反结构约束的 chunk 一律 `ErrCorruption`。chunk 校验和加上下文修正 | 只扫后续块时，同一块内多达 32 KiB 的已确认数据损坏会被静默截掉；MANIFEST 通常只有一块，受害最重 |
| SC-51 刷盘 | 只有一个刷盘协程，按序提交。LogNumber = 除本表之外最老的未刷盘表的 WAL 编号，没有这样的表时取 active 表的 WAL；与 W4 同在 versionMu 下读写 | 乱序完成会删掉还没刷盘的 WAL，或者读到旧值 |
| SC-52 快照 | 「登记快照」和「合并计算水位」放在同一把 snapMu 下 | 否则合并可能丢掉刚创建的快照需要的版本 |
| SC-53 批次上限 | 按内存表占用估算 `Σ(len(k)+len(v)+128)` 判定上限；组建写组时，组的占用不超过目标内存表的容量；`64 KiB ≤ MemTableSize ≤ 1 GiB`；`MemTableCountLimit ≥ 2` | 按编码字节判定，撑不起「批次一定装得进新内存表」：小键小值批次的占用可能是编码长度的好几倍 |
| SC-54 停写与入队 | 停写在组建之后、写 WAL 之前判定（L5）；入队与 Close 共用 queueMu；leader 先重查关闭和毒化；`Flush()` 作为特殊写入者入队；新增 ST-4：因合并遇到损坏而无法解除的停写，返回 `ErrCorruption` | 修正判定时机、StallReturnError 无法「立即返回」、永久停写、Close 竞态、Flush 绕开管线这几处问题 |
| SC-55 删除 `ErrReadOnly` | v1 没有只读打开 | 没有任何路径返回它；只读打开需要另一套 Open 流程，以后与 `Options.ReadOnly` 一起设计 |
| SC-56 M1 过渡实现 | DU §13 的 T1–T6：M1 没有 MANIFEST，Open 用「截断残尾 + 新建 WAL」满足 INV-6；M2 不兼容 M1 的数据目录 | 完整的 N/R 协议依赖 M2 的组件，M1 无法照做 |
| SC-57 编码细则 | 分隔键规则按 Pebble，并加比较器契约与回退；切块估算 `est = 条目 + 4P + 4`；VersionEdit 规范顺序；允许平移；chunk「装满 + 即时补零」；Snappy 压缩后的字节不属规范；restart 与 footer 的越界检查；uvarint32 越界；bloom 哈希尾部按 `r` 分支写明；序号越界检查写成防回绕的形式 | 两种实现产出的字节不同，或者会出现假阴性（详见 FF 第二版各节） |
| SC-58 正确性定义 | PC-1 以上一次成功 Open 时的状态为基线，进程崩溃同样适用；PC-3 加强为「崩溃状态下 Open 必须成功」；PC-4 排除已毒化的运行；检查器纳入 Open 自身的崩溃点和父目录 | 原定义太弱，测不出 Open 顺序、文件号复用、父目录这类问题 |

审阅中**未采纳**的建议：

- 「拒绝在含有未知文件的目录上初始化」：会被 `.DS_Store` 一类的文件误伤。改为引擎只读写、只删除自己文件名模式的文件（FF §6）。
- 「把 SSTable 写入器提前到 M1」：改为 SC-56 的过渡实现，不重排里程碑。

---

## 3. 创新点

### I-1 · 带「已同步偏移」的 WAL chunk（修复 F-1）

- **格式**：chunk 头 19 字节，依次为 checksum、length、type、logNum、syncOffset。基于 Pebble 的 walSync 格式（`pebble/record/record.go:95-98`），另做了两处加强：
  - checksum 加上下文修正，绑定 chunk 所在位置；
  - 写入端每写完一个 chunk 就装满或补零，块尾不会只剩 19 字节，也就不存在空 payload 的 chunk。
  
  `syncOffset` = 写这个 chunk 时，本文件已确认 fsync 到的偏移。逐字节规则见 FF §2.2。
- **恢复规则**（取代 9 条判定表中与位置相关的那几行；完整算法见 DU §8.3）：设 X 为第一条不完整或无效记录的起点。
  1. 从 X+1 起**逐字节**扫描到文件尾，**包括 X 所在块的剩余部分**。只要找到一个合格的 chunk 声明 `syncOffset > X`，说明 X 处早已同步却损坏了 ⇒ `ErrCorruption`。合格的条件是：校验和与位置都对、logNum 匹配、syncOffset ≤ 该 chunk 自身的偏移。
  2. 否则 X 之后是崩溃留下的残尾，丢弃，计入 `WALTornTailBytes`。新写入一律进入新的 WAL。
  3. 这条规则只适用于最后一个 WAL；其余 WAL 一律严格校验（INV-6）。
  4. CRC 正确但违反结构约束（片段顺序、syncOffset 约束、count、kind）一律 `ErrCorruption`，与位置无关。
- **为什么正确**：崩溃只破坏未同步的区域。任何已确认的同步写入都在某次 fsync 的覆盖范围内，之后写出的 chunk（同一块里的也算）会为它作证。**剩余风险**：一次 fsync 覆盖了 X，此后**再没写出任何 chunk**，这种情况下 X 处的损坏无法与残尾区分（DU §12 局限 1，含 MANIFEST 的情形）。Pebble 只在后续块中找作证 chunk，风险比这里大。
- **代价**：每个 chunk 多 12 字节（小批次的 WAL 字节数约 +10%，在整体写放大里占比很小）；写入端需要读一个原子变量。
- **附带收益**：有了 logNum，将来做 WAL 文件复用不需要改格式（Pebble 复用 WAL 文件是为了让频繁同步时不必更新文件元数据，`record.go:71-76`）。
- **里程碑**：M1（M1-1 / M1-2）；MANIFEST 复用同一格式，M2 自动获得同样的能力。

### I-2 · SSTable footer 自校验 + 上下文校验和（RocksDB format_version 6）

- **决定**：53 字节 footer，依次为 checksumType、footerChecksum、baseContextChecksum、metaindexSize、28 字节 reserved、formatVersion、魔数。几处要点：
  - footerChecksum 带上下文修正，偏移取 footer 自身的位置；
  - metaindexSize 不含 trailer；
  - metaindex 块紧贴在 footer 之前。

  **逐字节布局与打开顺序只写在 FF §5.9 一处**（SC-43）。
- **先例**：`rocksdb/table/format.cc:236-268,362-382`，同样是 53 字节。
- **块校验和** = `maskedCRC32C(payload ‖ type) + modifier(base, 块偏移)`，其中 `modifier(b, o) = b ^ (lo32(o) + hi32(o))`（`rocksdb/table/format.h:154-178`；构建端在 `rocksdb/table/block_based/block_based_table_builder.cc:2724`）。
- **base 的来源**：RocksDB 每个文件取一个随机数（`block_based_table_builder.cc:1827`），我们改为由 `dbID ‖ fileNum` 派生。好处有两个：golden 向量可以复现；还能顺带检测「文件被改名」（I-3）。
- **打开顺序**：见 FF §5.9。属性块只核对比较器名、内部键编码版本、dbID、fileNum 与格式版本。块大小、restart interval、压缩方式由文件自带，**不和当前 Options 比对**（SC-44）。
- **压缩类型字节**：`0` 无压缩、`1` Snappy；`2` Zstd 和 `3` MinLZ 只预留给 M5 对照实验，当前构建读到它们 ⇒ `ErrUnsupported`；其他值 ⇒ `ErrCorruption`（AS-4）。
- **收益**：如果块句柄的偏移算错，读到了别处一个本身完好的块，CRC 会失败，而不是返回错误的数据。在自研引擎里，这类 bug 远比磁盘位翻转常见。footer 损坏也不会再变成「指向任意位置的句柄」。**代价**：约几十行代码。
- **里程碑**：M2（M2-1 / M2-3）。

### I-3 · 文件身份绑定（dbID）

- 建库时生成 16 字节随机 `dbID`，写入 MANIFEST 的首条快照记录。WAL 和 MANIFEST 的文件头、SSTable 的属性块里都带 `dbID` 和自身的 `fileNum`。打开时任何一项不匹配 ⇒ `ErrCorruption`（提示「文件属于另一个库，或被改过名」）。SSTable 还要额外校验 `baseContextChecksum == derive(dbID, fileNum)`。
- **防的是什么**：从备份里混进来另一个库的 WAL，或手工拷错、改错名的 `.sst`。现在这些文件会被当作有效数据静默重放。
- **先例**：RocksDB 在表属性中记录 `db_id` 和 `db_session_id`（`rocksdb/include/rocksdb/table_properties.h:412,418`）。
- **代价**：极小。测试通过内部选项注入固定的 dbID，保证结果确定。**里程碑**：M1（WAL 头）、M2（SSTable 与 MANIFEST）。

### I-4 · 前缀一致性 + 有界穷举崩溃检查器

- **一条可以机械检查的正确性定义**：崩溃恢复后的状态，必须等于「按序号依次应用第 1..k 个批次」后的状态，并且 k 不小于最后一个已确认持久的批次。这一条同时覆盖四件事：已确认的写入不丢、批次原子、不会「中间缺一段」（F-3）、从未发出过的写入不会凭空出现。
- **检查器**：
  - mem vfs 记录全部操作轨迹，并对父目录建模。
  - 在每个改变持久状态的操作（Sync / SyncData / SyncTo / 目录 Sync / Create / Rename / Remove）之前设一个崩溃点，**Open 自身执行的这些操作也算**（嵌套崩溃）。
  - 在每个崩溃点，按持久化模型构造少量有代表性的崩溃状态，逐个重新打开并检查前缀一致性。
  - 硬断言：**对崩溃产生的任何状态，Open 必须成功**（DU PC-3）。F-1 和 Open 顺序这类缺陷会被它直接抓住。
  - 完整定义见 DU §11。
- **先例**：ALICE（Pillai et al., OSDI 2014，D02 已引用）提出了「抽象持久化模型 + 枚举崩溃状态」的方法，这里把它用在自己的引擎上，补上 D03 M2-14 随机 `CrashClone` 覆盖不到的定点组合。
- **适用范围**：小工作负载（不超过约 200 次 vfs 操作）做穷举；大工作负载仍用随机 `CrashClone`。
- **代价**：中等。mem vfs 本来就要区分已同步和未同步的数据，新增的主要是枚举器和模型。**可砍**，砍掉就回到 D03 的原方案。
- **里程碑**：M1 先做 WAL 部分；M2 扩展到 SSTable、MANIFEST 和标记文件。

### I-5 · 可执行规格

- **(a) 格式 golden 向量**：`docs/file-format.md` 为每种文件给出 hex 样例。测试解析文档里的代码块，断言编码器的输出与样例逐字节一致、解码器能还原各字段，文档和代码一旦不一致 CI 就失败。
  - **样例先用独立脚本算出，不由被测编码器生成**：同源生成的样例抓不到字节序、掩码这类「自洽的错误」。FF §9.0 / §9.1 已按此做法给出。
  - 本次收口找到的十余处文档矛盾，正是这种漂移。
- **(b) 持久化台账**：`docs/durability.md` 给每个确认点、提交点、不变量编号。
  - 代码里用 `// durability: define <编号>` 标出**恰好一处**主落点，其他相关位置用 `// durability: see <编号>`。
  - 一个测试扫描源码，检查每个编号恰有一个 define、至少被一个测试名引用。
  - 这落实了草案 §6.5「持久化代码写明确认点和提交点」的要求。
- **(c) `cairnkv-cli dump <file>` 提前到 M1（WAL）/ M2（SSTable）**：按字段加注释地打印文件内容（先例：LevelDB 的 `leveldbutil dump`）。它既是调试工具，也直接服务学习目标「手工解码 WAL 记录和数据块」。
- **代价**：低到中。**里程碑**：M1 起。

### I-6 · 用 `testing/synctest` 做确定性并发测试

- 在 synctest 的「气泡」里，`time` 包使用假时钟，`synctest.Wait()` 会等到所有协程都进入「持久阻塞」再返回（已对照本机 go1.27.2 的 `go doc testing/synctest` 核对）。下面这些都能写成不靠 sleep、不会偶发失败的测试：组提交的成组行为、`L0SlowdownWritesTrigger` 的 1 ms 延迟、停写与恢复、`Close()` 等待后台协程退出、毒化后所有等待者都收到错误。
- **对引擎设计的约束**（从 M1 起遵守，成本几乎为零）：
  1. 需要长时间等待的地方用 channel 或 `sync.Cond`，不要让协程长时间阻塞在 `sync.Mutex` 上。mutex 和系统调用都不算持久阻塞。
  2. `sync.WaitGroup` 不放在包级变量里。
  3. 所有后台协程只由 `Open` 启动、由 `Close` 回收。
  4. 时间只通过 `time` 包获取。
  - 这类测试只在 mem vfs 下运行，因为真实文件 I/O 属于系统调用。
- **先例**：Go 标准库。Pebble 等引擎都早于这个特性。它也符合 D-12「不引入第三方测试库」。**里程碑**：M1 起。

### I-7 · 过滤器与索引的常驻集按层优先（落实 SC-07）

- 每个打开的表，把它的「顶层索引块 + 整文件过滤器」优先放进常驻区，计入 `IndexFilterBudget`（默认为块缓存的 20%）。超出预算时**按层号从深到浅降级**：最底层的表最先改为经块缓存读取、不再常驻；L0 和浅层最后才降级。不做自动回升，因为合并会不断产生新表，常驻集会自然更新。指标：`IndexFilterResidentBytes`、`IndexFilterDemotedTables`。
- **理由**：查一个不存在的键，每一层的过滤器都要检查一遍，每层过滤器能省下的 I/O 是一样的；但层越深，键越多，过滤器越大（每层约大 10 倍）。内存不够时先放弃最底层，单位内存的损失最小。这是 Monkey / Dayan et al. TODS 2018 的核心结论（D02 已引用，见 `pebble/options.go:1553-1606`）。RocksDB 的 `optimize_filters_for_hits` 更激进，干脆不给最底层建过滤器（`rocksdb/include/rocksdb/advanced_options.h:816`）。
- **代价**：一个按层排序的降级队列。时间紧时可以退化为「超出预算的新表不常驻」。**里程碑**：M2（M2-5 / M2-6）。

### I-8 · 平台持久化声明 + 文件系统识别（收口 U-15）

- 文件系统分三档。**保证**：Linux 的 ext4 / xfs、macOS 的 APFS，都有测试覆盖（Linux 两种由 `just test-linux-fs` 覆盖，见 §2.2）。**未验证**：btrfs、zfs 等其他本地文件系统，不警告也不承诺（OrbStack 的容器卷就在 btrfs 上）。**不保证**：tmpfs（内存盘，本来就没有持久性）、overlayfs（Docker 容器层）、NFS。`Open` 时通过 `statfs` 识别文件系统类型，命中「不保证」档就通过事件或日志发出警告，但不拒绝打开。
- **理由**：U-15 靠调研关不掉，因为行为取决于具体的内核和挂载参数；但可以通过收窄承诺来关闭它。Docker 用户最常见的误用，就是把数据目录放在容器层上。
- **代价**：每个平台一个小文件，用构建标签隔离（符合草案 §4.4）。**里程碑**：M2。

---

## 4. 未核验项的处置

| 项 | 处置 |
|---|---|
| U-11 `SeqNumStart = 10` 的用途 | **以定义关闭**：CairnKV 自己规定 0–9 为保留值、v1 不使用，用户写入从 10 开始。我们不需要知道 Pebble 为什么保留它们 |
| U-15 目录 fsync 在 overlayfs / tmpfs / NFS 上的行为 | **以收窄承诺关闭**（I-8）；实测部分仍归 V-09（M5） |
| U-7 / U-8 / U-13 | 保持开放，归入 M3 参数扫描和自测，不需要你做任何事 |

---

## 5. 文档优先级与取代关系

**分工与优先级**（SC-43）：

1. `docs/file-format.md`：字节布局、解析判定、错误分类的唯一权威。
2. `docs/durability.md`：确认语义、协议步骤、恢复判定、毒化与关闭的唯一权威。
3. 本文件：决定与理由，以及它与研究文档冲突时的裁决。如果本文件与 FF / DU 冲突，说明本文件过时了，应**回改本文件**。
4. `docs/cairnkv-design-overview-go.md`（草案 v0.2）：需求层表述；与上面三份冲突时，以上面三份为准。
5. D03 → D02 → iter 工件：研究记录，**保持原样不改**，以维持它们与 `.autoresearch/` 逐字节一致。
6. `docs/cairnkv-reference-and-innovation.md`、`docs/learning-path.md`、`learning/` 下的课程：背景与学习材料，可能带旧事实（例如旧魔数 `0x53c9fb8ce508ea61`、`logSeqNum`、`SyncDir` 单列），**冲突时一律以 1–3 为准**。

**被取代的条目**：

| 原文位置 | 被谁取代 |
|---|---|
| D03 §1.4（7 字节 chunk 头、16 字节 WAL 头、tag 取值）；iter-05 的 9 条判定表中与位置相关的行 | I-1、SC-08、SC-03 |
| D03 §1.5（footer、魔数、「store 级版本写在 MANIFEST」）；iter-10 §5–§6 | SC-01 / I-2、SC-11、SC-06 |
| D03 §1.3 `index_filter_budget` 的执行方式 | I-7 |
| D03 §3.2（vfs 接口） | SC-04 |
| D03 §4.2 API 面第 2 条（`Apply` 的返回值）；D03 M0-2（错误列表） | SC-20 |
| D03 §4.3 用例映射 | 增加 INV-6 和前缀一致性用例（I-4） |
| D03 §5.2 数据目录布局 | 增加 `marker.format-version.*`；去掉 SSTable 的 `.tmp` 环节（SC-19） |
| D03 §6.2、M3-5 中的旧参数名 | SC-05 |
| iter-15 D5「WAL 文件创建/滚动之后」 | 收紧为：新 WAL 的目录 fsync 必须在该 WAL 上**第一次确认同步写入之前**完成 |
| D03 M1-5（两个信号量 + `commit.Add(2)`） | SC-22 |
| D03 §4.3 中 INV-4 用例的措辞（「组提交的 fsync 不早于所有 SyncAlways 写入者的确认」，方向写反了） | DU §3.2：断言改为「要求同步的写入者返回时，覆盖它的那次 fsync 已经完成」 |
| iter-06 的 `Options.ErrorHandler` 默认 `os.Exit(1)` | D02 §9.5 的毒化；DU §9 |
| iter-15 R4「MANIFEST 尾部 CRC 失败即截断」、S5「目录 fsync 失败 ⇒ panic」 | DU §8.4、§6.2 |
| iter-15 / D02 关于 MANIFEST 滚动的六种表述 | SC-35 |
| iter-09「没有快照时水位取 +∞」 | SC-31 |
| D02 §8「压缩后严格小于原块 × 0.88」 | SC-41（`压缩后 × 100 ≤ 原始 × 88`） |
| iter-10 / D03 §1.5 的块顺序（索引在 metaindex 之后等） | FF §5.1 |
| D03 M0-3「`internal/vfs`」；§3.3 退出标准「含 `SyncDir`」 | SC-04：公开包 `vfs/`；目录同步用 `OpenDir` + `Sync` |
| D03 M0-7「`.github/workflows/ci.yaml`」 | SC-17：以 `just ci` 为主，Actions 配置备用 |
| D03 §1.1 / §4.2 的 `SyncMode` 三值与 `WriteOptions{Sync}` | DU §2.1（`SyncDefault`）、SC-20（`OnStall`） |
| D03 §4.2 `Snapshot.Release()`、「必须 Release」 | SC-31：`Snapshot.Close()` |
| D03 §4.2「Close 之后除 Close 外均返回 ErrClosed」 | DU §10：再次 Close 也返回 `ErrClosed` |
| D03 §1.4「seqNum ∈ [10, 2^56 − 1]」「3..15 预留」 | FF §1：用户序号 ∈ [10, 2^56 − 2]；kind 255 用作查找键；kind 表重新划分 |
| D03 M1-1「7B chunk 头」、M1-2「9 条判定表」 | FF §2.2、DU §8.3（I-1） |
| D03 M1-9 及各处的 `logSeqNum` 重建 | DU §4.1（`allocSeq` / `visibleSeq` / `LastSequence`，INV-9） |
| D03 §0.1、§4.4、§9.2 中的「INV-1..5」 | DU：INV-1 … INV-10 |
| D03 §4.3 INV-3 用例「注入 arena 满 → 整批失败」 | DU §3.1 INV-3（预留不会失败；用例改为断言「最大批次 × 极小条目」可以写入）、SC-53 |
| D03 M2-14 崩溃克隆在 M2 | I-4：M1 先做 WAL 部分 |
| D03 §1.1 `Comparator` | SC-10：`Comparer` |
| D03 §1.1 / M2-1 / M2-11 `MinCompressionRatio = 0.12`、「12% 阈值」 | FF §5.10：整数阈值是格式常量，不作为 Options 字段 |
| D03 §11「DeleteRange…加入不需提升格式版本」 | FF §7：新的 kind 需要提升 store 版本与 `cairn.internal-key-version` |
| D03 M1-12 `OpFileFlush` | SC-04：`File` 没有 Flush 方法，这个注入点不存在 |
| D03 §1.1「格式参数子分组…打开时校验」；D02 §13.3「不匹配则拒绝打开」 | SC-44 |
| D03 §0.2 AS-4「未知压缩类型报 ErrCorruption」 | FF §5.2：预留的 2 / 3 报 `ErrUnsupported`，其余报 `ErrCorruption` |
| D03 M0-2 / SC-20 第一版中的 `ErrReadOnly` | SC-55 |
| D03 M1-8「`readState` 用 RWMutex」等内存表切换细节 | DU §5（单一刷盘协程、versionMu） |
| D03 §1.1 `MemTableSize` 无下限 | SC-53：64 KiB ≤ MemTableSize ≤ 1 GiB |

---

## 6. 需要你回答的问题

### 6.1 已回答（2026-10-29）

| # | 问题 | 你的回答 | 落实到 |
|---|---|---|---|
| H-1 | 模块路径 | 用你的 GitHub 账号 | SC-13：`github.com/LystranG/cairnkv` |
| H-2 | 许可证 | Apache-2.0 | SC-14 |
| H-3 | Linux 环境 | 用本机 Docker，看看能不能用 testcontainers | SC-21 / §2.2：Docker 能覆盖 Linux 功能测试；testcontainers-go 暂不引入；本机不支持 dm-log-writes |
| H-6 | 版本管理（`docs/` 原先被忽略） | 去掉忽略并做首次提交 | 首次提交 `c75ce85`（`docs/` + `.gitignore`）；`learning/` 暂未纳入 |
| H-7 | 格式参数要不要在打开时校验 | 由文件自带 | SC-44 |

### 6.2 还要回答的（都在 M5 之前，不阻塞 M0–M4）

| # | 问题 | 在你回答之前 |
|---|---|---|
| **H-4** | 要不要把仓库推送到 GitHub（`LystranG/cairnkv`），公开还是私有？推送后可以用 GitHub Actions 的 Ubuntu runner 跑 nightly 的 dm-log-writes 实验：标准 Ubuntu 内核通常带这个模块（**未核验**，M5 第一步验证），公开仓库的 Actions 免费 | 一切留在本地，我不会推送 |
| **H-5** | M5 的最终性能数据在哪里测：(a) 一台裸机或云主机 Linux，数据可信，可能要花钱；(b) 用 GitHub Actions 或本机 VM 的数据，并在实验报告里写明「虚拟化环境，fsync 成本被低估」 | M5 之前都用本机数据做开发期参考，报告里如实标注 |

---

## 7. 产出与状态（2026-10-29）

| # | 产出 | 状态 |
|---|---|---|
| 1 | 草案 v0.2（SC-18） | 完成；已按审阅补充需求层表述 |
| 2 | `docs/file-format.md` 第二版 | 完成。§9.0 基础向量、§9.1 WAL 样例由独立脚本算出；§9.2 的 7 个样例在 M1 / M2 补齐 |
| 3 | `docs/durability.md` 第二版 | 完成，含 INV-1 … INV-10、Open R1–R12、M1 过渡实现 T1–T6 |
| 4 | `docs/research/README.md` 指向本文件 | 完成 |
| 5 | 三路审阅与修订（§2.4） | 完成 |
| 6 | 自检脚本：SC 编号、DU 编号唯一、跨文档章节引用 | 每次修订后运行 |

下一步：M0。按本文件调整的要点如下，M0 的详细计划在开工前另给：

- 模块路径 `github.com/LystranG/cairnkv`；
- 加入 `LICENSE`（Apache-2.0）；
- 公开包 `vfs`，内存实现带同步状态建模；
- 公开 `Comparer`；
- 10 个公开错误；
- justfile 提供 `ci` 和 `test-linux`。
