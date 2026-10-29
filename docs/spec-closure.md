# CairnKV 规格收口决议（M0 开工前）

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-29（第二版：由「待确认清单」改为「决议」） |
| 性质 | 作者授权 Claude 代为决策。本文件给出每项的**最终决定 + 理由 + 证据**；只有 §6 的问题需要作者回答 |
| 权威性 | 与 D02 / D03 / iter 工件冲突时**以本文件为准**（§5）；正式规格整理进 `docs/file-format.md` / `docs/durability.md` |
| 引用约定 | `D02` / `D03` = `docs/research/DELIVERABLE-02/03-*.md`；`iter-NN` = `.autoresearch/work/iter-NN-*.md`；源码引用 `<repo>/<path>:<line>` 指 `.autoresearch/third_party/` 钉版（`PINS.md`） |

---

## 0. 一页总结

- 第一版清单的 18 项已全部定案：15 项由我代为决定，模块路径、许可证、Linux 环境 3 项由你回答（§6）。另补了 SC-19（临时文件）、SC-20（公开错误集合）和 SC-21（Linux 验证环境，基于本机 Docker 实测，见 §2.2）。
- 这一轮核对又发现 **3 个新问题**（§1）。其中 F-1 是严重缺陷：照研究里的 WAL 判定表实现，**一次普通崩溃后数据库就可能打不开**；如果为了绕过它改成「遇到坏记录就截断」，又会**静默丢掉已确认的写入**。
- 新增 **8 项创新**（§3）。筛选标准有三条：有可查的工业或学术先例；能把一类「静默错误」变成可检测的错误或可执行的测试；代价小，在现有里程碑内就能完成。其中 I-1 修复 F-1，SC-11 消除 F-2。
- 编写正式规格时又补定了 21 项（SC-22 ~ SC-42，§2.3）。正式规格已写成 `docs/file-format.md` 与 `docs/durability.md`。
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
| SC-04 vfs | `File`：`Read` `ReadAt` `Write` `WriteAt` `Close` `Stat` `Sync` `SyncData` `SyncTo` `Truncate`。`FS`：`Create` `Open` `OpenDir` `Remove` `RemoveAll` `Rename` `Link` `MkdirAll` `Lock` `List` `Stat`。目录同步统一用 `OpenDir(dir)` + `Sync()`，另提供辅助函数 `vfs.SyncDir`。**删掉 `Preallocate`**。`vfs` 作为**公开包**，稳定性为**实验级**；故障注入包 `errorfs` 留在 `internal/` | 只保留 M1–M3 真正用到的方法，内部要加方法随时可加。ext4 上 `fallocate` 生成的是未写入区段，写入时仍要改元数据，iter-04 声称的收益不成立（**推断，未实测**），等实验需要时再加回来。公开包让 `Options.VFS` 能被测试和示例注入（Pebble 也是公开 `vfs`）。`Lock` 的文档必须写明 fcntl 的坑：同一文件的其他 fd 一关闭，锁就会提前释放（`pebble/vfs/vfs.go:145-150`） |
| SC-05 命名 | 统一使用权威名（`MaxLevels` / `LevelMultiplier` / `BaseLevelSize` / `MemTableCountLimit`），旧名只出现在 `options.go` 注释的「别名」行 | 文档勘误，没有语义变化 |
| SC-06 store 级版本 | 独立的 `marker.format-version.<iter>.<N>`，复用标记文件机制；打开时最先读它，版本越界 ⇒ 拒绝打开 | 必须在解析 MANIFEST 之前就知道格式版本（`pebble/format_major_version.go:426`）。同一把版本锁同时约束 SSTable 格式的上下限（iter-15 §5） |
| SC-07 IndexFilterBudget | 「常驻集 + 按层优先降级」，见 I-7 | 让第三笔预算有可执行、可单测的机制 |
| SC-08 WAL 文件头 | 48 字节，位于块 0 开头；块边界仍是 32 KiB 的整数倍；头部带自身校验和；MANIFEST 结构相同，魔数不同。布局见 §2.1 | 头部也在校验范围内；块对齐不被头部打乱 |
| SC-09 大小上限 | 常量 `MaxKeySize = 64 KiB`，超出 ⇒ `ErrKeyTooLarge`；批次编码后 `> MemTableSize / 2` ⇒ `ErrBatchTooLarge`，在 **WAL 写入之前**判定；`Open` 时校验 `MemTableSize ≤ 1 GiB` | 阈值与 Pebble 大批次旁路的阈值相同（`pebble/open.go:160`）。将来实现旁路时，只是把「拒绝」放宽成「接受」，向后兼容。默认配置下单批上限为 2 MiB，要写进文档 |
| SC-10 比较器 | `Comparer = Compare + Name + Separator + Successor`；字节序实现照搬 LevelDB 的 `FindShortestSeparator` / `FindShortSuccessor` | 缩短索引键，避免索引块膨胀 |
| SC-11 魔数 | 三种文件都用 8 字节 ASCII 字节数组：`"CairnWAL"` / `"CairnMAN"` / `"CairnSST"`，**按字节写入，不当整数处理** | 消除 F-2；用 `xxd` 一眼就能认出（直接服务学习目标里的「手工解码」）；不再依赖模块路径，仓库搬家不影响磁盘格式 |
| SC-12 Go 版本 | `go 1.27`（本机为 go1.27.2 darwin/arm64） | 没有下游使用者，不必维护版本矩阵；I-6 用到的 `testing/synctest` 从 1.25 起正式可用 |
| SC-13 模块路径 | `github.com/LystranG/cairnkv`（H-1 已回答：用你的 GitHub 账号，账号名取自 `gh repo list`） | Go 模块路径允许大小写混用（如 `github.com/BurntSushi/toml`），与 GitHub 账号保持一致即可。魔数已不依赖它 |
| SC-14 许可证 | Apache-2.0（H-2 已回答），M0 加入 `LICENSE`。移植规则：从 LevelDB / Pebble（BSD-3）或 Badger（Apache-2.0）移植的代码，文件头保留原版权行并注明来源，原许可证全文放入 `LICENSES/<项目>.txt` | BSD-3 与 Apache-2.0 都要求保留版权声明；集中放置便于核对 |
| SC-15 Snappy | 使用 `github.com/klauspost/compress`：写入用 `s2.EncodeSnappy`（输出标准 Snappy 块），读取用 `s2.Decode` | 有正式 tag（2026-10-29 查得最新 `v1.20.3`，仓库未归档）；同一个依赖还提供 M5 要对照的 Zstd。README 写明可以生成完全兼容 Snappy 的块（`s2/README.md` 的 Blocks 一节）。M2 开工时我会用一组块和 `golang/snappy` 互相解码做验证，验证放在临时目录里，不进 `go.mod` |
| SC-16 任务管理 | 用 justfile（本机已安装 `just`），不建 Makefile | 两者只留一个 |
| SC-17 CI | 本地优先：`just ci` 运行与 D03 §9.2 PR 门禁相同的检查，`just test-linux` 在本机 Docker 里补跑 Linux（SC-21）；同时备好 GitHub Actions 配置，推送后生效（H-4） | 单人项目，每天真正在跑的门禁是本地这一道；开发机是 macOS，Linux 覆盖靠 Docker |
| SC-18 草案修订 | 已改为 v0.2（落实 C-1 / C-2 / C-3 与本文件的决议），文末附变更记录；v0.1 原文另存为 `docs/archive/cairnkv-design-overview-go-v0.1.md`（逐处反向还原，字节数与原文一致）。`docs/` 目前不在版本管理中，见 H-6 | 你已授权代为决策 |
| SC-19 临时文件（新增） | SSTable **直接以最终文件名写入**，不经过 `.tmp` 再重命名；v1 不产生 `.tmp`，但启动清理仍删除任何 `*.tmp`（防御） | SSTable 只有被 MANIFEST 登记后才算存在，未登记的 `.sst` 启动时会被清理（iter-15 R6）。先写临时名再重命名不增加任何安全性，只多一次 rename 和一次目录同步。草案 P-06 要求的「原子切换」由标记文件实现：创建新标记文件这个目录项操作本身是原子的 |
| SC-20 公开错误集合（新增） | 公开错误：`ErrNotFound` `ErrCorruption` `ErrUnsupported` `ErrEnginePoisoned` `ErrClosed` `ErrReadOnly` `ErrSequenceExhausted` `ErrKeyTooLarge` `ErrBatchTooLarge` `ErrWriteStall` `ErrInvalidOptions`（后补，见 SC-39）。`ErrArenaFull` **降为内部错误**。背压档位用 `WriteOptions.OnStall`（`StallBlock` 为默认 / `StallReturnError`）逐次选择 | D03 M0-2 漏了 `ErrClosed`；§4.2 列举的 `Apply` 返回值漏了 `ErrSequenceExhausted`；`ReturnError` 档既没有错误名也没有选择方式。有了 SC-09，用户再也碰不到 arena 满（批次一定装得进新内存表）。拒绝点必须在 WAL 追加**之前**，通过准入后不得再因过载失败（D03 M3-5 的约束） |
| SC-21 Linux 验证环境（新增） | 用本机 Docker（OrbStack）跑 Linux 功能测试和 ext4 / xfs 冒烟测试；**不引入 testcontainers-go**；dm-log-writes 实验和最终性能数据不在本机做。详见 §2.2 | 基于 2026-10-29 本机实测 |

### 2.1 WAL / MANIFEST 文件头（SC-08 的字节布局）

```text
偏移      大小  字段
[0..8)    8   magic           "CairnWAL"（MANIFEST 为 "CairnMAN"）
[8..10)   2   formatVersion   u16 LE = 1     更高 ⇒ ErrUnsupported（拒绝打开）
[10..12)  2   flags           u16 LE = 0     v1 中非零 ⇒ ErrCorruption
[12..16)  4   blockSize       u32 LE = 32768
[16..24)  8   fileNum         u64 LE         必须等于文件名里的编号（I-3）
[24..40)  16  dbID            [16]byte       必须等于 MANIFEST 记录的 dbID（I-3）
[40..44)  4   reserved        = 0
[44..48)  4   headerChecksum  maskedCRC32C([0..44))
```

- 块 0 的可用空间 = `32768 − 48`；之后的块从 `k × 32768` 开始。
- 头部无效（文件短于 48 字节、全零或校验失败）时，视为「第一个无效位置 X = 0」，按 I-1 的规则判定：如果后面有有效 chunk 声明 `syncOffset > 0` ⇒ `ErrCorruption`，否则视为空日志。这条规则覆盖了「刚创建就崩溃」的情况。
- WAL、SSTable、MANIFEST 共用**同一个**递增文件号计数器（LevelDB 同法）；I-2、I-3 依赖这一点。

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

---

## 3. 创新点

### I-1 · 带「已同步偏移」的 WAL chunk（修复 F-1）

- **格式**：chunk 头 19 字节 = `maskedCRC32C(4) | length(2) | type(1) | logNum(4，文件号低 32 位) | syncOffset(8)`；CRC 覆盖 `type ‖ logNum ‖ syncOffset ‖ payload`。照搬 Pebble 的 walSync 格式（`pebble/record/record.go:95-98`、`pebble/record/log_writer.go:1071-1096`）。`syncOffset` = 写这个 chunk 时，本文件已经确认 fsync 到的偏移。类型只有 FULL / FIRST / MIDDLE / LAST 四种；块尾剩余不足 19 字节时填零；恰好剩 19 字节时写一个 payload 为空的 FIRST。
- **恢复规则**（取代 9 条判定表中与位置相关的几行）：设 X 为第一个无效 chunk 的偏移（CRC 错、类型越界、长度越界、logNum 不匹配、全零头、缺少前置 FIRST 等）。从 X 往后扫描：
  1. 如果找到任何 CRC 正确、logNum 匹配、并且声明 `syncOffset > X` 的 chunk，说明 X 处的数据早已同步却损坏了 ⇒ `ErrCorruption`，报告 X 和作证的 chunk。
  2. 否则，X 是崩溃留下的 **torn tail**：截断，计入指标 `WALTornTailBytes`。之后的新写入一律进入新的 WAL，**绝不**在 torn tail 后面追加。
  3. 这条规则只适用于最后一个 WAL；其余 WAL 出现无效 chunk 一律报 `ErrCorruption`（INV-6）。
  4. CRC 正确但内容非法（批次的 count 不符、kind 非法）一律报 `ErrCorruption`，与位置无关。
- **为什么正确**：在持久化模型下（定义在 `durability.md` 中），崩溃只会破坏未同步的区域。任何已确认的同步写入都在某次 fsync 覆盖的范围内，之后写入的 chunk 会为它「作证」。**剩余风险**：最后一次 fsync 之后如果再没有写入任何 chunk，而那段区域恰好发生了位翻转，就无法和 torn tail 区分。这一点写进已知局限。
- **代价**：每个 chunk 多 12 字节（小批次的 WAL 字节数约 +10%，在整体写放大里占比很小）；写入端需要读一个原子变量。
- **附带收益**：有了 logNum，将来做 WAL 文件复用不需要改格式（Pebble 复用 WAL 文件是为了让频繁同步时不必更新文件元数据，`record.go:71-76`）。
- **里程碑**：M1（M1-1 / M1-2）；MANIFEST 复用同一格式，M2 自动获得同样的能力。

### I-2 · SSTable footer 自校验 + 上下文校验和（RocksDB format_version 6）

```text
偏移      大小  字段
[0]       1   checksumType          = 1（masked CRC32C + 上下文修正）
[1..5)    4   footerChecksum        maskedCRC32C(整个 footer，本字段置零)
[5..9)    4   baseContextChecksum   u32 LE，≠ 0，= derive(dbID, fileNum)
[9..13)   4   metaindexSize         u32 LE；metaindex 块（含 5 字节 trailer）紧贴在 footer 之前
[13..41)  28  reserved              v1 中必须全零，否则 ErrCorruption
[41..45)  4   formatVersion         u32 LE = 1；更高 ⇒ ErrUnsupported（拒绝打开）
[45..53)  8   magic                 "CairnSST"
```

- **先例**：`rocksdb/table/format.cc:236-268`，同样是 53 字节。
- **块校验和** = `maskedCRC32C(payload ‖ type) + modifier(base, 块偏移)`，其中 `modifier(b, o) = b ^ (lo32(o) + hi32(o))`（`rocksdb/table/format.h:154-178`；构建端在 `rocksdb/table/block_based/block_based_table_builder.cc:2724`）。
- **base 的来源**：RocksDB 每个文件取一个随机数（`block_based_table_builder.cc:1827`），我们改为由 `dbID ‖ fileNum` 派生。好处有两个：golden 向量可以复现；还能顺带检测「文件被改名」（I-3）。
- **打开顺序**：先读最后 53 字节，依次检查魔数、formatVersion、footer 校验和；再读 metaindex 并校验它的 trailer；然后读属性块，校验比较器名、内部键编码版本、restart interval、BlockSize、压缩算法集合、dbID 和 fileNum。
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
- **检查器**：mem vfs 记录全部操作轨迹。在每个改变持久状态的操作（Sync / SyncData / SyncTo / 目录 Sync / Create / Rename / Remove / Link）之前设一个崩溃点。在每个崩溃点，按持久化模型构造少量有代表性的崩溃状态：只保留已同步的数据；全部保留；未同步的文件尾按 4 KiB 页随机截断；未同步的目录项回退。逐个重新打开并检查前缀一致性。另有一条硬断言：**由崩溃产生的状态，`Open` 绝不允许返回 `ErrCorruption`**（崩溃不是损坏），F-1 这类缺陷会被它直接抓住。
- **先例**：ALICE（Pillai et al., OSDI 2014，D02 已引用）提出了「抽象持久化模型 + 枚举崩溃状态」的方法，这里把它用在自己的引擎上，补上 D03 M2-14 随机 `CrashClone` 覆盖不到的定点组合。
- **适用范围**：小工作负载（不超过约 200 次 vfs 操作）做穷举；大工作负载仍用随机 `CrashClone`。
- **代价**：中等。mem vfs 本来就要区分已同步和未同步的数据，新增的主要是枚举器和模型。**可砍**，砍掉就回到 D03 的原方案。
- **里程碑**：M1 先做 WAL 部分；M2 扩展到 SSTable、MANIFEST 和标记文件。

### I-5 · 可执行规格

- **(a) 格式 golden 向量**：`docs/file-format.md` 为每种文件给出最小的 hex 样例（一条 WAL 记录、一个数据块、一个 footer）。测试解析文档里的代码块，断言编码器的输出与样例逐字节一致、解码器能还原各字段。文档和代码一旦不一致，CI 就失败。本次收口找到的十余处文档矛盾，正是这种漂移。
- **(b) 持久化台账**：`docs/durability.md` 给每个确认点和提交点编号（如 `D5`、`INV-6`），代码里用 `// durability: D5` 标注。一个测试扫描源码，确认每个编号恰好出现在一处代码里，并且至少被一个测试名引用。这落实了草案 §6.5「持久化代码写明确认点和提交点」的要求。
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

1. 本文件（决议）。
2. `docs/file-format.md` / `docs/durability.md`（整理后的正式规格，与本文件保持同步）。
3. D03 → D02 → iter 工件：作为研究记录**保持原样不改**，以维持它们与 `.autoresearch/` 逐字节一致；`docs/research/README.md` 会加一行说明指向本文件。

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

---

## 6. 需要你回答的问题

### 6.1 已回答（2026-10-29）

| # | 问题 | 你的回答 | 落实到 |
|---|---|---|---|
| H-1 | 模块路径 | 用你的 GitHub 账号 | SC-13：`github.com/LystranG/cairnkv` |
| H-2 | 许可证 | Apache-2.0 | SC-14 |
| H-3 | Linux 环境 | 用本机 Docker，看看能不能用 testcontainers | SC-21 / §2.2：Docker 能覆盖 Linux 功能测试；testcontainers-go 暂不引入；dm-log-writes 在本机不可用 |

### 6.2 还要回答的（H-6 建议尽快，其余在 M5 之前）

| # | 问题 | 在你回答之前 |
|---|---|---|
| **H-6** | **版本管理**：`.gitignore` 忽略了整个 `docs/`（也忽略了 `.gitignore` 自身），仓库还没有任何提交。所以研究文档、本决议、草案 v0.2 目前都不受版本管理，`docs/research/README.md` 说的「提升出来防止误删」并没有实现。要不要把 `docs` 和 `.gitignore` 从忽略列表里去掉，并做第一次提交？如果有不想公开的文档，可以只忽略那几个文件 | 我不改 `.gitignore`、不提交；v0.1 已另存一份作为本地备份 |
| **H-4** | 要不要把仓库推送到 GitHub（`LystranG/cairnkv`），公开还是私有？推送后可以用 GitHub Actions 的 Ubuntu runner 跑 nightly 的 dm-log-writes 实验：标准 Ubuntu 内核通常带这个模块（**未核验**，M5 第一步验证），公开仓库的 Actions 免费 | 一切留在本地，我不会推送 |
| **H-5** | M5 的最终性能数据在哪里测：(a) 一台裸机或云主机 Linux，数据可信，可能要花钱；(b) 用 GitHub Actions 或本机 VM 的数据，并在实验报告里写明「虚拟化环境，fsync 成本被低估」 | M5 之前都用本机数据做开发期参考，报告里如实标注 |

---

## 7. 产出与状态（2026-10-29：1–5 已完成）

1. **草案 v0.2**（SC-18）：落实 C-1 / C-2 / C-3 与本文件的决议。
2. **`docs/file-format.md`**：WAL / MANIFEST（文件头 + I-1 chunk + 逻辑层）、内部键、SSTable v1（块 / trailer / 两级索引 / 过滤器 / 属性块 / metaindex / I-2 footer）、标记文件命名、数据目录布局、版本边界表。hex 样例先留占位，M1/M2 由编码器生成后补齐，并由 I-5(a) 的测试守护。
3. **`docs/durability.md`**：持久化模型（同步前与同步后的保证、页粒度撕裂、目录项、rename 原子性、fsync 失败语义）、三档同步与确认点、INV-1..6、毒化状态机、标记文件 S1–S6、目录 fsync 清单 D1–D6、前缀一致性定义、大小上限、平台声明（I-8）、已知局限。
4. **`docs/research/README.md`**：加一行说明「被 `docs/spec-closure.md` 取代的条目」。
5. **自检**：已用脚本检查。42 个 SC 编号都有定义；`durability.md` 的 103 个编号各只定义一次；跨文档的章节引用都存在。编号与测试名的对应关系在 M1 写测试时建立，由 I-5(b) 的台账测试守护；`file-format.md` §9 的 hex 样例在 M1 / M2 补齐。

完成后进入 M0（按本文件调整：模块路径 `github.com/LystranG/cairnkv`、`LICENSE`（Apache-2.0）、`vfs` 改为公开包、justfile 含 `test-linux`、错误集合按 SC-20）。
