# CairnKV 实现计划（M0–M5）

**本文件的性质**：可执行的实现计划。它把 20 条研究迭代的结论翻译成**有序的工作项、接口契约、
参数默认值、测试门禁与风险对策**。

**配套文档**
| 文档 | 内容 | 路径 |
|---|---|---|
| 交付 01 | LSM 理论与 2020s 进展综述 | `.autoresearch/DELIVERABLE-01-lsm-theory.md` |
| 交付 02 | 逐项设计决策书（规格 / 候选 / 证据 / 代价） | `.autoresearch/DELIVERABLE-02-design-decisions.md` |
| 裁决 | 22 项跨 lane 冲突裁决 + 差异清单 + 未核验项 | `.autoresearch/work/iter-20-arbitration.md` |
| 台账 | 20 条迭代的决策与六维评分 | `.autoresearch/autoresearch.jsonl` |
| 基线 | 草案 v0.1 的 55 条决策原文 | `.autoresearch/baseline.md` |
| 论证 | 19 份迭代的详细论证（每份含证据清单） | `.autoresearch/work/iter-NN-*.md` |

**范围声明**：本计划只覆盖草案 §9 的 **M1–M3（核心引擎）** 与 **M4–M5** 的骨架。
第一名实现者的目标应当是「M3 结束时通过全部验收标准 1–4、7」。M4/M5 的细节在进入该阶段前再细化。

**最重要的一句话**：草案的默认栈（跳表 + 块表 + Bloom + **size-tiered**）中，
**合并策略被研究推翻**（改为 leveled），**同步档位由两档变三档**，**压缩由可选变默认开启**，
**元数据指针由 `CURRENT` 改为标记文件**。这四处是相对草案最大的偏离，实现者必须先读交付 02 第 16 节。

---

## 0. 实现前的必读清单

### 0.1 五条不可违反的不变量（违反即 `dup` / `crc` 门槛失败）

| # | 不变量 | 来源 | 落点 |
|---|---|---|---|
| **INV-1** | `LogWriter.Sync()` 的语义是「**先 flush 未满块，再 fsync**」 | iter-05；`pebble/record/log_writer.go:1000-1006 @ e0818dd` | WAL 包 |
| **INV-2** | `writerRefs` 必须在 **WAL 写入之前**获取、apply 完成后归还；`readyForFlush() = writerRefs == 0`；释放条件是 `readerRefs == 0 && writerRefs == 0` | iter-08；裁决-02 | 内存表切换 |
| **INV-3** | `Prepare`（预留 arena 空间）必须**先于** WAL 写入；预留失败 ⇒ 整批失败，绝不"WAL 已写但内存只应用了一半" | iter-07/08 | 提交路径 |
| **INV-4** | durability 需求**只能保留或加强，不能稀释**——绝不把"要求 fsync"的写入者并入"不要求 fsync"的组 | iter-06；`leveldb/db/db_impl.cc:1303-1306 @ 7ee830d` | 组提交 |
| **INV-5** | fsync 失败后引擎**毒化**：所有读写返回 `ErrEnginePoisoned`，**已提交批次的等待者一律收到该错误**，绝不返回成功 | 裁决-06 | 引擎状态机 |

### 0.2 五条必须实现的断言（防静默错误）

| # | 断言 | 为什么 |
|---|---|---|
| **AS-1** | 合并/多 run 读路径的输入迭代器必须严格符合 `InternalCompare` **全序** | 违反会让版本丢弃规则**丢掉正确版本且不报错**（本循环最高风险点 V-01） |
| **AS-2** | 内部键的 trailer **降序**是格式常量；`kind` 从 `0=Invalid` 起 | `0=Delete` 会让"被清零的键值区"静默变成删除（裁决-04） |
| **AS-3** | 索引块 CRC 失败**不得**降级为"键不存在"，必须报 `ErrCorruption` | 否则损坏变成静默的数据丢失 |
| **AS-4** | 未知压缩类型**不得猜测**，报 `ErrCorruption` | 同上 |
| **AS-5** | 墓碑物理丢弃必须同时满足 条件A（更深层无更旧版本）∧ 条件B（`S ≤ smallest_snapshot`） | 否则快照读到错误结果或数据复活 |

---

## 1. 最终参数默认值表（唯一权威来源）

实现时以此表为准；交付 02 的逐项说明是它的论证。

### 1.1 稳定级 `Options`（改了就改变磁盘字节或持久化语义）

| 字段 | 默认值 | 单位 | 依据 |
|---|---|---|---|
| `BlockSize` | `4096` | 字节（可配 1 KiB–64 KiB） | iter-10 |
| `FilterBitsPerKey` | `10` | bits（FPR ≈ 1%） | iter-11 |
| `Comparator` | 字节序（`bytes.Compare`） | — | B-42 |
| `SyncMode` | `SyncGroupCommit` | 枚举 `SyncAlways` / `SyncGroupCommit` / `NoSync` | iter-06 |
| `MemTableSize` | `4 << 20` | 字节 | iter-08 |
| `Compression` | `Snappy`（默认开启；`MinCompressionRatio = 0.12`） | 枚举 | iter-14；裁决-10 |
| `VFS` | 平台默认（`os` 实现） | 接口 | iter-04 |
| `TotalMemoryBudget` | `0`（= 不检查） | 字节 | 裁决-19 |
| `RestartInterval` | `16`（索引块为 `1`） | — | iter-10；**「格式参数」子分组**（作者 2026-09-29 定夺） |
| `IndexBlockSize` | `8 × BlockSize`（两级索引切换阈值） | 字节 | iter-10；**「格式参数」子分组**（作者 2026-09-29 定夺） |

> **「格式参数」子分组**（作者 2026-09-29 定夺）：`BlockSize`、`Compression`、`RestartInterval`、`IndexBlockSize` ——
> 这些字段一旦写入文件即不可变更（由 properties 记录并在打开时校验，`B-42`）；放在稳定级是为了让使用者
> 一眼看到「改了就改变磁盘字节」。

### 1.2 实验级 `Options.Tuning`（只影响策略与资源）

| 字段 | 默认值 | 依据 |
|---|---|---|
| `MaxLevels` | `7` | iter-16 |
| `LevelMultiplier` (T) | `10` | iter-16 |
| `BaseLevelSize` | `10 << 20`（10 MB） | iter-16 |
| `TargetFileSize` | `2 << 20`（2 MB） | iter-16 |
| `L0CompactionThreshold` | `4` | iter-16/17 |
| `L0SlowdownWritesTrigger` | `8`（延时 1 ms，每次写入只延一次） | iter-17 |
| `L0StopWritesThreshold` | `12` | iter-17 |
| `MemTableCountLimit` | `2`（**必须 ≥ 2**） | iter-08 |
| `BlockCacheSize` | 显式设置，无隐含默认 | iter-13 |
| `IndexFilterBudget` | `BlockCacheSize` 的 20% | 裁决-12/19 |
| `BytesPerSync` | `512 << 10`（512 KB） | iter-04/06 |
| `DynamicBaseLevel` | `true` | iter-16 |
| `MaxGrandparentOverlapBytes` | `10 × TargetFileSize` | iter-16 |
| `ExpandedCompactionByteSizeLimit` | `25 × TargetFileSize` | iter-16 |
| `L0CompactionConcurrency` | `10` | iter-17 |
| `MaxManifestFileSize` | `128 << 20`（128 MB） | iter-15 |
| `ArenaBlockSize` | `min(256 KiB, MemTableSize)`，每次旋转翻倍 | iter-08 |
| `CompactionDebtConcurrency` | `1 << 30`（1 GB） | iter-17 |

> **本表与 `autoresearch/work/iter-20-arbitration.md` 的裁决-23 一致，是该表的权威来源。**
> 裁决-23 同时解决了三件事：(1) **参数命名唯一化**（权威名 vs 弃用别名映射表：
> `LevelMultiplier`←`SizeRatio`/`T`、`BaseLevelSize`←`LevelBaseBytes`、
> `MemTableCountLimit`←`MemTableStopWritesThreshold`、`L0CompactionThreshold`←`L0CompactionTrigger`、
> `MaxLevels`←`NumLevels`）；(2) 补全了裁决-09 初版**漏列的 8 个字段**；
> (3) 要求 `options.go` 每个字段的注释**同时写出它在 Pebble / Badger / LevelDB 中的对应名**，
> 以便交叉阅读源码时不会混淆。
>
> **命名冻结规则**：此表在 M1 开始后**不得再改名**；如需改名必须同步更新裁决-23、本文件与交付文档 02。
>
> **✅ 作者已定夺（2026-09-29）**：`RestartInterval` 与 `IndexBlockSize` **移入稳定级 `Options`**，作为「格式参数」子分组
> （见 §1.1）；§1.2 已移除这两项。理由：它们**改变磁盘字节**，按裁决-09 的判据属稳定级（由 properties 块记录并在打开时校验）。

### 1.3 三级内存上限（裁决-19）

```
memtable_budget     = MemTableSize × MemTableCountLimit        默认 4 MB × 2 = 8 MB
block_cache_budget  = BlockCacheSize                            必须显式设置
index_filter_budget = IndexFilterBudget                         默认 block_cache_budget × 20%

若 TotalMemoryBudget > 0：Open 时校验三者之和 ≤ TotalMemoryBudget，否则返回配置错误（早失败）
库**不**调用 debug.SetMemoryLimit（裁决-08）
超限行为：内存表 → 阻塞写（stall）；块缓存 → strict_capacity_limit=true 语义拒绝插入
```

### 1.4 WAL 与内部键编码（最终规格）

```
WAL 物理层：32 KiB 固定块；7 字节 chunk 头 = maskedCRC32C(4B LE) | length(2B LE) | type(1B)
            片段类型：FULL / FIRST / MIDDLE / LAST；记录不跨块；块尾剩余 <7B 全零填充；
            恰好剩 7B 时发零 payload 的 FIRST；CRC 覆盖 type + payload，不覆盖 length
WAL 文件头：magic(8B) | formatVersion(uint16) | blockSize(uint32)   ← 刻意偏离 LevelDB（无魔数）
WAL 逻辑层：批次头 = seq(uint64 LE) | count(uint32 LE)，其后是 tagged 条目

内部键：user_key ‖ trailer(uint64 LE)         trailer = (seqNum << 8) | kind
        seqNum ∈ [10, 2^56 − 1]（1–9 保留）；kind：0=Invalid 1=Set 2=Delete，3..15 预留
排序：用户键升序，trailer **降序**（格式常量）
批次原子性：批次占用**连续序号区间**，长度 = 操作数；靠可见性水位单调推进
序号耗尽：拒绝写入（`ErrSequenceExhausted`），**不回绕**
```

### 1.5 SSTable 文件格式 v1（最终规格）

```
[ 数据块 ][ 数据块 ]...[ 索引块 ][ 过滤器块 ][ 属性块 ][ footer(53B) ]
块 = block_data + type(1B) + crc32c(4B)      ← trailer 5 字节；CRC 覆盖压缩后数据 + type 字节
footer = 属性块句柄 | 索引块句柄 | metaindex 句柄 | padding | footer_format_version(uint32) | magic(8B)
magic = 0x53c9fb8ce508ea61    ← 由 SHA-256("http://github.com/cairnkv/cairnkv") 前 8 字节导出，可复核
双版本号：footer_format_version（文件级）+ store 级版本（写在 MANIFEST）
格式升级：读出**未来版本 ⇒ 拒绝打开**；读旧版本兼容；升级靠后台 compaction 全量重写（不原地改）

属性块必须写入（用于 B-42 的启动校验）：
  用户比较器名 | 内部键编码版本 | restart interval | BlockSize | 压缩算法集合
```

**必须抬 `footer_format_version` 的改动**：块内编码变化、trailer 布局变化、footer 字段增删、
压缩类型字节语义变化、**过滤器块是否分区**。

---

## 2. 里程碑总览

| 阶段 | 目标 | 退出标准（必须全部为真） | 相对草案的变化 |
|---|---|---|---|
| **M0** | 骨架与契约 | `go.mod`、目录结构、错误分类、`vfs` 接口与 `os` 实现、`Options` 两层结构、CI 骨架跑通 | 新增：错误分类含 `ErrEnginePoisoned`；`vfs.SyncDir` 单列 |
| **M1** | 崩溃恢复最小闭环 | 验收标准 1（强杀进程后已确认写入可读）；`dup` 三道门槛有测试；INV-1..5 各有用例 | 新增：毒化状态机（V-04）、组提交可观测事件（V-03）、`logSeqNum` 重建（V-08） |
| **M2** | 文件格式与读路径 | 验收标准 2（数据文件写完但元数据未更新时崩溃不损坏）；跑通全部对照实验的第一批 | 新增：标记文件取代 `CURRENT`；压缩默认开启；索引 pin；`ErrCorruption` 全路径 |
| **M3** | 合并与度量 | 验收标准 3（对拍 + 竞态检测）；验收标准 4（对照实验数据齐全）；放大系数可输出 | **改动最大**：leveled 取代 size-tiered；范围删除 defer |
| **M4** | 网络与工具 | 验收标准 5（服务端不无限增长内存）；验收标准 7（引擎不引用网络层）；`cairnkv check` 可用 | N-06 改为协议层实现 |
| **M5** | 示例、实验与论文材料 | 验收标准 6（时序示例仅依赖公开 API） | 时序示例需**自己实现过期逻辑**（范围删除 defer 的代价） |

---

## 3. M0 · 骨架与契约

**目标**：把"接口与契约"先钉死，避免后续返工。**不实现任何存储逻辑。**

### 3.1 工作项

| # | 工作项 | 产出 | 依据 |
|---|---|---|---|
| M0-1 | `go.mod` + 目录骨架（草案 §6.1） | 目录树 | 草案 §6.1 |
| M0-2 | 错误分类与哨兵错误 | `errors.go`：`ErrNotFound`、`ErrCorruption`、`ErrEnginePoisoned`、`ErrUnsupported`、`ErrSequenceExhausted`、`ErrArenaFull`、`ErrReadOnly` | 草案 §6.3；裁决-06 |
| M0-3 | `vfs` 接口 + `os` 实现 + `mem` 实现 | `internal/vfs` | iter-04 |
| M0-4 | `Options` 两层结构（稳定级 + `Tuning`） | `options.go` | 裁决-09 |
| M0-5 | `Comparer` 接口 + 字节序实现 | `internal/keys` | B-42 |
| M0-6 | `Logger` 接口（不 panic、不 `os.Exit`） | `logger.go` | 裁决-06 |
| M0-7 | CI 骨架：gofmt / go vet / `-race` 单元测试 | `.github/workflows/ci.yaml` | iter-19 |

### 3.2 `vfs` 接口草案（iter-04，12+11 方法）

```go
// FS 是文件系统抽象。目录同步必须单列 —— 否则验收标准 2 无法测试（iter-19 的 B-41 补充）。
type FS interface {
    Open(name string) (File, error)          // 只读
    Create(name string) (File, error)        // 读写
    Remove(name string) error
    RemoveAll(name string) error
    Rename(old, new string) error            // 必须原子（同目录）
    MkdirAll(dir string, perm os.FileMode) error
    Stat(name string) (FileInfo, error)
    List(dir string) ([]string, error)
    Lock(name string) (io.Closer, error)     // LOCK 文件独占
    SyncDir(dir string) error                // ★ 必须单列
    Link(a, b string) error                  // 需要时用于标记文件
    Close() error
}

type File interface {
    ReadAt(p []byte, off int64) (int, error)
    WriteAt(p []byte, off int64) (int, error)
    Sync() error                             // 语义 = 「先 flush 缓冲，再 fsync」
    SyncData() error                         // Linux → fdatasync；其他平台 → Sync
    Truncate(size int64) error
    Stat() (FileInfo, error)
    Close() error
}
```

**平台约束（必须写进 `docs/durability.md`）**
- darwin：Go 的 `os.File.Sync` 已是 `fcntl(F_FULLFSYNC)`（Go 1.27.1 的
  `internal/poll/fd_fsync_darwin.go`），**但有 `ENOTSUP` 回退到 `fsync(2)` 的分支** ⇒
  仍必须走 vfs 抽象，且该行为需平台测试覆盖（V-10）。
- Windows：`SyncDir` **只能**是 no-op（`badger/dir_windows.go:100`）⇒
  必须在文档中显式声明，否则是静默数据丢失风险。

### 3.3 退出标准

- [ ] `go build ./...` && `go vet ./...` && `gofmt -l .` 全清
- [ ] `vfs` 的 `os` 与 `mem` 两个实现通过同一套一致性测试（含 `SyncDir`）
- [ ] `Options` 的两层结构有文档注释标明稳定性等级
- [ ] 错误分类有单元测试断言 `errors.Is` 链

---

## 4. M1 · 崩溃恢复最小闭环

**目标**：验收标准 1 —— 写入若干数据后强杀进程，重启后所有**已确认**写入可读。

### 4.1 工作项（建议顺序，前四项是其他项的前置）

| 顺序 | # | 工作项 | 关键约束 | 依据 |
|---|---|---|---|---|
| 1 | M1-1 | **WAL 写入器** | 32 KiB 块 + 7B chunk 头 + 4 类片段 + masked CRC32C；**`Sync()` 先 flush 未满块再 fsync**（INV-1） | iter-05 |
| 2 | M1-2 | **WAL 读取器与恢复** | 只有**文件尾**不完整可静默截断；**文件中部的**任何不完整/CRC 失败必须报 `ErrCorruption`（9 条判定表） | iter-05 |
| 3 | M1-3 | **arena 跳表内存表** | Go 堆内 `[]byte` arena；32 位偏移链接；`maxHeight=20`；`pValue=1/e`；节点按实际高度分配；`Prepare` 预留（INV-3） | iter-07/08 |
| 4 | M1-4 | **内部键与比较器** | `user_key ‖ (seq<<8|kind)`；trailer 降序；`0=Invalid/1=Set/2=Delete`；`ErrRecordExists` 不允许（键带唯一 trailer 后缀） | iter-09；裁决-04 |
| 5 | M1-5 | **提交管线（组提交）** | 两信号量预订槽位 + `logSeqNum.Add(n)-n` 连续分号 + `commit.Add(2)` 表达确认点；**INV-4 的 break 规则** | iter-06 |
| 6 | M1-6 | **组提交可观测事件**（V-03） | 暴露可订阅事件：组内序号区间 + fsync 完成时刻。**没有它 `dup` 在分组档只能做弱断言** | 裁决-21 D6 |
| 7 | M1-7 | **毒化状态机**（V-04） | fsync 失败 ⇒ `poisoned`；后续所有 API 返回 `ErrEnginePoisoned`；等待者一律收到该错误；`Close()` 不做尽力而为的 flush | 裁决-06 |
| 8 | M1-8 | **内存表冻结与切换** | 五状态机 `active→immutable→flushing→flushed→freed`；`writerRefs` 在 WAL 写**之前**获取（INV-2）；`readState` 用覆盖单指针的 `sync.RWMutex` | iter-08；裁决-01/02 |
| 9 | M1-9 | **恢复与 `logSeqNum` 重建**（V-08） | 重放 WAL → 重建序号；**断言新写入序号严格大于崩溃前所有已重放记录的序号** | iter-09 |
| 10 | M1-10 | **三级内存上限与早失败** | `TotalMemoryBudget > 0` 时 `Open` 校验；库不调 `SetMemoryLimit` | 裁决-19/08 |
| 11 | M1-11 | **模型对拍测试（金字塔 L1）** | **自建有序模型**（**不用 Go `map`** —— 无序遍历无法校验 F-05/F-06 的边界与 Seek 语义）；操作集 17 项；每 100 步全量对拍 + 快照对拍 + Reopen 后再对拍 | iter-19 |
| 12 | M1-12 | **故障注入基础设施（金字塔 L2）** | 插入点在 **vfs 层**：`Injector.MaybeError(Op{Kind,Path,Offset})`；`OpKind` 含 `OpFileSync/OpFileSyncData/OpFileSyncTo/OpFileFlush`；可组合 `Any/Counter/Toggle`；谓词 DSL `Reads/Writes/PathMatch/OpKindIn/Randomly(p,seed)` | iter-19 |

### 4.2 公开 API 草案（根包 `cairnkv`）

```go
// DB 是引擎句柄。所有方法并发安全；Close 之后除 Close 外均返回 ErrClosed。
type DB interface {
    Get(key []byte) ([]byte, error)                 // 不存在 → ErrNotFound
    Set(key, value []byte, o *WriteOptions) error    // 便捷封装 NewBatch()+Apply
    Delete(key []byte, o *WriteOptions) error
    Apply(b *Batch, o *WriteOptions) error           // 批量原子写
    NewBatch() *Batch
    NewIter(o *IterOptions) (Iterator, error)        // 范围扫描
    NewSnapshot() *Snapshot                          // 只读快照；必须 Release
    Flush() error                                    // 强制冻结并刷盘
    Compact(start, end []byte) error                 // 手动触发合并（[start,end) 或全库）
    Metrics() Metrics                                // 见 §8
    Close() error
}

type WriteOptions struct {
    Sync SyncMode     // 覆盖 DB 级默认；SyncAlways/SyncGroupCommit/NoSync
}

type IterOptions struct {
    LowerBound, UpperBound []byte   // [lower, upper)
    Snapshot *Snapshot              // nil = 读最新
}

type Iterator interface {
    First() bool
    Last() bool
    SeekGE(key []byte) bool
    SeekLT(key []byte) bool
    Next() bool
    Prev() bool
    Key() []byte      // 仅在下一次移动前有效
    Value() ([]byte, error)   // 返回 error：可能是 ErrCorruption
    Valid() bool
    Error() error
    Close() error
}

type Snapshot struct{ /* 内部：seqNum + readState 引用 */ }
func (s *Snapshot) Get(key []byte) ([]byte, error)
func (s *Snapshot) NewIter(o *IterOptions) (Iterator, error)
func (s *Snapshot) Release()   // 必须调用；未 Release 时空间占用单调增长（用户契约）
```

**API 面的三条显式决定**
1. **不提供 `DeleteRange`**（裁决-17：范围删除 defer）。
2. **不提供带超时的写入阻塞**（裁决-18）：`Apply` 只可能返回 `nil` / 配置错误 / `ErrEnginePoisoned` /
   `ErrClosed`。需要超时的调用者必须在引擎之外实现，并承担"超时后写入状态未知"的语义。
3. **不提供 `SyncWait` / `noSyncWait`**（裁决-05）。

### 4.3 测试用例映射（`dup` 的条件性 pass 必须有对应用例）

| 不变量 | 用例 | 断言 |
|---|---|---|
| INV-1 | 「记录正好落在未满块里」时 `Sync()` 后强杀 | 重启后该记录**可见**且完整 |
| INV-2 | 冻结切换 + 活跃快照 + 并发读 | 不存在"WAL 里有、内存里读不到"的窗口 |
| INV-3 | 注入 arena 满（`ErrArenaFull`） | 整批失败；WAL 中**没有**该批次；内存中**没有**部分条目 |
| INV-4 | 一组内混合 `SyncAlways` 与 `SyncGroupCommit` 的写入者 | 组提交的 fsync **不早于**所有 `SyncAlways` 写入者的确认 |
| INV-5 | vfs 注入一次 `OpFileSync` 失败 | 后续所有 API 返回 `ErrEnginePoisoned`；无任何未持久化写入被报成成功 |
| V-08 | 写入 → 强杀 → 重启 → 再写入 | 新写入序号 > 崩溃前所有已重放记录的序号 |

### 4.4 退出标准

- [ ] 验收标准 1 通过（强杀后已确认写入可读），含 `SyncAlways` 与 `SyncGroupCommit` 两档
- [ ] INV-1..INV-5 与 V-08 的 6 个用例全部通过
- [ ] `-race` 下模型对拍 10 分钟无失败
- [ ] `vfs` 故障注入可以复现"WAL 写入后崩溃"

---

## 5. M2 · 文件格式与读路径

**目标**：验收标准 2 —— 在「数据文件已写完、元数据未更新」的时刻注入崩溃，重启后无损坏文件被当作有效数据。

### 5.1 工作项

| # | 工作项 | 关键约束 | 依据 |
|---|---|---|---|
| M2-1 | **SSTable 写入器** | 行式块格式 + 前缀压缩 + restart interval 16 + 5 字节 trailer（类型 + CRC32C）；块按 12% 压缩阈值决定是否压缩 | iter-10/14 |
| M2-2 | **SSTable 读取器** | 两级索引（结构自描述，v1 起支持）；索引块 **CRC 失败不得降级为 NotFound**（AS-3）；未知压缩类型报 `ErrCorruption`（AS-4） | iter-10/12 |
| M2-3 | **footer 与魔数** | 53 字节 footer + 双版本号 + 专属魔数；版本边界表；未来版本**拒绝打开** | iter-10 |
| M2-4 | **过滤器** | 整文件满过滤器 + 缓存行分块 Bloom；10 bits/key；**必须支持关闭**（对照实验需要） | iter-11 |
| M2-5 | **块缓存** | 分片 CLOCK-Pro；分片数 `clamp(4×GOMAXPROCS, 每片 ≥ 4 MiB)`；`strict_capacity_limit = true`；`EvictFile`；**pin 顶层索引块**；**扫描不填充缓存** | iter-13；裁决-12 |
| M2-6 | **三笔内存预算** | 见 §1.3；独立强制执行 | 裁决-19 |
| M2-7 | **Manifest** | 复用 WAL log-format；`VersionEdit` 取核心 7 tag；**全量快照首记录 + 增量编辑**；128 MB 滚动 | iter-15 |
| M2-8 | **标记文件取代 `CURRENT`** | `marker.manifest.<iter>.<值>`；S1–S6 步骤级算法；目录 fsync 失败 ⇒ 毒化（裁决-06，非 panic） | iter-15；裁决-07 |
| M2-9 | **目录 fsync 调用清单 D1–D6** | SSTable 落盘后、标记文件创建后、删旧文件后等；平台差异显式声明 | iter-15 |
| M2-10 | **恢复流程与打开时校验** | 校验 ① 魔数与格式版本 ② footer/properties ③ MANIFEST 完整性与比较器一致性；**不全量扫块**（裁决-21 D3）；清理未登记残留文件；`LOCK` 独占 | iter-15；裁决-21 |
| M2-11 | **压缩** | 默认 Snappy + 12% 阈值；**不压缩索引/过滤器块**；主缓存存**解压后**的块 | iter-14 |
| M2-12 | **放大系数指标** | 10 个字段 + 公式 + 采集点；RA 给"文件数 / 字节数"**双口径**；`ReadAmpBytes` 同时采压缩后与解压后（V-12） | iter-01；裁决-14 |
| M2-13 | **断言 AS-1 + 断言 AS-2** | 多 run 读路径的输入迭代器全序断言；`0=Invalid` | 裁决-04；V-01 |
| M2-14 | **崩溃克隆测试** | `CrashClone{UnsyncedDataPercent}`：0 = 只保留已 fsync 数据；∈(0,100) 时按 4096 字节块 + 目录项按 entry 随机保留 | iter-19 |

### 5.2 数据目录布局（最终）

```
<data-dir>/
├── LOCK                                # 进程独占
├── marker.manifest.<iter>.<值>          # ★ 取代 CURRENT —— 唯一真相来源
├── MANIFEST-<编号>                      # 全量快照首记录 + 增量 VersionEdit
├── <编号>.wal                          # 预写日志（含文件头魔数 + 格式版本）
├── <编号>.sst                          # 不可变有序数据文件
└── <编号>.tmp                          # 尚未提交的临时文件（启动时清理）
```

**相对草案 §6.4 的改动**：`CURRENT` 单文件被标记文件族取代（裁决-07）；
`.wal` 增加文件头魔数 + 格式版本（草案只说"所有文件头带魔数与格式版本"，
LevelDB 原版 WAL **没有**魔数 —— 这是有意偏离）。

### 5.3 崩溃注入的三个定点（对应草案 B-35 与 O-06）

| 时刻 | 注入方式 | 重启后的期望 |
|---|---|---|
| WAL 记录写入后、fsync 前 | `OpFileSync` 失败 / 直接丢弃未 fsync 数据 | 该批次不可见；引擎状态一致 |
| SSTable 写完、标记文件切换前 | 丢弃 `.tmp` / 保留未登记 `.sst` | 未登记文件被识别并清理；**不**当作有效数据 |
| 标记文件切换后、旧文件删除前 | 保留旧 MANIFEST | 以标记文件指向的 MANIFEST 为准；旧文件被清理 |

### 5.4 退出标准

- [ ] 验收标准 2 通过（三个注入点各有用例）
- [ ] 格式版本的"拒绝打开未来版本"有测试
- [ ] 三笔内存预算的上限可被单元测试断言
- [ ] 过滤器关闭/开启的读放大差异可被 `test/bench` 观测

---

## 6. M3 · 合并与度量（**改动最大的阶段**）

**目标**：验收标准 3（对拍一致 + 竞态检测通过）与验收标准 4（对照实验数据齐全）。

### 6.1 工作项

| # | 工作项 | 关键约束 | 依据 |
|---|---|---|---|
| M3-1 | **合并选择（leveled）** | **推翻草案的 size-tiered 默认**；`Finalize` 打分：L0 按**文件数**（阈值 4）、L1+ 按字节比；`baseLevel` 自底向上推导（`DynamicBaseLevel=true`）；"L0 → baseLevel"的输出层选择 | iter-16；裁决-15 |
| M3-2 | **合并执行** | 祖父层重叠限制 `10 × TargetFileSize`；扩展限制 `25 × TargetFileSize`；结果**先落盘 → 原子切元数据 → 删旧文件** | iter-16；B-35 |
| M3-3 | **版本丢弃规则 + 墓碑丢弃** | 丢弃规则 (A) `lastKeptSeq <= watermark ⇒ drop`；墓碑物理丢弃须满足 **AS-5**（条件A ∧ 条件B） | iter-09/18 |
| M3-4 | **断言 AS-1 强化** | 合并输入迭代器全序断言 + **模型测试**：「同一键跨 3 个 L0 文件写 3 个版本 + 一个活跃快照」对拍 | V-01 |
| M3-5 | **调度与背压** | 三级优先级调度；`L0SlowdownWritesTrigger=8`（1 ms，每次写入只延一次）、`L0StopWritesThreshold=12`、`MemTableStopWritesThreshold=2`、`L0CompactionConcurrency=10`；限速器**默认关闭**；**背压只有两档**：`Block` / `ReturnError`；**引擎层不做准入控制**（补充轮 iter 23 判 `defer`）——本项**新增一条只读指标义务**（候选 C）：导出 `L0NumFiles`、`L0Bytes`、`L0FlushBytes`、`L0CompactedBytes`（**出 L0** 的合并字节，非全层合计）、`WriteStallCount`/`WriteStallNanos`，供网络层（M4-2）的速率整形取用；**实现约束**：任何未来的准入/拒绝点必须在 WAL append **之前**，通过准入后不得再因过载拒绝（否则退回裁决-18 已否决的"超时但可能已提交"语义） | iter-17；裁决-18；iter-23 |
| M3-6 | **取消与关闭协议** | 合并可被 `context` 取消；`Close()` 终止合并并等待退出；部分完成的合并结果**丢弃**（不切元数据） | iter-17；草案 §6.5 |
| M3-7 | **放大系数统计（完整）** | `write_amp = (WAL + flush + compact) / 用户字节`；`write_amp_lsm`（Pebble 口径）；RA 双口径；`space_amp = DiskUsageBytes / LiveEstimatedBytes` + `SA_collectable`/`SA_pinned` + 墓碑三指标 | iter-01/18 |
| M3-8 | **故障注入全覆盖（金字塔 L2）** | 每个 `Sync()` 调用点 + 每个元数据提交点；`CrashClone` 概率全扫 | iter-19 |
| M3-9 | **蜕变测试骨架（金字塔 L3a）** | **M3 目标，不作为 M1 前置**；跨配置等价 + 落盘 ops + OPTIONS 文件 + 自动简化器 | iter-19 |
| M3-10 | **写放大重测**（V-05） | iter-16 的"约 2.7×"是 Sarkar PVLDB 2021 在 RocksDB、T=10、128 B entry 下的实测，**必须重测** | V-05 |
| M3-11 | **参数扫描**（V-06） | `MemTableSize ∈ {1,4,16,64} MB` × `Threshold ∈ {2,4,8}`；WAL 块 `{4,16,32,64,128} KiB`；`(p, maxHeight) ∈ {1/4,1/3,1/e} × {12,20,24}`；与恢复耗时实验合并做 | V-06 |
| M3-12 | **GC 与内存配比实验**（V-07） | 同时记录 `runtime.MemStats` 与 GC 周期数，观察是否 thrashing | V-07 |
| M3-13 | **离线校验 `cairnkv check`** | 不变量清单见 §9.3；PR 只跑小 golden 集，发布前跑全量 | 裁决-21 D4 |

### 6.2 合并策略参数块（可直接落实）

```
NumLevels            = 7
SizeRatio (T)        = 10
LevelBaseBytes       = 10 MB
TargetFileSize       = 2 MB
L0CompactionThreshold = 4
DynamicBaseLevel     = true
MaxGrandparentOverlapBytes     = 10 × TargetFileSize
ExpandedCompactionByteSizeLimit = 25 × TargetFileSize
```

### 6.3 第一期只实现一种策略（leveled）——但接口为第二种留位

`size-tiered` / `Universal`、`hybrid` / `lazy leveling`、自适应（tiering ↔ leveling）**全部 `defer`**。
`MergePolicy` 接口必须能在不改调用方的前提下接入第二种策略。

**自适应策略 defer 的理由必须如实记录（iter-21 已更新，替代旧措辞）**：Moirai 与 LSM-forest **作为 LSM 论文不存在**
（Moirai：`semanticscholar` 检索式 `Moirai LSM-tree adaptive tiering leveling` → `totalCount = 0`；
LSM-forest：唯一存在形式是 TigerBeetle 的 HYTRADBOI 2022 **演讲**，无 DOI）——因此旧措辞「未能核验其存在 ⇒ 证据缺口」
是**基于幻觉文献的错误理由**，**不得再作为 defer 的依据**。
iter-21 已真正检索该方向：**存在可引用的一手工作**（Dostoevsky SIGMOD'18 `DOI:10.1145/3183713.3196927`；
LSM-Bush/Wacky SIGMOD'19 `DOI:10.1145/3299869.3319903`；EcoTune SIGMOD'25 `DOI:10.1145/3725344`；
RusKey PACMMOD'23 `DOI:10.1145/3617333`），**但没有任何一个能在不先实现 tiered-hybrid 布局、
不引入运行时布局迁移与代价模型的前提下落地第一期**；且**切换成本**是本方向公认瓶颈
（Dostoevsky 附录 G 自述 "the current adaptive policies are a starting point"；RusKey §1.1 称之为
"the main bottleneck of designing dynamic LSM-trees"）。生产侧亦无先例（RocksDB `compaction_style` 为 **immutable** 选项：
`rocksdb/options/cf_options.h:28 @ 7510773`；Cassandra 5.0 UCS 自述自动适配属**未来工作**）。
⇒ `defer` 的理由是「**可行的自适应形态全部依赖我们已 defer 的 hybrid 布局，且切换成本为公认瓶颈**」，
**不是**"方案更差"（无量化证据），也**不是**"无可用一手工作"。见 §9.4 的 U-4。

### 6.4 退出标准

- [ ] 验收标准 3 通过（对拍一致 + `-race` 通过）
- [ ] 验收标准 4 通过（四组对照实验数据齐全；**注意 mmap 不在验收标准 4 的清单里**）
- [ ] 写放大重测完成，`wa` 评分用实测值替换文献值
- [ ] AS-1 / AS-5 的模型用例通过

---

## 7. M4 / M5 · 网络层与示例（骨架）

### 7.1 M4 · 网络接入层与工具

| # | 工作项 | 关键约束 |
|---|---|---|
| M4-1 | `proto` 二进制协议 | 版本号 + 请求标识 + 错误码 + 最大帧限制 |
| M4-2 | `cairnkv-server` | 请求处理与磁盘操作解耦（草案 N-03）；写入队列有界（N-04） |
| M4-3 | **N-06 的实现位置改到协议层**（裁决-18） | 幂等请求 ID + 响应中返回"该请求是否已进入组提交"，使客户端在超时后能**查询**而非**猜测** |
| M4-4 | `cairnkv-client` | 连接复用、超时、异步请求、请求响应匹配 |
| M4-5 | `cmd/cairnkv-cli` | 读写、压测、恢复演示、**`cairnkv check <dir>`** |
| M4-6 | L0 子层重新评估（V-11） | 触发条件：**同一键上互相重叠的 L0 文件数（子层高度）经常 > 8**；评估时必须先量出 CairnKV 自己的「每次点查检查的 L0 文件数」分布（iter-22 已确认上游无可借用数字） |
| M4-2b | **`N-04` 的准入规格（补，iter 23）** | (i) 写队列上限按**内存字节**计（呼应验收标准 5：磁盘变慢时内存不得无限增长）；(ii) 队列满或等待超时返回**专用过载错误码**（不复用 `timeout`）；(iii) 可选 token-bucket 速率整形，速率由 M3-5 导出的 L0 指标驱动，**默认关闭**，M5 对照实验定标；(iv) 该队列是引擎之外唯一的拒绝点 |
| M4-7 | 引擎层准入控制重新评估（**V-13**） | 触发条件见 `DELIVERABLE-02` §17 第 9 行 |

### 7.2 M5 · 示例、实验与论文材料

| # | 工作项 | 关键约束 |
|---|---|---|
| M5-1 | 时序示例（`examples/timeseries`） | 仅依赖公开 API；**必须自己实现过期逻辑**（范围扫描 + 批量墓碑，写入量 O(过期键数)）—— 这是范围删除 defer 的代价（裁决-17） |
| M5-2 | 对照实验矩阵 | ① 顺序写 vs 随机覆盖写吞吐 ② 逐次同步 vs 分组同步的吞吐与尾延迟 ③ 有无过滤器 ④ 合并参数扫描（第一期）/ leveled vs tiered（M5 补）⑤ Snappy vs 无压缩 vs Zstd-1 vs MinLZ ⑥ CLOCK-Pro vs LRU ⑦ mmap vs pread（`EXP-13-MMAP`） |
| M5-3 | 真实文件系统崩溃一致性（V-09） | 非 CI 的 `dm-log-writes` / `dm-flakey` job；结果写入 `docs/durability.md` 的已知局限 |
| M5-4 | 论文材料 | 放大系数的实测曲线 + 参数敏感性 + 有意偏离的代价评估 |

---

## 8. 可观测性契约（iter-01 的 10 个字段）

```go
type Metrics struct {
    // ── 写放大 ──
    UserBytesWritten     uint64  // 分子分母的公共基准
    WALBytesWritten      uint64  // 分母的一部分
    TablesFlushedBytes   uint64  // 分子
    TablesCompactedBytes uint64  // 分子
    // write_amp      = (WAL + TablesFlushed + TablesCompacted) / UserBytes
    // write_amp_lsm  = (TablesFlushed + TablesCompacted) / UserBytes   ← Pebble 口径，两者都报

    // ── 读放大（双口径）──
    ReadAmpFiles    float64  // Σ Levels[i].Sublevels（Pebble 口径）
    ReadAmpBytes    uint64   // 点查读到的字节数（压缩后与解压后**都采**，见 V-12）
    BytesReadUser   uint64   // 用户发起读的次数（goleveldb 的 Counter 形态）

    // ── 空间放大 ──
    DiskUsageBytes        uint64   // 含 live + obsolete + zombie + in-progress
    LiveEstimatedBytes    uint64
    // space_amp = DiskUsageBytes / LiveEstimatedBytes
    SACollectable float64  // Σ stale(f) / Σ size(f)
    SAPinned      float64  // Σ pinned(f) / Σ size(f)   ← 快照造成的不可回收比例

    // ── 墓碑专项 ──
    TombstoneCount            uint64
    TombstoneDenseBlockRatio  float64  // 密度启发式阈值：RFC 写 5%，Pebble 代码默认 0.10（上游未收敛，U-13）
    TombstoneBytesRatio       float64

    // ── 事件计数（草案 O-03/O-04）──
    WALSyncCount        uint64
    FlushCount          uint64
    CompactionCount     uint64
    CompactionNanos     uint64
    RecoveryNanos       uint64
    RecoveryRecordsReplayed uint64
}
```

**要求**：指标必须能被**结构化读取**（不只是打日志）——否则测试无法断言（iter-19 的 B-46~B-49 补充）。
RA 要能拆成「读次数 / 读字节数」两种，且**按归因分项可观测**（见 §8.1）。

### 8.1 RA 收益归因表（**五个分项不叠加**，裁决-14；初版曾误写「四个」，与表内 5 行不符）

| RA 分项 | 归因 | 由谁改善 |
|---|---|---|
| `\|{重叠的 L0 文件}\|` | 合并/调度项 | M3-1（leveled 让 L0 快速下落）+ M3-5（L0 阈值） |
| `\|{有文件的层数}\|` | 合并项（层形状） | M3-1（`LevelMultiplier` / `DynamicBaseLevel`） |
| 未命中的索引块读 | 读路径项 | M2-2 + M2-5（pin 顶层索引、两级索引） |
| 过滤器假阳性导致的无效块读 | 过滤器项 | M2-4（10 bits/key、整文件粒度） |
| 缓存未命中导致的重读 | 缓存项 | M2-5（CLOCK-Pro、扫描旁路） |

**任何"读放大改善了 X%"的结论都必须指明是哪个分项**，否则不可复核。

---

## 9. 测试与门禁

### 9.1 四层测试金字塔（iter-19）

| 层 | 内容 | 实现成本 | 在 CI 中的角色 | 里程碑 |
|---|---|---|---|---|
| **L0 单元** | 各包内部行为；`vfs` 两个实现的一致性 | 低（标准库） | PR 必过 | M0 |
| **L1 模型对拍** | **自建有序模型**（17 项操作集）+ 快照对拍 + Reopen 后对拍 + 换 Options | 低（LevelDB 最小形态 187 行） | PR 必过 | M1 |
| **L2 故障注入 + 崩溃克隆** | vfs 层统一注入 + `CrashClone`；PR 定点必过 + nightly 概率全扫 | 中（Pebble 1,046+977 行 / LevelDB 550 行） | PR 定点 + nightly 全扫 | M1（注入框架）/ M2（克隆） |
| **L3a 蜕变测试** | 跨配置等价 + 落盘 ops + OPTIONS 文件 + 自动简化器 | **高（Pebble 10,719 行）** | nightly 必跑 | **M3**（不是 M1） |
| **L3b `-race`** | 全部并发用例 | 零（标准库） | PR 必过 | M0 |
| **L3c fuzz** | **仅限解析代码**（WAL / 块 / MANIFEST）；PR 20 s smoke + nightly 10 min | 零（Go 工具链） | PR smoke + nightly | M2 |
| **L3d 跨版本跨格式** | 新格式读旧格式；拒绝打开未来版本 | 低 | nightly | M2 |
| **L4 `cairnkv check`** | 离线不变量扫描 | 中（Pebble 970 行） | PR 小 golden 集 + 发布前全量 | M3 |

**关于 fuzz 的一条负面证据**：`grep -rn "^func Fuzz"` 在 pebble / badger / goleveldb / bbolt
**全部零命中** —— 4 个 Go 存储引擎都**不用** `go test -fuzz`。所以"照抄 Pebble 就够"在 fuzz 这一层不成立；
但 Go 工具链恰好免费提供失败输入最小化与 `testdata/fuzz/` 语料持久化，因此**值得补上**（严格限定在解析代码）。

### 9.2 CI 门禁清单

**PR 门禁（预算合计 ≤ 20 分钟，全部必过）**

| # | 命令 | 预算 |
|---|---|---|
| 1 | `gofmt -l .` + `go vet ./...` | 30 s |
| 2 | `go test ./... `（单元 + 模型对拍） | 5 min |
| 3 | `go test -race ./...` | 8 min |
| 4 | `go test -run=TestCrash -tags=crash ./test/crash`（**定点**注入） | 3 min |
| 5 | `go test -run=TestInvariants ./test/model`（INV-1..5、V-08） | 2 min |
| 6 | `go test -fuzz=FuzzWALParse -fuzztime=20s ./internal/wal` 等解析 smoke | 1 min |
| 7 | `go build ./...` + 依赖方向检查（`internal/*` 不得引用 `server/client/proto/cmd`） | 30 s |
| 8 | `go test -run=FuzzCheck -golden=small ./test/check`（`cairnkv check` 小 golden 集） | 1 min |

**nightly（失败建 issue，不阻塞）**

| # | 命令 |
|---|---|
| 1 | `CrashClone` 概率全扫（`UnsyncedDataPercent ∈ {0,1,50,99}`） |
| 2 | 蜕变测试长跑 |
| 3 | `go test -fuzz` 10 分钟 × 3 个解析器 |
| 4 | 跨版本跨格式矩阵 |
| 5 | 参数扫描（V-06）、GC 配比实验（V-07） |
| 6 | **新增测试的 stress 门禁**：对 PR 中**新增的**每个 `Test` 跑 `stress -p 2 --maxruns 1000 --maxtime 10m`（防"只在幸运调度下通过"的测试入库；成本极低，无条件采纳） |
| 7 | `cairnkv check --full` 于一个 10 GB 合成库 |

### 9.3 `cairnkv check` 检查的不变量

1. 层不变量：每层的键区间不重叠（L0 除外）；层间有序关系正确
2. 点键全局有序（按 `InternalCompare`）
3. 墓碑有序且已碎片化（**条件适用** —— 范围删除已 defer，此项仅对单键墓碑生效）
4. 合并记录可处理
5. 属性块里的比较器名、内部键编码版本、restart interval、BlockSize 与当前配置一致
6. 无未登记的残留 `.tmp` / `.sst` 文件
7. 标记文件指向的 MANIFEST 存在且可解析
8. 每个 SSTable 的 footer/魔数/格式版本有效
9. （`--full` 时）全量扫块校验和

**打开时的校验程度**（裁决-21 D3）：只做 ① 魔数与格式版本 ② footer/properties ③ MANIFEST 完整性
与比较器一致性；**不全量扫块**。全量扫描归 `cairnkv check --full`。

### 9.4 未核验项（**不得在文档或代码注释里写成事实**；补充轮 iter 21–25 已关闭 U-1/U-2/U-3/U-4/U-5/U-6/U-9/U-10/U-12/U-14）

> 下表只列**仍开放**的 5 项（U-7/U-8/U-11/U-13/U-15，均属「等引擎或上游」的 B 类）；
> 已关闭项的一句话结论见 `DELIVERABLE-02` §1.4 与 `.autoresearch/work/iter-20-arbitration.md` 第五部分。

| # | 未核验项 | 影响 |
|---|---|---|
| U-7 | 32 KiB WAL 块在 2026 年是否仍最优 | 进 V-06 的扫描 |
| U-8 | `arenaskl` README 的 benchmark 数字 | 自报告，未独立复现 |
| U-11 | `SeqNumStart = 10` 保留区的用途 | 不阻塞 |
| U-13 | 墓碑密度阈值（RFC 5% vs 代码 0.10） | 需自测 |
| U-15 | 目录 fsync 在 overlayfs / tmpfs / NFS 上的行为 | 进 V-09 与文档局限 |

> **补充轮关闭项的要点**：U-1 有出处（Pugh CACM 1990 Table 1，口径限定最小化 `L(n)/p`，Pugh 推荐 1/4）；
> U-2 四方 mask 逐位一致，但不声称整体格式兼容；U-3 无官方明文（机制可推出、P 不被交出去，mmap 否决不依赖）；
> U-4 Moirai/LSM-forest 不存在、自适应 defer 理由已重写；U-5 DeWitt 1984 不是首提（引用限定为「早期书面描述」）；
> U-6 `InternalKeyKindInvalid = 191`；U-9 CockroachDB 一手 URL 已找到（引擎层准入控制判 defer）；
> U-10 RocksDB arena/`block_size` 已核验；U-12 minlz 已核验（仍不进默认）；U-14 上游确有 MANIFEST 滚动公式（单位为表数）。

---

## 10. 风险登记表

| # | 风险 | 概率 | 影响 | 对策 | 归属 |
|---|---|---|---|---|---|
| R-1 | **版本丢弃规则在乱序输入下丢掉正确版本且不报错** | 中 | **致命（静默数据错误）** | AS-1 断言 + V-01 模型测试；断言在 debug 与 release 都开 | M2/M3 |
| R-2 | `dup` 的三条不变量未被实现，`dup=pass` 变成无条件误读 | 中 | 高 | INV-1/2/3 各有定点用例（M1-11、§4.3） | M1 |
| R-3 | fsync 失败未毒化 ⇒ 未持久化写入被报成成功 | 中 | **致命** | INV-5 用例；`vfs` 注入 `OpFileSync` 失败 | M1 |
| R-4 | leveled 的写放大高于预期（文献 2.7× 不等于本实现） | 高 | 中（吞吐） | V-05 重测；`wa=2` 用实测值替换 | M3 |
| R-5 | 目录 fsync 在部分文件系统上无效 ⇒ 崩溃后元数据丢失 | 低 | **致命** | V-09 真实 FS job；`docs/durability.md` 声明局限；不承诺未验证的平台 | M5 |
| R-6 | CI 全绿 ≠ 真实文件系统正确 | 高 | 中 | 显式记录为跨平台局限（iter-19 的 U1）；不在 CI 里假装解决 | 全程 |
| R-7 | 合并调度的并发 bug（饥饿、死锁、部分完成） | 中 | 高 | 三级优先级 + 可取消 `context`；`Close()` 等待退出；`-race` | M3 |
| R-8 | 参数默认值全是从众取值，未在本负载验证 | 高 | 低-中 | V-06 参数扫描；把"从众"如实写进文档 | M3 |
| R-9 | 格式版本升级缺少迁移路径 | 低 | 高 | 双版本号 + 拒绝打开未来版本 + 后台全量重写；版本边界表 | M2 |
| R-10 | 元数据（标记文件）机制在异常文件系统上退化 | 低 | 高 | 不依赖 rename 持久性（把"哪一个是当前"编码在文件名）；目录 fsync | M2 |

---

## 11. 明确不在第一期范围内的项（含重新评估的触发条件）

| 项 | 状态 | 触发条件 |
|---|---|---|
| 范围删除（`DeleteRange`） | `defer` | 上游示例需要 O(1) 批量删除，且能接受 5 个子系统的改动量。kind `3..15` 已预留，**加入不需提升格式版本** |
| TTL 引擎原语 | `defer` | 上层反复实现"范围扫描 + 批量墓碑"成为瓶颈时 |
| Compaction filter | **`reject`** | 无触发条件（它把用户代码引入合并路径，破坏确定性） |
| KV 分离（WiscKey / Blob） | `defer` | 值平均 > 1 KB 且值主导搬移量时 |
| size-tiered / Universal | `defer` | M5 的 leveled vs tiered 对照显示 tiered 在目标负载下更优时 |
| hybrid / lazy leveling | `defer` | 上层实现完成后，若 R-4 的写放大实测不可接受，这是**最可能的第二期升级路径** |
| 自适应合并（tiering ↔ leveling） | `defer`（**有依据的 defer**；iter-21 已完成针对性检索，证据缺口已补上） | ① `hybrid` / lazy leveling 落地并实测稳定；② `test/bench` B-54 对照显示「读写比变化 ≥3× 时固定参数无法同时满足 WA 与尾延迟」；③ MANIFEST 能低成本表达「同层多 sorted run」的中间版本 |
| L0 子层（sublevels） | `defer`（**已裁决，非遗漏；证据缺口型 defer——未量化**） | `test/bench` 观察到"**同一键上互相重叠的 L0 文件数（子层高度）经常 > 8**"时升级为独立研究条目（V-11）；需先具备「每次点查检查的 L0 文件数」指标 |
| `BlockWithTimeout` 第三档背压 | `defer` | 组提交下的"超时但可能已提交"语义漏洞被解决时 |
| `noSyncWait` / `SyncWait` | `defer` | 有调用者明确需要把 fsync 等待移出提交路径时 |
| mmap 读路径 | `defer`（仅 `test/bench` 实验） | `EXP-13-MMAP` 的判定规则 J1/J2/J3 显示明确收益时 |
| 索引/过滤器的独立高优先级缓存池 | `defer`（Tuning 开关，默认关） | pin 顶层索引 + 扫描旁路仍不足时 |
| MinLZ 压缩 | `defer`（仅对照；**U-12 已核验，许可/架构/构建无阻碍**） | `B-54` 对照实测显示「解压吞吐 ≥ Snappy × 0.9 且压缩后体积比 Snappy 小 ≥ 5 个百分点」，且 minlz 依赖已是 tag 发布版本时（M3 之后；块格式须先在 M2 预留压缩类型取值） |
| 第三方属性测试库（`rapid`） | `defer` | 自建简化器的收敛性不足时 |
| 目录布局的 `CURRENT` 兼容名 | `reject` | 不保留（两个真相来源） |
| 引擎层准入控制（admission control） | `defer`（**已评估**，iter 23；非遗漏） | 触发条件三条（见 `DELIVERABLE-02` §17 第 9 行，V-13）：长峰值下双阈值背压看不到的退化 / 出现可优先级化的类别差 / 有界队列+拒绝挡不住过载 |
| 引擎内部数据流调参（ADOC 式自动调线程数与批大小） | `defer` | 与 M3-11 参数扫描合并产出后仍显示停顿时长主导 p99 时；先做 M3-11 |
| 与 LevelDB 的二进制兼容 | `reject` | 专属魔数 + 53 字节 footer + kind 取值均已放弃兼容 |

---

## 12. 工作量估计（**估计，非测量**）

| 阶段 | 相对工作量 | 主要不确定性 |
|---|---|---|
| M0 | 0.5 | 低 |
| M1 | **3** | 组提交 + 冻结切换 + 毒化状态机的并发正确性；INV-1/2/3 的调试成本 |
| M2 | **3.5** | 文件格式一次定型；CLOCK-Pro 实现；两级索引；标记文件的崩溃语义 |
| M3 | **4** | **最大阶段**：leveled 选择/执行、版本与墓碑丢弃、调度、放大系数、蜕变测试骨架 |
| M4 | 2 | 协议设计与请求调度 |
| M5 | 1.5 | 实验矩阵的执行与数据整理 |

合计约 **14.5 个"人周单位"**（单位 = 一名熟悉 Go 与存储的工程师一周）。
其中**测试基础设施（L1+L2+L4）占 M1–M3 的约 25%** —— 这不是可选的：`dup` 的 `pass` 是**条件性**的。

---

## 13. 实现顺序的一句话建议

> **先做 vfs 与故障注入，再做 WAL；先让 `dup` 的三条不变量各有用例，再谈性能；
> 先重测写放大，再声称 leveled 是对的。**

理由：本循环发现的最大风险不是"性能不够"，而是**三条静默错误路径**
（乱序输入丢版本、冻结窗口读不到已持久化数据、fsync 失败后继续宣称成功）。
它们都不会让测试失败，只会让数据悄悄出错。所以测试基础设施必须与 WAL 同期落地，而不是后期补。
