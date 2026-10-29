# CairnKV 持久化与崩溃一致性规格（格式版本 1）

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-29（第二版：按审阅结果修订，见 `docs/spec-closure.md` §2.4） |
| 地位 | **协议步骤、确认语义与恢复判定以本文为准**。字节布局见 `docs/file-format.md`；决策理由见 `docs/spec-closure.md` |
| 守护 | 本文的编号（AP、INV、MI、CP、L、ST、W、F、K、P、S、D、N、R、PS、E、C、PC、T）在代码中用 `// durability: define <编号>` 标注**恰好一处**主落点，其他相关位置用 `// durability: see <编号>`；每个编号至少被一个测试名引用（I-5(b)） |

---

## 0. 术语

- **确认**：写入 API（`Set` / `Delete` / `Apply`）向调用者返回 `nil`。
- **持久**：系统崩溃（掉电、内核崩溃）后仍然存在。
- **可见**：此后开始的读能看到。
- **确认点（AP）**：确认时必须已经成立的持久性条件。
- **提交点（CP）**：多步操作中，一旦完成，崩溃后的恢复结果就变成新状态的那一步。
- **进程崩溃**：`kill -9`、宿主程序 panic 等。已 `write()` 进内核的数据不丢。
- **系统崩溃**：只保留已同步的数据。

---

## 1. 持久化模型

本节是全部推理和崩溃检查器（§11）的共同前提。实现只能依赖这里列出的保证。

### 1.1 同步原语（vfs）

| 原语 | 成功返回后保证 |
|---|---|
| `File.Sync()` | 文件的全部数据与元数据（含大小）已持久。darwin 上为 `F_FULLFSYNC` |
| `File.SyncData()` | 全部数据已持久，读回这些数据所需的元数据（大小）也已持久。Linux 为 `fdatasync`；其他平台等同 `Sync` |
| `File.SyncTo(n)` | **不提供任何保证**。只提示内核开始回写前 n 字节：Linux 为 `sync_file_range(SYNC_FILE_RANGE_WRITE)`，不带任何 WAIT 标志；其他平台为空操作。不能作为确认点或提交点。**它返回错误时照样毒化**（PS-1） |
| `OpenDir(d)` + `Sync()` | 目录 d 中此前完成的创建、删除、改名都已持久 |

v1 的持久化路径只依赖「创建、删除、目录同步」，**不依赖 rename 的原子性**（SC-19）。`Rename` 只用于把孤儿文件改名隔离（R12），不承担持久性职责。

### 1.2 系统崩溃后的可能状态

- 已同步的字节保持不变。
- 未同步的字节以 4 KiB 页为单位各自取值：新内容、全零或任意垃圾。文件长度可以是「持久长度」到「可见长度」之间的任意值。
  - 页粒度只是崩溃检查器的枚举粒度。CRC 能检出任意粒度的撕裂，所以格式与恢复规则不依赖页粒度。
- 未同步的目录操作：任意子集生效，每个操作本身是原子的。
- 一个文件即使数据已 fsync，只要它的目录项没同步，崩溃后也可能整个不见。**目录本身也是其父目录里的一个目录项**（见 D0）。

### 1.3 进程崩溃

已传给 `write()` 的字节全部保留（页缓存还在）；用户态缓冲中的字节丢失。

### 1.4 I/O 失败

- 同步类调用（`Sync`、`SyncData`、`SyncTo`、目录 `Sync`）返回错误后，对应文件或目录的持久内容就未知了。**之后再同步成功，也不能证明数据已持久**：Linux 在回写失败后可能把脏页标记为干净（Rebello et al., ATC 2020，`DOI:10.1145/3450338`）。处理方式见 PS-1。
- WAL、MANIFEST、标记文件的 `write()`、`Create`、`Close` 失败后，它们的可见内容未知。处理方式见 PS-2。

---

## 2. 写入的确认语义

### 2.1 同步档位与确认点

```go
// SyncMode 决定一次写入在确认前需要达到的持久性。
type SyncMode uint8

const (
	SyncDefault     SyncMode = iota // 零值：在 WriteOptions 中表示继承 Options.SyncMode；在 Options 中等同 SyncGroupCommit
	SyncGroupCommit                 // 默认档：与同组其他写入共享一次 fsync
	SyncAlways                      // 每个批次独占一组、单独一次 fsync
	NoSync                          // 不等待 fsync，须显式选择
)
```

| 编号 | 档位 | 确认时已成立 | 进程崩溃后 | 系统崩溃后 |
|---|---|---|---|---|
| **AP-1** | SyncGroupCommit | 包含该批次的那一次组提交 fsync 已成功返回 | 保留 | 保留 |
| **AP-2** | SyncAlways | 同 AP-1，并且这次 fsync 所在的组只有这一个批次 | 保留 | 保留 |
| **AP-3** | NoSync | 该批次的 WAL 字节已 `write()` 进内核 | 保留 | 可能丢失，直到 §2.2 的某个时刻 |

- AP-1 与 AP-2 的持久性相同，区别只在性能。SyncAlways 用作「逐次同步 vs 分组同步」对照实验的基线。
- **覆盖规则**：`WriteOptions` 为 nil，或 `Sync == SyncDefault` 时，用 `Options.SyncMode`；否则用本次写入的取值。本次写入可以比默认档更强，也可以更弱（后果由调用者负责）。取值越界 ⇒ `ErrInvalidOptions`。
- 任何 `Options` 字段名都不得含 `Durable` / `Safe` 一类字样。

### 2.2 NoSync 写入何时变为持久

满足以下任一事件之后：

1. 同一个 WAL 上之后任一次组提交的 fsync 成功返回（L9）；
2. 该 WAL 被轮换，W1 返回；
3. 调用 `Flush()` 并成功返回（覆盖调用前已确认的批次）；
4. 正常 `Close()` 的 C4 返回。

没有时间上界。

### 2.3 可见性（INV-7）

- **INV-7**：同步档（AP-1 / AP-2）的批次，只在它的 fsync 成功之后才应用到内存表、变为可见；fsync 失败的组**在本进程内**永不可见（重开后可能出现，见 §2.4）。
- NoSync 批次写进内核后就应用并可见，因为它本来就不承诺持久。
- 这是相对 Pebble 的有意偏离。CairnKV 采用 LevelDB 的串行顺序：写日志 → 同步 → 应用内存表 → 发布（`leveldb/db/db_impl.cc:1236-1257`）。

### 2.4 错误与批次结局（INV-8）

| 错误 | 判定时刻 | 批次结局 |
|---|---|---|
| `ErrInvalidOptions` / `ErrKeyTooLarge` / `ErrBatchTooLarge` | 入口（L1） | 绝不生效 |
| `ErrClosed` | 入队或组建时（L2 / L3） | 绝不生效 |
| `ErrWriteStall`（`OnStall = StallReturnError`） | 入队时或停写判定时（L2 / L5），都在写 WAL 之前 | 绝不生效 |
| `ErrCorruption`（停写因合并遇到损坏而无法解除，ST-4） | 停写判定时（L5） | 绝不生效 |
| `ErrSequenceExhausted` | 分配序号时（L7） | 绝不生效 |
| `ErrEnginePoisoned` | 任意时刻 | **结局未知**：重开后可能出现，也可能不出现，但重开后的状态满足 PC-1 |

**INV-8**：除 `ErrEnginePoisoned` 外，写入 API 的所有错误都在该批次的 WAL 字节写出之前判定。一旦开始写 WAL，结局只有成功或毒化两种。

### 2.5 空批次与大小上限

- **空批次**：`Apply` 直接返回 nil，不分配序号，不写 WAL。
- **内存表占用估算**（SC-53）：`footprint(batch) = Σ (len(key) + len(value) + EntryOverhead)`，其中 `EntryOverhead = 128` 字节。
  - 内存表实现必须保证：每个条目的实际 arena 占用 ≤ `len(key) + len(value) + EntryOverhead`（M1 用断言覆盖）。
  - 128 字节足以覆盖 8 字节 trailer、节点头和 20 层塔（20 × 4 字节偏移）。
- **上限**：
  - 键 > 64 KiB ⇒ `ErrKeyTooLarge`；
  - `footprint > MemTableSize / 2` ⇒ `ErrBatchTooLarge`；
  - 在默认 4 MiB 配置下，批次上限约为 2 MiB 减去每条 128 字节。
- **Open 校验**：`64 KiB ≤ MemTableSize ≤ 1 GiB`、`MemTableCountLimit ≥ 2`，否则 `ErrInvalidOptions`。

---

## 3. 提交管线（组提交）

采用 LevelDB 的 leader 模型：写入者排成 FIFO 队列，队首当 leader，代表一组完成全部步骤。内存表由提交管线串行化写入（单写者）。

### 3.1 流程（L1–L11）

```text
写入者 W 调用 Apply(b, o)：
L1  入口检查（不持锁）：选项越界 → ErrInvalidOptions；键过长 → ErrKeyTooLarge；
    footprint 超限 → ErrBatchTooLarge；空批次 → 返回 nil
L2  持 queueMu：
      已关闭 → ErrClosed；已毒化 → ErrEnginePoisoned；
      当前处于停写且 W 为 StallReturnError → ErrWriteStall；
      否则入队。之后 W 要么成为 leader，要么被某个 leader 带着完成
L3  leader 持 queueMu 重查：已关闭 → 本组全部 ErrClosed；已毒化 → 本组全部 ErrEnginePoisoned；
    然后按 §3.2 组建本组
L4  确定目标内存表：本组 footprint ≤ 当前 active 内存表的剩余容量时，用当前表；
    否则需要轮换，目标是一张新表。§3.2 已保证本组 footprint ≤ MemTableSize
L5  停写判定（§3.3）：停写期间，本组中 StallReturnError 的成员出组，收到 ErrWriteStall；
    其余成员等待。被唤醒后回到 L3 重查
L6  需要轮换时执行 W1–W4（§5.2）；在目标内存表上为本组预留空间（INV-3），并取得 writerRef（INV-2）
L7  分配序号：base = allocSeq + 1，allocSeq += 本组操作总数；
    越界 → 本组全部 ErrSequenceExhausted（尚未写 WAL，满足 INV-8）
L8  把每个批次编码成一条 WAL 逻辑记录，追加到写缓冲，并 write() 进内核（未满的块也写出）。
    失败 → 毒化（PS-2），本组收到 ErrEnginePoisoned，转 L11，不应用
L9  本组要求同步时 fsync WAL（INV-1：先写出缓冲，再 fsync）；成功后更新 syncedOffset（§5.3）。
    失败 → 毒化（PS-1），本组收到 ErrEnginePoisoned，转 L11，不应用
L10 按序号把本组批次应用到内存表，然后 visibleSeq = 本组最大序号（INV-7）
L11 归还 writerRef，失败路径也归还；发出组提交事件（§3.4）；
    用同一个结果唤醒本组所有写入者；把队首交给下一个等待者
```

- **INV-1**：`Sync()` 必须先写出未满的块，再 fsync。
- **INV-2**：writerRef 在 L6 取得、在 L11 归还，即取得发生在写 WAL 之前。内存表只有在 `writerRefs == 0` 时才能刷盘。轮换只发生在 leader 的 L6，或者 `Flush()` 的特殊写入者（§3.5）中，因此这个不变量由结构保证，writerRef 保留下来作断言用。
- **INV-3**：预留（L6）先于写 WAL（L8）。由于 L4 和 §3.2 的保证，预留不会失败；万一失败属于断言失败（实现 bug）。

### 3.2 组建规则（INV-4）

- 组长是队首；组的同步需求等于组长的同步需求。
- 组长总是被包含。依次考察后续等待者，遇到下列任一情况就停止，该等待者成为下一组的组长：
  1. 组长或该等待者是 SyncAlways（SyncAlways 只能独占一组）；
  2. **INV-4**：该等待者要求同步，而组长是 NoSync。同步需求只能保留或加强，不能被稀释（`leveldb/db/db_impl.cc:1303-1306`）。反方向允许：NoSync 写入者可以并入要求同步的组；
  3. 加入后本组的 WAL 编码字节超过上限：组长批次 ≤ 128 KiB 时，上限为组长批次大小 + 128 KiB；否则为 1 MiB（`leveldb/db/db_impl.cc:1288-1296`）；
  4. 加入后本组 footprint 超过目标内存表的容量。目标是新表时，容量取 `MemTableSize`；
  5. 该等待者是 `Flush()` 的特殊写入者（它总是单独成组）。

### 3.3 停写与背压

| 编号 | 条件 | 行为 |
|---|---|---|
| ST-1 | 本组需要轮换，且 immutable 内存表已有 `MemTableCountLimit − 1` 个 | 停写，直到有刷盘提交 |
| ST-2 | L0 文件数 ≥ `L0StopWritesThreshold`（12） | 停写，直到 L0 文件数降到阈值以下 |
| ST-3 | L0 文件数 ≥ `L0SlowdownWritesTrigger`（8） | 每组延迟 1 ms，不算停写 |
| ST-4 | ST-2 成立，并且合并调度器报告「L0 合并因 `ErrCorruption` 无法推进」 | 停写解除：等待中的和之后的写入都返回该 `ErrCorruption`（不毒化，读照常），直到重开 |

- 停写期间：`StallBlock`（默认）一直等待，直到停写解除、Close（返回 `ErrClosed`）、毒化（返回 `ErrEnginePoisoned`）或 ST-4 发生；`StallReturnError` 立即返回 `ErrWriteStall`。
- 「当前处于停写」是一个由 leader 设置、在 queueMu 下读取的标志，供 L2 使用。
- 计数：`WriteStallCount`、`WriteStallNanos`。

### 3.4 组提交事件

```go
// CommitGroupInfo 描述一次组提交（实验级 API，经 Options.EventListener.CommitGroup 回调）。
type CommitGroupInfo struct {
	FirstSeq, LastSeq uint64        // 本组占用的序号闭区间；未分配序号时两者为 0
	Batches           int           // 批次数
	WALBytes          int           // 本组写入 WAL 的逻辑记录字节数
	Synced            bool          // 是否执行了 fsync
	SyncDuration      time.Duration // fsync 耗时
	Err               error         // nil 或导致失败的错误
}
```

- 回调在 L11、唤醒写入者**之前**同步调用。回调必须很快返回，并且不得调用 DB 的方法。
- `EventListener` 另有 `Poisoned(error)` 和 `Warning(WarningInfo)` 两个回调。

### 3.5 `Flush()`

- `Flush()` 以「不带数据的特殊写入者」身份进入同一个 FIFO 队列（同 LevelDB 的 `Write(nullptr)`，`leveldb/db/db_impl.cc:1222-1225`）。
- 轮到它时，如果 active 内存表非空，就执行 W1–W4 轮换（同样受 ST-1 约束）。
- 之后它等待这张表的刷盘到达提交点（F6），或者出错，再返回。

---

## 4. 序号、快照与可见性

### 4.1 三个序号（闭区间约定）

| 量 | 含义 | 新库初值 |
|---|---|---|
| `allocSeq` | 已分配的最大序号 | 9 |
| `visibleSeq` | 已可见的最大序号：所有 `seq ≤ visibleSeq` 的批次都已应用 | 9 |
| `LastSequence` | MANIFEST 字段：追加那条 edit 时的 `visibleSeq` | 9 |

**INV-9**：

- 任何时刻：最新的 `LastSequence` ≤ `visibleSeq` ≤ `allocSeq`。
- 恢复后：`allocSeq = max(9, LastSequence, 重放出的最后一个批次的 base + count − 1)`，且 `visibleSeq = allocSeq`。
- 相继重放的批次必须满足 `base₍ᵢ₊₁₎ = baseᵢ + countᵢ`，否则 `ErrCorruption`。
- 断言：恢复后分配的第一个序号，严格大于任何已重放记录的序号（V-08）。

### 4.2 例子

1. 新库：`allocSeq = visibleSeq = 9`。
2. 批次 A（SyncGroupCommit，3 个操作）占用 10–12；fsync 成功后应用，`visibleSeq = 12`。
3. 批次 B（NoSync，2 个操作）占用 13–14；写进内核后应用，`visibleSeq = 14`。
4. 系统崩溃，B 的字节没有落盘。
5. 重启：重放出 A；MANIFEST 中 `LastSequence = 9`；得到 `allocSeq = 12`，下一个批次从 13 开始。
   - 复用 13、14 是安全的：B 已经不存在于任何地方。
   - 假如 B 曾被刷进登记过的 SSTable，那它此前一定已经过 W1，已经持久，会被重放或者已在登记的 SSTable 中；那样 `allocSeq ≥ 14`，不会复用。
6. 如果崩溃前已有 edit 把 `LastSequence = 14` 写进 MANIFEST，则 `allocSeq = 14`，序号 13、14 空着，无害。

### 4.3 快照与读

- `NewSnapshot()` 持 snapMu 读取 `S = visibleSeq` 并登记。不带快照的读和迭代器在开始时取 `S = visibleSeq`。
- 读只看 `seq ≤ S` 的条目。点查以 `user_key ‖ trailer(S, 255)` 为查找目标，遇到的第一个同键条目就是可见版本：如果是 Delete，就返回 `ErrNotFound` 并停止。
- 快照用 `Snapshot.Close()` 释放。未关闭的快照会阻止回收它之下的旧版本（用户契约）。

### 4.4 合并的版本保留水位

- 合并开始时**持 snapMu** 计算 `watermark`：
  - 有活跃快照时，取其中最小的 `S`；
  - 没有时，取此刻的 `visibleSeq`。
- 之后新建的快照，其 S ≥ 这个 watermark（`visibleSeq` 单调不减），所以不会被这次合并伤害。
- 同一用户键的版本按内部顺序（trailer 降序）遍历，规则 A：`lastKept ≤ watermark` ⇒ 丢弃。
- 墓碑的物理丢弃还要满足 AS-5（D02 §10.3），归 M3。

### 4.5 序号耗尽

- 分配后 `allocSeq` 会超过 `2^56 − 2` 时，整组返回 `ErrSequenceExhausted`，不回绕。
- 超过 `0.9 × 2^56` 时发一次 `Warning`。
- 读和 `Close` 不受影响。

---

## 5. 内存表与 WAL 的生命周期

### 5.1 一表一 WAL 与状态机

- 每个内存表对应一个 WAL。
- 状态：`active → immutable → flushing → flushed → freed`。
  - W4 时：active → immutable。
  - 刷盘协程取走时：immutable → flushing，并断言 `writerRefs == 0`。
  - F6 提交并安装新版本后：flushing → flushed。
  - `readerRefs == 0` 时：flushed → freed。
- 刷盘因非毒化原因失败（PS-3）时，表回到 immutable，退避后重试。
- `Close` 时全部释放。
- **刷盘只有一个协程**，最老的表最先刷、最先提交（Pebble 同样只允许一个刷盘，`pebble/compaction.go:1376-1388`）。

### 5.2 WAL 轮换（W1–W4，INV-6）

```text
W1 旧 WAL：写出用户态缓冲并 fsync（INV-6）；失败 ⇒ 毒化（PS-1）
W2 从计数器分配文件号，创建新 WAL，写入 48 字节文件头
W3 目录 fsync（D5）
W4 持 versionMu：新内存表成为 active，旧表变为 immutable 并入刷盘队列；更新 readState
```

**INV-6**：WAL 轮换前，旧 WAL 必须先写出缓冲再 fsync 完成。因此运行期只有最后一个 WAL 可能有崩溃残尾，打开时的情形见 R11。

### 5.3 syncedOffset

- 每个打开的 WAL / MANIFEST 维护 `syncedOffset`：已确认持久的文件长度，新文件为 0。
- 每次 fsync 成功后，把它设为这次 fsync 之前已 `write()` 的文件长度。
- 每个 chunk 头的 `syncOffset` 字段，填写该 chunk 写出时的 `syncedOffset`。

### 5.4 BytesPerSync

- 只用于 **SSTable** 写入：每写出 `BytesPerSync`（默认 512 KiB）字节调用一次 `SyncTo`。WAL 和 MANIFEST 不用它。
- 它只是性能优化，不是确认点；但它返回的错误同样毒化（PS-1）。

---

## 6. 元数据提交

### 6.1 两类提交点与 MANIFEST 串行化

| 编号 | 提交点 | 用于 |
|---|---|---|
| **CP-1** | 一条 VersionEdit 追加到当前 MANIFEST，且 fsync 成功 | 刷盘、合并 |
| **CP-2** | 新标记文件创建后，目录 fsync（S5）成功 | 切换到新 MANIFEST：Open（R10）与滚动 |

- **INV-10（MANIFEST 串行化）**：所有 VersionEdit 的追加和 MANIFEST 切换都在 `manifestMu` 下串行执行，持锁范围是「填写三项计数 → 追加 → fsync → 安装新版本」，或者整个「P1 生成快照 → S6」。
- 三项计数**在持锁追加时现取**，不在构造 edit 时取：
  - LogNumber：刷盘时按 F5 计算；合并时取当前已提交的值。
  - NextFileNumber：取当前计数器。
  - LastSequence：取当前 `visibleSeq`。
- 依据：LevelDB `leveldb/db/version_set.cc:777-790`。这样相继 edit 的计数不会减小，切换时的快照也不会漏掉并发的 edit。
- CP-1 / CP-2 之前的失败不改变恢复结果。运行期这两条路径上的任何 I/O 失败一律毒化。

### 6.2 切换 MANIFEST（P1–P4、S1–S6）

```text
持 manifestMu：
P1 创建 MANIFEST-<新>，写入文件头与快照记录（全部活文件、比较器名、dbID、三项计数）
P2 fsync 新 MANIFEST
P3 （调用方保证）快照中登记的全部 SSTable 都已 fsync，目录项已持久（D3）
P4 目录 fsync（D1）
S1 iter = 当前迭代号 + 1（失败后不复用）
S2 创建空文件 marker.manifest.<iter>.MANIFEST-<新>
S3 fsync 该标记文件
S5 目录 fsync（D2）—— 提交点 CP-2
S6 内存中切换到新 MANIFEST
S4 删除旧标记和旧 MANIFEST；删除失败只记录，下次打开时 R12 再清理（不需要持久）
```

- 编号保留了旧版的 S4，但它现在排在 S5、S6 **之后**。
- 依据（SC-47）：按 §1.2，未同步的目录操作可以只生效一部分。如果在 S5 之前删除旧标记，崩溃后可能一个标记都不剩。旧标记残留则无害：R3 只取迭代号最大的那个。
- P1、P2、P4、S2、S3、S5 任一失败：在 Open 期间，Open 返回该错误；在运行期，毒化。
- 不变量：
  - **MI-1**：迭代号最大的 manifest 标记所指的 MANIFEST 必须存在。
  - **MI-2**：一个 MANIFEST 中登记的 SSTable，只有在标记指向这个 MANIFEST 之后才有效。
  - **MI-3**：只有在新 MANIFEST 完全持久（P1–P4）之后，才切换标记。
  - **MI-4**：Open 结束时，目录中的 CairnKV 文件要么已登记，要么是 LOCK，要么是孤儿（R12）。

### 6.3 刷盘（F1–F8）

```text
F1 唯一的刷盘协程取出最老的 immutable 内存表 m（→ flushing）
F2 分配文件号，以最终文件名写出 SSTable（不经过 .tmp）
F3 fsync 该 SSTable
F4 目录 fsync（D3）
F5 持 manifestMu 构造 edit：NewFile(L0) + 三项计数。
   LogNumber = 刷盘队列中除 m 之外最老的那个表的 WAL 编号；队列中没有其他表时，取 active 表的 WAL 编号。
   这个值与 W4 都在 versionMu 下读写
F6 追加并 fsync MANIFEST —— CP-1；随后安装新版本：readState 加入新 SSTable、移出 m；m → flushed
F7 MANIFEST ≥ MaxManifestFileSize（128 MB）时按 §6.2 切换（仍持 manifestMu）
F8 释放 manifestMu；删除编号 < LogNumber 的 WAL（§6.5）
```

### 6.4 合并（K1–K6）

```text
K1 以最终文件名写出全部输出 SSTable，逐个 fsync
K2 目录 fsync（D3）
K3 持 manifestMu 构造 edit：全部 DeletedFile + 全部 NewFile（平移见 file-format §3.1）+ 三项计数
K4 追加并 fsync MANIFEST —— CP-1；安装新版本
K5 释放 manifestMu；被替换的 SSTable 等到不再被任何版本引用后再删除（§6.5）
K6 取消：K4 之前随时可以取消，已写出的输出文件按引用规则删除；K4 之后不可取消
```

### 6.5 删除过期文件

| 文件 | 何时可删 |
|---|---|
| SSTable | 不在当前版本中，并且没有任何仍被持有的版本引用它 |
| WAL | 编号 < 已提交的 LogNumber |
| 旧 MANIFEST、旧标记 | S4 |

- 运行期**只按引用和编号**删除具体的文件，绝不扫描目录。目录扫描只在 R12 做，否则可能误删正在写的输出。
- 删除一批文件后做一次目录 fsync（D4）。D4 不是正确性所必需：被删文件在崩溃后重新出现，下次打开时会被 R12 清理。
- 删除失败只记录并发 `Warning`，不毒化。

---

## 7. 目录 fsync 清单（D0–D6）

| 编号 | 时机 | 正确性必需 |
|---|---|---|
| **D0** | N1 新建数据目录（以及任何被新建的祖先目录）之后：从新目录开始逐级 fsync 父目录，直到最近一个原本就存在的祖先（`pebble/checkpoint.go:89-125`） | 是 |
| **D1** | 新 MANIFEST 写完并 fsync 之后、创建标记之前（P4） | 是 |
| **D2** | 新标记创建之后（S5，即 CP-2） | 是 |
| **D3** | 新 SSTable fsync 之后、追加它的 VersionEdit 之前（F4、K2） | 是 |
| **D4** | 删除一批过期文件之后 | 否 |
| **D5** | 新 WAL 创建之后、它承载第一个确认之前（W3、N6、R11） | 是 |
| **D6** | 正常 `Close` 时兜底 | 否 |

- 目录 fsync 的实现：
  - Linux：以 `O_RDONLY` 打开目录后调用 `fsync`。
  - darwin：调用 `F_FULLFSYNC`，不支持时回退到 `fsync`（V-10）。
- `OpenDir` 失败，等同于目录 `Sync` 失败。

---

## 8. 打开与恢复

### 8.1 新库创建（N1–N8）

```text
N1 MkdirAll；对新建的目录执行 D0；取得 LOCK（flock，非阻塞）
N2 按 R2–R3 确认这是新库或未完成的初始化
N3 生成 16 字节随机 dbID
N4 创建 MANIFEST-000001：文件头 + 快照（比较器名、dbID、LogNumber = 2、NextFileNumber = 3、LastSequence = 9、无文件），fsync
N5 创建 000002.wal，写入文件头
N6 目录 fsync（同时满足 D1、D5）
N7 format-version 标记：S1–S3、S5，值为 1
N8 manifest 标记：S1–S3、S5，值为 MANIFEST-000001 —— 从此是已初始化的库
```

N8 完成后 Open 直接返回：空库，无需重放。N8 之前崩溃不会丢失任何数据，因为 Open 返回之前不接受写入。

### 8.2 恢复（R1–R12）

```text
R1  取得 LOCK（flock，非阻塞）；失败 ⇒ Open 失败（同进程重复打开也会在这里失败）
R2  列目录，只看 CairnKV 文件名模式（file-format §6）；记下其中最大的文件号 M。
    先解析 marker.format-version 族：
      无法解析、或迭代号最大的出现并列 ⇒ ErrCorruption；
      值不在 [FormatMinSupported, FormatNewest] ⇒ ErrUnsupported（v1 两者都是 1）
R3  再解析其余 marker.*：
      名称不认识、无法解析、或迭代号最大的出现并列 ⇒ ErrCorruption。
    没有 manifest 标记时：
      存在任何 .sst，或任何 .wal 含有效记录 ⇒ ErrCorruption（元数据丢失）；
        这里的有效记录指：文件头有效（file-format §2.1），且至少有一条完整、无结构错误的记录
      否则视为未完成的初始化：删除这些模式文件（MANIFEST-*、*.wal、*.tmp、marker.format-version.*），按 §8.1 新建
    有 manifest 标记但没有 format-version 标记 ⇒ ErrCorruption
R4  （已并入 R2）
R5  读取标记所指的 MANIFEST：
      文件不存在 ⇒ ErrCorruption（MI-1）；
      按 §8.4 读取并应用；比较器名 ≠ Options.Comparer.Name() ⇒ ErrInvalidOptions；
      dbID 必须与文件头一致。记下 MANIFEST 是否有残尾
R6  对每个登记的 SSTable：必须存在，大小 = NewFile.size；打开 footer、metaindex、属性块并校验；不扫描数据块
R7  文件号计数器 = max(NextFileNumber, M + 1)（`leveldb/db/db_impl.cc:372-375`）
R8  WAL 选择：存在编号 > LogNumber 的 WAL、但 WAL(LogNumber) 不存在 ⇒ ErrCorruption。
    按编号升序重放所有编号 ≥ LogNumber 的 WAL（§8.3），得到批次序列；按 INV-9 检查连续性并计算 allocSeq
R9  把重放出的批次写入内存表，写满就写出 L0 SSTable（同 F2–F4，文件号取自计数器）。
    某条记录的 footprint 超过 MemTableSize（重开前调小了配置）时，为它单独开一张容量恰好够用的表，并立即写出
R10 为新 WAL 预留编号 N（从计数器分配，但暂不创建文件）。按 §6.2 切换到新 MANIFEST，快照内容为：
    全部活文件（含 R9 的输出）、LogNumber = N、NextFileNumber = 计数器当前值（> N）、LastSequence = allocSeq —— CP-2
R11 创建 N.wal 并写入文件头；目录 fsync（D5）
R12 清理（只针对 CairnKV 文件名模式）：删除编号 < N 的 .wal、非当前的 MANIFEST-*、非最大迭代号的标记、*.tmp。
    对未登记的 .sst：
      若 R5 发现 MANIFEST 有残尾，并且该文件编号 ≥ 最后一条已应用 edit 的 NextFileNumber，
        则改名为 <编号>.sst.orphan 隔离（不删除，发 Warning）；
      否则删除。
    然后 visibleSeq = allocSeq，Open 返回
```

- **为什么先提交、后建 WAL**（SC-45）：
  - R10 的 CP-2 之前崩溃：旧标记仍然有效，目录里也没有新 WAL，带残尾的旧 WAL 仍是最后一个。下次打开重复同样的过程，R9 的输出在 R12 被清理。
  - CP-2 之后、R11 之前崩溃：LogNumber = N，N.wal 不存在，也没有编号更大的 WAL，所以没有可重放的内容，旧 WAL 在 R12 被删除。
  - Pebble 的顺序相同（`pebble/open.go:448-463`）。
- R7 把计数器推到目录中已有的最大编号之后，杜绝同号文件：包括那些编号已分配、但还没写进 MANIFEST 的 WAL 和 SSTable。
- R8 的「WAL(LogNumber) 必须存在」在崩溃状态下不会误报：
  - WAL 在被任何 edit 引用之前，已完成 W2/W3 或 R11；
  - 只有在把 LogNumber 推过它的那条 edit 持久之后，它才会被删除。
  - 这条检查能抓住 MANIFEST 版本静默回退的一类损坏（SC-50）。
- 孤儿文件不会被引擎自动删除，`cairnkv check` 会列出它们。崩溃（而非损坏）产生的孤儿只会出现在「刷盘 edit 被撕裂」这种罕见情形，所以占用的空间有界。

### 8.3 WAL / MANIFEST 的残尾判定（I-1）

对每个文件，chunk 校验所需的 base 由 MANIFEST 的 dbID 和文件名中的编号派生。

```text
1. 文件头（file-format §2.1）：无效 ⇒ X = 0，转第 3 步；ErrUnsupported / ErrCorruption 照章返回
2. 按 file-format §2.2 顺序解析，遇到第一个无效位置或结构错误为止：
   - 结构错误（CRC 正确但违反约束）⇒ ErrCorruption；
   - 无效位置 p：X = p 所在那条不完整记录的第一个 chunk 的偏移；若 p 不在任何记录之中，X = p
3. 存在 X 时：
   a. 这个 WAL 不是最后一个（运行期由 INV-6 保证；打开时由 R10/R11 的顺序保证）⇒ ErrCorruption
   b. 作证扫描：从 X + 1 开始**逐字节**扫描到文件尾，包括 X 所在块的剩余部分。候选 chunk 必须同时满足：
        头部完整，且不越过块尾；type ∈ 1–4；length ≥ 1；logNum 匹配；syncOffset ≤ 自身偏移；
        ctxChecksum 正确（校验和绑定了位置，用户数据里的伪造字节和陈旧数据都过不了）。
      只要有一个候选的 syncOffset > X ⇒ ErrCorruption（已同步的区域被损坏）
   c. 否则 X 之后都是崩溃残尾：丢弃，计入 WALTornTailBytes，并发 Warning
4. 每条完整记录按 file-format §2.3（WAL）或 §3.1（MANIFEST）解析；任何错误 ⇒ ErrCorruption，不论位置
```

- **为什么不会误报（PC-3）**：
  - 崩溃只破坏未同步的区域。chunk 的 syncOffset = s，意味着写出它时 [0, s) 已经持久；
  - 而 s 总落在组或记录的边界上，所以崩溃状态下任何真实 chunk 都满足 s ≤ X。
  - v1 每个位置只写一次，校验和又绑定了位置，陈旧数据不会通过作证条件。
- **能检出什么**：一次 fsync 覆盖了 X 之后，只要之后又写出过任意一个 chunk（**包括同一块中的**），这处损坏就能被检出。
- **剩余风险**见 §12 局限 1。
- 扫描是逐字节进行的，代价只在发现残尾时才付出，量级与文件长度成正比。

### 8.4 MANIFEST 读取

- chunk 层面与 §8.3 相同。当前 MANIFEST 视为「最后一个文件」：残尾是没有到达 CP-1 的 edit，丢弃它是正确的。
- edit 层面的错误（file-format §3.1）⇒ `ErrCorruption`。
- 一条有效 edit 都没有 ⇒ `ErrCorruption`。

### 8.5 Open 失败

- Open 返回错误时，关闭已打开的文件并释放 LOCK。
- 已创建的文件保留在原处，下次 Open 时由 R3 或 R12 处理。

---

## 9. 毒化

**INV-5**：同步或写入失败后，引擎进入毒化状态，此后不再把任何未持久化的写入报告为成功。

状态：运行 → 毒化 → 已关闭。毒化只存在于进程内，不写盘。

**触发**：

| 编号 | 触发条件 |
|---|---|
| **PS-1** | 任何同步类调用（`Sync`、`SyncData`、`SyncTo`、目录 `Sync`、`OpenDir`）返回错误，不论作用于 WAL、MANIFEST、SSTable、标记文件还是目录（SC-48） |
| **PS-2** | WAL、MANIFEST、标记文件的 `write()`、`Create` 或 `Close` 失败；**已登记** SSTable 写出后的 `Close` 失败 |

**不触发**：

| 编号 | 情形 | 处理 |
|---|---|---|
| **PS-3** | 尚未登记的 SSTable 在 `write()`、`Create` 或 `Close` 时失败（例如磁盘满） | 任务作废，删除文件，发事件，退避后重试 |
| **PS-4** | 删除过期文件失败 | 只记录 |
| **PS-5** | 读到 `ErrCorruption` 或 EIO | 返回给调用者；后台任务停止调度涉及该文件的工作，并发事件。若因此导致停写，见 ST-4 |

**效果**：

| 编号 | 效果 |
|---|---|
| E1 | 所有 API（含读、迭代器、快照）返回 `ErrEnginePoisoned`。它包装原始错误，`errors.Is` 对两者都成立 |
| E2 | 进行中的组：写入者全部收到 `ErrEnginePoisoned`，该组不应用；之后的 leader 在 L3 重查毒化，不再写入 WAL |
| E3 | 后台协程不再开始新任务；运行中的任务在下一次 I/O 时中止 |
| E4 | `Poisoned` 事件只发一次 |
| E5 | `Close`：不刷盘、不同步，只关闭文件并释放 LOCK；返回 `ErrEnginePoisoned` |
| E6 | 重新打开时走正常恢复；同一进程在 `Close` 之后可以重开 |

---

## 10. 关闭（C1–C6）

```text
C1 持 queueMu 标记为已关闭：之后的入队、组建、API 调用返回 ErrClosed；再次 Close 也返回 ErrClosed
C2 等待当前组完成 L11；队列中尚未开始写 WAL 的写入者（含停写中的）收到 ErrClosed
C3 取消后台任务（context），等待所有后台协程退出；未提交的输出文件按 §6.5 删除，失败的留给 R12
C4 未毒化时：写出 WAL 缓冲并 fsync 活跃 WAL —— 此后所有已确认的写入（含 NoSync）都已持久
C5 未毒化时：目录 fsync（D6）
C6 关闭所有文件；用户仍持有的迭代器、快照，之后调用返回 ErrClosed；最后释放 LOCK
```

- 返回值：正常 ⇒ nil；已毒化 ⇒ `ErrEnginePoisoned`。
- Close 不刷内存表；数据在下次打开时由 WAL 重放恢复。

---

## 11. 前缀一致性与崩溃检查器（I-4）

### 11.1 正确性定义

- 记 `B₁, B₂, …, Bₙ` 为**上一次成功 Open 之后**开始写 WAL 的批次，按序号排列。
- 记 `S₀` 为上一次成功 Open 返回时库的内容。
- 记 `K` 为「已承诺持久」的最后一个批次的下标。已承诺持久的批次包括两类：
  - 按 AP-1 或 AP-2 确认过的；
  - 被 §2.2 中已经发生的事件覆盖的。这些事件分别以 L9 返回、W1 返回、`Flush()` 返回、C4 返回为准。

| 编号 | 断言 |
|---|---|
| **PC-1** | 系统崩溃或进程崩溃后，若 Open 成功，库的内容等于 `S₀ ⊕ B₁ … Bₖ`，其中 `K ≤ k ≤ n` |
| **PC-2** | 收到非毒化错误的批次绝不出现 |
| **PC-3** | 对崩溃产生的任何状态（vfs 没有注入错误时），**Open 必须成功**。这一条比「不返回 `ErrCorruption`」更强 |
| **PC-4** | 未毒化运行中发生进程崩溃后，`k` 不小于任一档位下最后一个已确认批次的下标（含 NoSync） |

### 11.2 检查器

- 内存 vfs 记录完整的操作轨迹，并为父目录建模（D0）。
- 崩溃点设在每个 `Sync` / `SyncData` / `SyncTo` / 目录 `Sync` / `Create` / `Remove` / `Rename` 之前，**包括 Open 自身执行的这些操作**。也就是说，检查器会在恢复过程中再次崩溃（嵌套崩溃）。
- 每个崩溃点按 §1.2、§1.3 构造五类状态：
  1. 只保留已同步的数据；
  2. 保留全部数据；
  3. 未同步的页随机取值；
  4. 未同步的目录操作随机生效一部分；
  5. 进程崩溃状态。
- 对每个状态执行 Open，用有序模型找出满足 PC-1 的 `k`，并检查 PC-2 到 PC-4。
- 规模约束：
  - 不超过约 200 次 vfs 操作的工作负载，穷举崩溃点；第 3、4 类状态用固定种子采样。
  - 嵌套崩溃深度限制为 2。
  - 更大的工作负载交给随机 `CrashClone`。

---

## 12. 平台声明与已知局限

| 档位 | 文件系统 | 处理 |
|---|---|---|
| 保证 | Linux ext4 / xfs（`just test-linux-fs` 覆盖）、macOS APFS | 承诺持久性 |
| 未验证 | btrfs、zfs 等其他本地文件系统 | 不警告，也不承诺 |
| 不保证 | tmpfs、overlayfs、NFS | Open 时发 `Warning`，照常打开 |

Windows 第一期不支持（目录同步只能是空操作，`badger/dir_windows.go:100`）。

**已知局限**：

1. **I-1 的剩余风险**：一次 fsync 覆盖了位置 X，此后**再没写出过任何 chunk**，那么 X 处的损坏无法与崩溃残尾区分，会被当作残尾丢弃。
   - WAL：损失的是最后一次 fsync 之后无人作证的那部分。
   - MANIFEST：由于库空闲时 MANIFEST 不再写入，最后一条已提交的 edit 一旦损坏会被当作残尾。R8 的 WAL 存在性检查能抓住其中「LogNumber 回退」的情形；其余情形下，R12 会把相关 SSTable 隔离为孤儿而不是删除。
   - Pebble 的作证扫描只看后续块，局限比这里大。
2. 32 位 CRC 每次比对有 2⁻³² 的漏检概率。
3. NoSync 的丢失窗口没有时间上界。
4. 在延迟分配的文件系统上，磁盘满可能到 fsync 时才报出，导致毒化。
5. 虚拟化环境中 fsync 可能达不到物理落盘（本机 OrbStack 的实测见 spec-closure §2.2）。
6. NoSync 写入可见先于持久；同步写入不会（INV-7）。

---

## 13. M1 过渡实现（T1–T6，SC-56）

M1 没有 SSTable、MANIFEST 和标记文件，完整的 N / R 协议要到 M2 才能实现。M1 先按下面的过渡规则实现。M2 **不兼容** M1 的数据目录：按 R3，它会因为存在含有效记录的 WAL 而拒绝打开。

```text
T1 目录中只有 LOCK 与 *.wal。Open 时取 LOCK，D0 照做
T2 dbID：取第一个文件头有效的 WAL 中的 dbID，各 WAL 的 dbID 必须一致，否则 ErrCorruption。
   没有有效 WAL 时：若唯一的 WAL 文件头无效且判为残尾，删除它；然后生成新 dbID，创建 000002.wal 并 D5
T3 按编号升序重放全部 WAL（§8.3），allocSeq = max(9, 重放出的最后序号)，连续性检查照做；
   重放结果全部进入内存表。M1 不执行内存上限
T4 最后一个 WAL 有残尾时：Truncate 到 X、Sync、目录 fsync，使它成为干净的非最后 WAL，以满足 INV-6
T5 创建新 WAL（W2、W3）后 Open 返回；文件号 = 目录中最大编号 + 1
T6 WAL 轮换照 W1–W4 执行，但 immutable 表永不刷盘、WAL 永不删除；Flush() 只做轮换。
   ST-1 在 M1 中不生效
```

T4 只截掉已判定为残尾的部分（§8.3 第 3b 步没有找到作证 chunk），不会抹掉已同步区域的损坏证据。M2 改用 R10 / R11 的顺序后，不再需要截断。

---

## 14. 旧编号对照

| 旧编号 | 出处 | 本文 |
|---|---|---|
| R1 / R2 / R3（lane 摘要中的不变量） | `.autoresearch/work/block-B-digest.md` | INV-1 / INV-2 / INV-3 |
| INV-1 … INV-5 | D03 §0.1 | 同号（§3、§9） |
| INV-6 | spec-closure F-3 | 同号（§5.2） |
| iter-15 的 INV-1 … INV-4 | iter-15 | MI-1 … MI-4（§6.2） |
| iter-08 的 I1 / I2 / I3 | iter-08 | I1 → §5.1；I2 → §2.5（MemTableSize 上下限）；I3 → INV-3 |
| iter-15 的 R1 … R9 | iter-15 | §8.2 的 R1 … R12（重排：先提交后建 WAL、计数器推进、清理移到最后） |
| iter-15 的 D1 … D6 | iter-15 | §7 的 D0 … D6（新增 D0；D1 措辞按代码修正；D4、D6 降为非必需；D5 收紧） |
| iter-15 的 P1 … P4、S1 … S6 | iter-15 | §6.2（删除旧标记移到 S5 之后；失败一律毒化） |
| 第一版 durability.md 的 L1–L10、R1–R10 | 本文第一版 | 本版的 L1–L11、R1–R12 |
