# CairnKV 持久化与崩溃一致性规格（格式版本 1）

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-29 |
| 地位 | 规范性文档。与研究文档冲突时以本文为准；决策理由见 `docs/spec-closure.md`（SC-xx、I-x），字节布局见 `docs/file-format.md` |
| 守护 | 本文的每个编号（AP、INV、MI、CP、L、ST、W、F、K、P、S、D、N、R、PS、E、C、PC）都要在代码中恰好一处用 `// durability: <编号>` 标注，并至少被一个测试引用（I-5(b)） |

---

## 0. 术语

- **确认**：写入 API（`Set` / `Delete` / `Apply`）向调用者返回 `nil`。
- **持久**：系统崩溃（掉电、内核崩溃）之后仍然存在。
- **可见**：之后开始的读能看到。
- **确认点（AP）**：确认时刻必须已经成立的持久性条件。
- **提交点（CP）**：多步操作中，一旦完成、崩溃后的恢复结果就变成新状态的那一步。
- **进程崩溃 / 系统崩溃**：进程崩溃（`kill -9`、宿主程序 panic）不丢已 `write()` 进内核的数据；系统崩溃只保留已同步的数据。

---

## 1. 持久化模型

本节是全部推理和崩溃检查器（§11）的共同前提。实现只能依赖这里列出的保证。

### 1.1 同步原语（vfs，SC-04）

| 原语 | 成功返回后保证 |
|---|---|
| `File.Sync()` | 文件的全部数据与元数据（含大小）都已持久。darwin 上为 `F_FULLFSYNC` |
| `File.SyncData()` | 全部数据已持久，读回这些数据所需的元数据（大小）也已持久。Linux 为 `fdatasync`；其他平台等同 `Sync` |
| `File.SyncTo(n)` | **不提供任何保证**。只提示内核开始回写前 n 字节：Linux 上为 `sync_file_range`，其他平台为空操作。绝不能作为确认点或提交点 |
| `OpenDir(d)` + `Sync()` | 目录 d 中此前完成的创建、删除都已持久 |

v1 的持久化路径只用到「创建、删除、目录同步」，**不依赖 rename / link 的原子性**（SC-19；标记文件只做创建与删除）。

### 1.2 系统崩溃后的可能状态

- 已同步的字节保持不变。
- 未同步的字节以 4 KiB 页为单位各自取值：新内容、全零或任意垃圾。文件长度可以是「持久长度」到「可见长度」之间的任意值。
  - 页粒度只是崩溃检查器的枚举粒度。格式与恢复规则不依赖粒度：CRC 能检出任意位置的撕裂。
- 未同步的目录操作：可能任意子集生效，每个操作本身原子。
- 一个文件即使数据已 fsync，只要它的目录项没有同步，崩溃后也可能整个不见。

### 1.3 进程崩溃

传给 `write()` 的字节全部保留（页缓存还在），用户态缓冲中的字节丢失。

### 1.4 I/O 失败

- `Sync` / `SyncData` / 目录 `Sync` 返回错误后，对应文件或目录的持久内容未知。**之后再同步成功，也证明不了数据已持久**：Linux 在回写失败后可能把脏页标记为干净（Rebello et al., ATC 2020，`DOI:10.1145/3450338`）。处理见 PS-1。
- WAL、MANIFEST、标记文件的 `write()` / `Create` 失败后，可见内容未知。处理见 PS-2。

---

## 2. 写入的确认语义

### 2.1 同步档位与确认点（SC-24 / SC-25 / SC-26）

```go
// SyncMode 决定一次写入在确认前需要达到的持久性。
type SyncMode uint8

const (
	SyncDefault     SyncMode = iota // 零值：在 WriteOptions 中表示继承 Options.SyncMode；在 Options 中表示 SyncGroupCommit
	SyncGroupCommit                 // 默认档：与同组其他写入共享一次 fsync
	SyncAlways                      // 每个批次独占一组、单独一次 fsync
	NoSync                          // 不等待 fsync，须显式选择
)
```

| 编号 | 档位 | 确认时已成立 | 进程崩溃后 | 系统崩溃后 |
|---|---|---|---|---|
| **AP-1** | SyncGroupCommit | 包含该批次的那一次组提交 fsync 已成功返回 | 保留 | 保留 |
| **AP-2** | SyncAlways | 同 AP-1，且这次 fsync 所在的组只有这一个批次 | 保留 | 保留 |
| **AP-3** | NoSync | 该批次的 WAL 字节已 `write()` 进内核 | 保留 | 可能丢失，直到 §2.2 列出的某个时刻 |

- AP-1 与 AP-2 的持久性保证完全相同，区别只在性能。SyncAlways 用作「逐次同步 vs 分组同步」对照实验的基线。
- **覆盖规则**：`WriteOptions` 为 nil 或 `Sync == SyncDefault` 时，用 `Options.SyncMode`；否则以本次写入的取值为准，可以比默认档更强，也可以更弱，由调用者负责。取值不在枚举内 ⇒ `ErrInvalidOptions`。
- **命名约束**：NoSync 不是默认档；任何 `Options` 字段名不得含 `Durable` / `Safe` 一类字样（iter-06）。

### 2.2 NoSync 写入何时变为持久

满足以下任一条之后：

1. 同一个 WAL 上之后任意一次同步组提交完成（fsync 覆盖整个文件前缀）；
2. WAL 轮换（INV-6）；
3. `Flush()` 返回；
4. 正常 `Close()` 返回。

没有时间上界。iter-06 要求「丢失窗口 X 可配置」，这一条不采纳，因为第一期不做定时刷盘（SC-25）。

### 2.3 可见性（INV-7，SC-23）

- **INV-7**：同步档（AP-1 / AP-2）的批次只有在它的 fsync 成功之后，才会写入内存表、变为可见。fsync 失败的组永远不可见。
- 因此读者不会读到「随后因崩溃或 fsync 失败而消失」的同步写入。
- NoSync 批次写进内核后就应用、可见，因为它本来就不承诺持久。
- 这是相对 Pebble 的有意偏离：Pebble 允许内存表应用与 fsync 并行，可见先于持久。CairnKV 采用 LevelDB 的串行顺序：写日志 → 同步 → 应用内存表 → 发布（`leveldb/db/db_impl.cc:1236-1257`）。写入者自己的延迟不变，其他读者看到新数据要多等一次 fsync。

### 2.4 错误与批次结局（INV-8）

| 错误 | 判定时刻 | 批次结局 |
|---|---|---|
| `ErrClosed` / `ErrReadOnly` / `ErrInvalidOptions` | 入口 | 绝不生效 |
| `ErrKeyTooLarge` / `ErrBatchTooLarge` | 入口 | 绝不生效 |
| `ErrWriteStall`（`OnStall = StallReturnError`） | 进入组之前 | 绝不生效 |
| `ErrSequenceExhausted` | 分配序号时，写 WAL 之前 | 绝不生效 |
| `ErrEnginePoisoned` | 任意时刻 | **结局未知**：重开后可能出现，也可能不出现，但重开后的状态仍满足 PC-1 |

- **INV-8**：除 `ErrEnginePoisoned` 外，写入 API 的所有错误都在该批次的 WAL 字节写出之前判定。一旦开始写 WAL，结局只有两种：成功或毒化。

### 2.5 空批次与大小上限

- 空批次：`Apply` 直接返回 nil，不分配序号、不写 WAL、不等待 fsync（SC-30）。WAL 中出现 `count = 0` 的记录 ⇒ `ErrCorruption`。
- 大小上限（SC-09）：
  - 键 > 64 KiB ⇒ `ErrKeyTooLarge`；
  - 批次编码后 > `MemTableSize / 2` ⇒ `ErrBatchTooLarge`。默认配置下即 2 MiB。
  - `Open` 时校验 `MemTableSize ≤ 1 GiB`，否则 `ErrInvalidOptions`。

---

## 3. 提交管线（组提交，SC-22）

采用 LevelDB 的 leader 模型：写入者排成一个 FIFO 队列，队首的写入者当 leader，代表一组写入者完成整个流程。

- 研究文档给出的是 LevelDB 与 Pebble 两种实现的混合，没有自洽的算法。D03 M1-5 的「两信号量 + `commit.Add(2)`」是 Pebble 的部件，不采用。
- 内存表由提交管线串行化写入（单写者，D02 §3.4 的 L1）。

### 3.1 流程（L1–L10）

```text
写入者 W 调用 Apply(b, o)：
L1  入口检查（不持锁）：已关闭 → ErrClosed；已毒化 → ErrEnginePoisoned；只读 → ErrReadOnly；
    键过长 → ErrKeyTooLarge；批次过大 → ErrBatchTooLarge；空批次 → 返回 nil
L2  W 进入 FIFO 写队列。之后要么成为队首（当 leader），要么被某个 leader 带着完成
L3  leader 处理停写（§3.3）；StallReturnError 的等待者此时出队，收到 ErrWriteStall
L4  leader 按 §3.2 组建本组
L5  leader 为整组预留内存表空间（INV-3），并取得目标内存表的 writerRef（INV-2）；
    当前内存表放不下时，先做 WAL 轮换（§5.2）
L6  leader 分配序号：base = allocSeq + 1，allocSeq += 本组操作总数；
    越界 → 整组 ErrSequenceExhausted（此时尚未写 WAL，符合 INV-8）
L7  leader 把每个批次编码成一条 WAL 逻辑记录（file-format §2.3），追加到写缓冲，
    并 write() 进内核，未满的块也写出（AP-3 由此成立）
L8  本组要求同步时，leader fsync WAL（INV-1：先写出缓冲，再 fsync）；成功后更新 syncedOffset（§5.3）。
    失败 → 毒化（PS-1），整组收到 ErrEnginePoisoned，直接跳到 L10，不应用
L9  leader 按序号把本组批次应用到内存表，然后 visibleSeq = 本组最大序号（INV-7）；归还 writerRef
L10 leader 发出组提交事件（§3.4），用同一个结果唤醒组内所有写入者，把队首交给下一个等待者
```

- **INV-1**：`Sync()` 必须先写出未满的块，再 fsync。
- **INV-2**：在 L5（写 WAL 之前）取得 writerRef，L9 之后归还；内存表只有 `writerRefs == 0` 时才能刷盘。
  - 在 leader 模型下，这一条由结构保证：轮换只发生在 leader 的 L5，这时没有其他写入在进行中。
  - writerRef 仍保留，作为断言使用。
- **INV-3**：预留空间（L5）先于写 WAL（L7）。预留失败时整组失败，绝不出现「WAL 已写、内存表只应用了一半」。
  - 有了 SC-09 的批次上限，换成新内存表后一定放得下；放不下属于断言失败。

### 3.2 组建规则（INV-4）

- 组长是队首；组的同步需求等于组长的需求。
- leader 依次考察后面的等待者。遇到下列任一情况就停止，该等待者成为下一组的组长：
  1. 组长或该等待者是 SyncAlways（SyncAlways 只能独占一组）；
  2. **INV-4**：该等待者要求同步，而组长是 NoSync。持久性需求只能保留或加强，不能被稀释（`leveldb/db/db_impl.cc:1303-1306`）。反方向允许：NoSync 写入者可以并入要求同步的组；
  3. 加入后本组的批次编码总字节数超过上限。组长批次 ≤ 128 KiB 时，上限 = 组长批次大小 + 128 KiB；否则上限为 1 MiB（`leveldb/db/db_impl.cc:1288-1296`）。
- 组长的批次总是被包含，即使它单独就超过 1 MiB。

### 3.3 停写与背压

leader 在 L3 检查下列条件：

| 编号 | 条件 | 行为 |
|---|---|---|
| ST-1 | 需要轮换内存表，但未刷盘的内存表已达 `MemTableCountLimit − 1` 个 | 停写，直到有刷盘完成 |
| ST-2 | L0 文件数 ≥ `L0StopWritesThreshold`（12） | 停写，直到合并让 L0 文件数降到阈值以下 |
| ST-3 | L0 文件数 ≥ `L0SlowdownWritesTrigger`（8） | 每组延迟一次 1 ms，不算停写 |

- **停写时**：`StallBlock`（默认）一直等到条件解除，或者 Close（返回 `ErrClosed`）、毒化（返回 `ErrEnginePoisoned`）；`StallReturnError` 立即返回 `ErrWriteStall`。
- leader 自己是 `StallReturnError` 时，也会出队，由下一个等待者接任 leader。
- 计数指标：`WriteStallCount`、`WriteStallNanos`。

### 3.4 组提交事件（V-03）

```go
// CommitGroupInfo 描述一次组提交（实验级 API，经 Options.EventListener.CommitGroup 回调）。
type CommitGroupInfo struct {
	FirstSeq, LastSeq uint64        // 本组占用的序号闭区间
	Batches           int           // 批次数
	WALBytes          int           // 本组写入 WAL 的逻辑记录字节数
	Synced            bool          // 是否执行了 fsync
	SyncDuration      time.Duration // fsync 耗时；Synced 为 false 时为 0
	Err               error         // nil，或导致毒化的原始错误
}
```

- 回调在 L10、唤醒写入者**之前**同步调用。测试因此可以断言「先看到 fsync 完成，`Apply` 才返回」。
- 回调必须很快返回，并且不得调用 DB 的方法（否则会死锁）。
- `EventListener` 另有两个回调：`Poisoned(error)` 与 `Warning(WarningInfo)`。

---

## 4. 序号、快照与可见性（SC-27）

### 4.1 三个序号（闭区间约定）

| 量 | 含义 | 新库初值 |
|---|---|---|
| `allocSeq` | 已分配的最大序号 | 9 |
| `visibleSeq` | 已可见的最大序号：所有 `seq ≤ visibleSeq` 的批次都已应用 | 9 |
| `LastSequence` | MANIFEST 字段，写那条 edit 时的 `visibleSeq` | 9 |

- **INV-9**：
  - 任何时刻都满足：最新的 `LastSequence` ≤ `visibleSeq` ≤ `allocSeq`。
  - 恢复后：`allocSeq = max(9, LastSequence, 重放出的最后一个批次的 base + count − 1)`；`visibleSeq = allocSeq`。
  - 相继重放的批次必须满足 `base₍ᵢ₊₁₎ = baseᵢ + countᵢ`，否则 `ErrCorruption`（SC-28）。
  - 断言：恢复后分配的第一个序号严格大于任何已重放记录的序号（V-08）。

### 4.2 例子

1. 新库：`allocSeq = visibleSeq = 9`。
2. 批次 A（SyncGroupCommit，3 个操作）：占 10、11、12；fsync 成功后应用，`visibleSeq = 12`。
3. 批次 B（NoSync，2 个操作）：占 13、14；写进内核后应用，`visibleSeq = 14`。
4. 系统崩溃，B 的字节没有落盘。
5. 重启：重放得到 A（最后一个序号 12）；MANIFEST 的 `LastSequence = 9`；所以 `allocSeq = 12`。下一个批次从 13 开始。
   - 复用 B 的序号是安全的：B 已经不在任何地方。B 如果被刷进过 SSTable 或经历过 WAL 轮换，就一定已经持久、会被重放。
6. 如果崩溃前某条 edit 已把 `LastSequence = 14` 写进 MANIFEST，那么 `allocSeq = 14`，13、14 永远空着。序号出现空洞无害。

### 4.3 快照与读

- `NewSnapshot()` 记录 `S = visibleSeq`；不指定快照的读和迭代器在开始时取 `S = visibleSeq`。
- 读只看 `seq ≤ S` 的条目。点查以 `user_key ‖ trailer(S, 255)` 为查找目标（file-format §1）。
  - 遇到的第一个同键条目就是可见版本。它是 Delete 时返回 `ErrNotFound`，并且停止查找。
- 快照用 `Snapshot.Close()` 释放（SC-31，与 `Iterator.Close`、`DB.Close` 一致）。没有关闭的快照会阻止它之下的旧版本被回收，空间占用单调增长（用户契约）。

### 4.4 合并的版本保留水位

- `watermark` = 活跃快照的最小 `S`；没有活跃快照时，取**合并开始时的 `visibleSeq`**，不取 +∞，以免与合并期间新建的快照竞争（SC-31）。
- 同一用户键的版本按内部顺序（trailer 降序）遍历。规则 A：`lastKept ≤ watermark` ⇒ 丢弃。
- 墓碑的物理丢弃还必须满足 AS-5（条件 A ∧ 条件 B，D02 §10.3），细节归 M3。

### 4.5 序号耗尽

- 分配后 `allocSeq` 会超过 `2^56 − 2` 时，整组返回 `ErrSequenceExhausted`，**不回绕**。
- 超过 `0.9 × 2^56` 时发一次 `Warning` 事件。
- 读和 `Close` 不受影响。

---

## 5. 内存表与 WAL 的生命周期

### 5.1 一表一 WAL 与状态机

- 每个内存表对应一个 WAL（Badger 同法）。
- 内存表的状态：`active → immutable → flushing → flushed → freed`（D02 §3.3）：
  - `active → immutable`：在 W4 发生。
  - `immutable → flushing`：刷盘协程取走它时发生，断言此时 `writerRefs == 0`。
  - `flushing → flushed`：在 F6 发生，即刷盘的提交点之后。
  - `flushed → freed`：`readerRefs == 0` 时发生。
- 刷盘因非毒化原因失败（PS-3）时，回到 `immutable`，退避后重试。
- `Close` 时全部释放。

### 5.2 WAL 轮换（W1–W4，INV-6）

```text
W1 旧 WAL：写出用户态缓冲并 fsync（INV-6）；失败 ⇒ 毒化（PS-1）
W2 分配文件号，创建新 WAL，写入 48 字节文件头
W3 目录 fsync（D5）
W4 新内存表成为 active，旧内存表变为 immutable 并排入刷盘队列；更新 readState
```

- **INV-6**：WAL 轮换前，旧 WAL 必须先写出缓冲再 fsync 完成。因此恢复时只有最后一个 WAL 可能带崩溃残尾（§8.3）。

### 5.3 syncedOffset（I-1 写入端）

- 每个打开的 WAL / MANIFEST 维护 `syncedOffset`：已确认持久的文件长度，新文件为 0。
- 每次 fsync 成功后，把它更新为这次 fsync 之前已 `write()` 的文件长度。
- 每个 chunk 头的 `syncOffset` 字段写入该 chunk 写出时的 `syncedOffset`（file-format §2.2）。

---

## 6. 元数据提交

### 6.1 两类提交点

| 编号 | 提交点 | 何时使用 |
|---|---|---|
| **CP-1** | 一条 VersionEdit 追加到当前 MANIFEST，并且 fsync 成功 | 刷盘、合并（§6.3、§6.4） |
| **CP-2** | 新标记文件创建后，目录 fsync（S5）成功 | 切换到新的 MANIFEST：Open（§8）与滚动（§6.6） |

- 标记文件只在切换 MANIFEST 时移动，普通的刷盘、合并不移动标记（Pebble、LevelDB 同法）。
- CP-1 / CP-2 之前的任何失败，都不会改变恢复结果。
- 运行期在这两条路径上的任何 I/O 失败一律毒化（PS-1 / PS-2），不重试。

### 6.2 切换 MANIFEST（P1–P4、S1–S6）

```text
P1 创建 MANIFEST-<新>，写入文件头与快照记录（全部活文件、比较器名、dbID、三项计数）
P2 fsync 新 MANIFEST
P3 （调用方保证）快照中登记的全部 SSTable 都已 fsync，目录项也已持久（D3）
P4 目录 fsync（D1）
S1 iter = 当前迭代号 + 1（失败后不复用）
S2 创建空文件 marker.manifest.<iter>.MANIFEST-<新>
S3 fsync 该标记文件
S4 删除旧标记文件；删除失败只记录，留给下次 Open 清理
S5 目录 fsync（D2）—— 提交点 CP-2
S6 内存中切换到新 MANIFEST；删除旧 MANIFEST（§6.5）
```

- P1、P2、P4、S2、S3、S5 中任何一步失败：Open 期间则 Open 返回该错误；运行期则毒化。
  - 研究原文是「S1–S4 失败可重试、S5 失败 panic」，这里统一改为毒化（SC-36）。
- 标记文件与 MANIFEST 的不变量：
  - **MI-1**：迭代号最大的 manifest 标记所指的 MANIFEST 必须存在。
  - **MI-2**：一个 MANIFEST 中登记的 SSTable，只有在标记指向这个 MANIFEST 之后才算有效。
  - **MI-3**：标记只在新 MANIFEST 完全持久（P1–P4）之后才切换。
  - **MI-4**：Open 结束时，目录中没有未登记的文件。

### 6.3 刷盘（F1–F8）

```text
F1 取出最老的 immutable 内存表（→ flushing）
F2 从计数器分配文件号，以最终文件名 <编号>.sst 写出 SSTable（不经过 .tmp，SC-19）
F3 fsync 该 SSTable
F4 目录 fsync（D3）
F5 构造一条 VersionEdit：NewFile(L0) + LogNumber + NextFileNumber + LastSequence。
   LogNumber = 仍未刷盘的最老内存表对应的 WAL 编号；没有未刷盘的内存表时，取当前活跃 WAL 的编号
F6 追加该 edit 并 fsync MANIFEST —— 提交点 CP-1；随后安装新版本：
   readState 加入新 SSTable、移出该内存表；内存表 → flushed
F7 MANIFEST ≥ MaxManifestFileSize 时，按 §6.2 切换（§6.6）
F8 删除编号 < LogNumber 的 WAL（§6.5）
```

### 6.4 合并（K1–K6）

```text
K1 以最终文件名写出全部输出 SSTable，并逐个 fsync
K2 目录 fsync（D3）
K3 构造一条 VersionEdit：全部 DeletedFile + 全部 NewFile + 三项计数（LogNumber 不变）
K4 追加并 fsync MANIFEST —— 提交点 CP-1。删除和新增在同一条记录里，所以要么都生效，要么都不生效
K5 安装新版本；被替换的 SSTable 等到不再被任何版本引用后删除（§6.5）
K6 取消：K4 之前随时可以取消，已写出的输出文件删除（删除失败留给下次 Open 清理）；K4 之后不可取消
```

### 6.5 删除过期文件

| 文件 | 何时可删 |
|---|---|
| SSTable | 不在当前版本中，且没有任何仍被持有的版本引用它（版本引用计数） |
| WAL | 编号 < 已提交的 LogNumber |
| 旧 MANIFEST | S5 之后 |
| 旧标记 | S4 删除；失败的由下次 Open 清理 |

- 删除一批文件后做一次目录 fsync（D4）。D4 不是正确性必需的：被删的文件如果在崩溃后重新出现，下次 Open 的 R7 会把它当作未登记文件清理掉。
- 删除失败只记录并发 `Warning` 事件，从不毒化。

### 6.6 MANIFEST 滚动（SC-35）

- 每追加一条 edit，就检查当前 MANIFEST 的大小；≥ `MaxManifestFileSize`（128 MB）时按 §6.2 切换。
- Pebble 的 `ShouldRotate` 附加条件第一期不实现（D02 §9.1）。
- 另外，**每次 Open 都切换到新的 MANIFEST**（R10），因此不会在旧 MANIFEST 的残尾之后继续追加。

---

## 7. 目录 fsync 清单（D1–D6）

| 编号 | 时机 | 正确性必需 |
|---|---|---|
| **D1** | 新 MANIFEST 写完并 fsync 之后、创建标记之前（P4） | 是 |
| **D2** | 新标记创建、旧标记删除之后（S5，即 CP-2） | 是 |
| **D3** | 新 SSTable fsync 之后、它的 VersionEdit 追加之前（F4、K2） | 是 |
| **D4** | 删除一批过期文件之后 | 否（只为整洁） |
| **D5** | 新 WAL 创建之后、它承载第一个同步确认之前（W3、N6） | 是 |
| **D6** | 正常 `Close` 时，兜底覆盖没做 D4 的删除 | 否 |

- iter-15 原文的 D1 写的是「创建 MANIFEST 之前」，字面意思与它引用的 Pebble 代码（`pebble/version_set.go:216-229`）相反，本表以代码为准。
- 平台差异：
  - Linux：以 `O_RDONLY` 打开目录后 `fsync`。
  - darwin：`F_FULLFSYNC`，不支持时回退到 `fsync`（V-10，M1 用平台测试覆盖）。
  - Windows：不支持，见 §12。

---

## 8. 打开与恢复

### 8.1 新库创建（N1–N8，SC-38）

```text
N1 MkdirAll；取得 LOCK（flock，非阻塞，SC-40）
N2 按 R2、R3 确认这是新库（或未完成的初始化）
N3 生成 16 字节随机 dbID
N4 创建 MANIFEST-000001：写入文件头与快照
   （比较器名、dbID、LogNumber = 2、NextFileNumber = 3、LastSequence = 9、无文件），然后 fsync
N5 创建 000002.wal，写入文件头
N6 目录 fsync（同时满足 D1 与 D5）
N7 format-version 标记：S1–S5，值为 1
N8 manifest 标记：S1–S5，值为 MANIFEST-000001 —— 从此这个目录被视为已初始化的库
```

N8 之前崩溃不会丢失任何东西：写入只在 Open 返回之后才被接受。

### 8.2 恢复（R1–R10）

```text
R1  取得 LOCK（flock，非阻塞）；失败则 Open 失败。同一进程重复打开也会在这里失败
R2  解析目录中所有 marker.* 文件：
      名称未知或文件名无法解析 ⇒ ErrCorruption
      同一族里最大迭代号出现两次 ⇒ ErrCorruption
R3  没有 manifest 标记时：
      存在任何 .sst，或任何 .wal 含至少一条有效记录 ⇒ ErrCorruption（元数据丢失，不能猜）
      否则视为未完成的初始化：删除残留的 MANIFEST-*、*.wal、marker.format-version.*、*.tmp，
      然后按 §8.1 新建
R4  有 manifest 标记但没有 format-version 标记 ⇒ ErrCorruption；
    格式版本不在 [FormatMinSupported, FormatNewest] 之内 ⇒ ErrUnsupported（v1 两者都是 1）
R5  读取标记指向的 MANIFEST：
      文件不存在 ⇒ ErrCorruption（违反 MI-1）
      校验文件头：魔数、版本、fileNum 等于文件名编号
      按 §8.4 逐条读取并应用 VersionEdit
      首条必须是快照；比较器名 ≠ Options.Comparer.Name() ⇒ ErrInvalidOptions；
      dbID 必须与文件头一致
R6  对每个登记的 SSTable：
      必须存在，大小必须等于 NewFile.size
      打开 footer、metaindex、属性块并校验（file-format §5.9）
      不扫描数据块（D02 §9.6；全量校验交给 cairnkv check --full）
R7  在 R6 全部通过之后，删除未登记的文件：
      不在版本中的 .sst；编号 < LogNumber 的 .wal；不是当前的 MANIFEST-*；非最大迭代号的标记；所有 *.tmp
R8  按编号升序重放编号 ≥ LogNumber 的 WAL（§8.3），得到批次序列；
    检查序号连续（INV-9），按 INV-9 计算 allocSeq
R9  把重放出的批次写入内存表，写满就刷成 L0（F2–F4 的步骤）；结束时剩下的内存表也刷成 L0
R10 新建 WAL（W2、W3）；按 §6.2 切换到新的 MANIFEST
    （快照包含全部活文件、新 WAL 的编号作为 LogNumber、LastSequence = allocSeq）；
    删除已重放的旧 WAL 和旧 MANIFEST（§6.5）；visibleSeq = allocSeq；Open 返回
```

- R9、R10 是 SC-29 的做法：Open 结束时，所有重放出的数据都已在 L0，旧 WAL 已删除，新写入一定进入新 WAL。LevelDB 同法（`leveldb/db/db_impl.cc:494-497`）。
- 代价：Open 时间包含一次刷盘，默认最多约 8 MB。

### 8.3 WAL 重放判定（I-1）

对每个要重放的 WAL，按编号升序处理：

```text
1. 文件头：
   - 短于 48 字节、全零或头部校验和错 ⇒ 视为偏移 X = 0 处无效，转第 3 步
   - 校验和正确但字段不符（魔数、flags、blockSize、fileNum、dbID）⇒ ErrCorruption；版本更高 ⇒ ErrUnsupported
2. 按块、按 chunk 顺序读取，遇到第一个无效位置 X（file-format §2.2 的「无效 chunk」）就停止。
   文件在一条记录的中途结束时，X = 这条记录第一个 chunk 的偏移
3. 存在 X 时：
   a. 这个 WAL 不是最后一个 ⇒ ErrCorruption（INV-6）
   b. 从 X 所在块的下一个块起，逐块寻找「看起来有效」的 chunk（校验和正确、type 合法、logNum 匹配）；
      只要有一个的 syncOffset > X ⇒ ErrCorruption（已同步的区域被损坏）
   c. 否则 X 之后都是崩溃残尾：丢弃，计入指标 WALTornTailBytes，发 Warning 事件
4. 每条完整的逻辑记录按 file-format §2.3 解析；任何结构错误都 ⇒ ErrCorruption，与位置无关
```

- **为什么正确**：崩溃只破坏未同步的区域（§1.2）。任何已确认的同步写入都在某次 fsync 的覆盖范围内，之后写出的 chunk 会以更大的 `syncOffset` 为它作证。
- 剩余风险见 §12。

### 8.4 MANIFEST 读取判定

- chunk 层面的判定规则与 §8.3 相同。当前 MANIFEST 视为「最后一个文件」，可以有崩溃残尾：被撕裂的 edit 没有达到 CP-1，丢弃它是正确的。
- edit 层面的错误（file-format §3.1 的应用规则）一律 `ErrCorruption`。

---

## 9. 毒化（INV-5，SC-36）

- 状态只有三个：运行 → 毒化 → 已关闭。毒化只存在于进程内，不写盘。
- **触发条件**：

| 编号 | 触发 |
|---|---|
| **PS-1** | 任何 `Sync` / `SyncData` / 目录 `Sync` 返回错误：WAL、MANIFEST、SSTable、标记文件、目录都算 |
| **PS-2** | WAL、MANIFEST、标记文件的 `write()` 或 `Create` 失败 |

- **不触发毒化的错误**：

| 编号 | 情形 | 处理 |
|---|---|---|
| **PS-3** | 构建中、尚未登记的 SSTable `write()` / `Create` 失败（如磁盘满） | 该任务作废，删除文件，发事件，退避后重试 |
| **PS-4** | 删除过期文件失败 | 只记录，下次 Open 清理 |
| **PS-5** | 读到 `ErrCorruption` | 返回给调用者；后台任务停止调度涉及该文件的工作，并发事件 |

毒化只用于「持久性不确定」的情形。

- **毒化后的效果**：

| 编号 | 效果 |
|---|---|
| E1 | 所有 API（含读、迭代器、快照操作）都返回 `ErrEnginePoisoned`。它包装原始错误，`errors.Is` 对两者都成立 |
| E2 | 进行中的组：写入者全部收到 `ErrEnginePoisoned`；fsync 失败的组永不应用（INV-7） |
| E3 | 后台协程不再开始新任务；正在运行的任务在下一次 I/O 时中止 |
| E4 | `Poisoned` 事件只发一次 |
| E5 | `Close`：不刷盘、不同步 WAL，只关闭文件并释放 LOCK；返回 `ErrEnginePoisoned` |
| E6 | 重新打开：走正常恢复（§8）。同一进程在 `Close` 之后可以重开 |

- 已知局限：在使用延迟分配的文件系统上，磁盘满可能到 fsync 时才报出来，这时会毒化。

---

## 10. 关闭（C1–C6，SC-42）

```text
C1 标记为关闭：之后新的 API 调用返回 ErrClosed；再次调用 Close 也返回 ErrClosed
C2 写队列中尚未开始写 WAL 的等待者（包括停写中的）返回 ErrClosed；进行中的组提交等它完成
C3 取消后台任务（context），等所有后台协程退出；未提交的输出文件删除，删除失败留给下次 Open
C4 未毒化时：写出 WAL 缓冲并 fsync 活跃 WAL —— 此后所有已确认的写入（包括 NoSync）都已持久
C5 未毒化时：目录 fsync（D6）
C6 关闭所有文件；用户仍持有的迭代器、快照之后返回 ErrClosed；最后释放 LOCK
```

- 返回值：正常 ⇒ nil；已毒化 ⇒ `ErrEnginePoisoned`。
- 内存表在 Close 时**不刷盘**，下次 Open 由 WAL 重放恢复。

---

## 11. 前缀一致性与崩溃检查器（I-4）

### 11.1 正确性定义

记 `B₁, B₂, …, Bₙ` 为所有开始写 WAL 的批次，按序号排列。记 `K` 为崩溃前最后一个「已承诺持久」的批次的下标：按 AP-1 / AP-2 确认的批次，或者已被 §2.2 中某个时刻覆盖的批次。

| 编号 | 断言 |
|---|---|
| **PC-1** | 系统崩溃并成功 Open 之后，库的内容等于依次应用 `B₁ … Bₖ` 的结果，其中 `K ≤ k ≤ n` |
| **PC-2** | 收到非毒化错误的批次绝不出现（由 INV-8 保证，它们不在 `B` 中） |
| **PC-3** | 对崩溃产生的状态，`Open` 绝不返回 `ErrCorruption` |
| **PC-4** | 进程崩溃（而非系统崩溃）之后，`k` 不小于任一档位下最后一个已确认批次的下标，NoSync 也算 |

### 11.2 检查器

- 内存 vfs 记录完整的操作轨迹。崩溃点设在每个 `Sync` / `SyncData` / 目录 `Sync` / `Create` / `Remove` 之前。
- 在每个崩溃点按 §1.2、§1.3 构造崩溃状态：
  1. 只保留已同步的数据；
  2. 保留全部已写数据；
  3. 未同步的页随机取「新内容 / 全零 / 垃圾」；
  4. 未同步的目录操作随机生效一部分；
  5. 进程崩溃状态：保留全部已 `write()` 的字节。
- 对每个状态执行 Open，再用有序模型找出满足 PC-1 的 `k`，并检查 PC-2 至 PC-4。
- 不超过约 200 次 vfs 操作的工作负载，对崩溃点做穷举；第 3、4 类状态用固定种子随机采样。
- 更大的工作负载走 D03 M2-14 的随机 `CrashClone`。

---

## 12. 平台声明与已知局限

- **文件系统分三档（I-8）**：

| 档位 | 文件系统 | 处理 |
|---|---|---|
| 保证 | Linux 的 ext4 / xfs（`just test-linux-fs` 覆盖）、macOS 的 APFS | 承诺持久性 |
| 未验证 | btrfs、zfs 等其他本地文件系统 | 不警告，也不承诺 |
| 不保证 | tmpfs、overlayfs、NFS | `Open` 时发 `Warning` 事件，但照常打开 |

- **Windows**：第一期不支持。那里的目录同步只能是空操作（`badger/dir_windows.go:100`）。
- **已知局限**：
  1. **I-1 的剩余风险**：最后一次 fsync 所覆盖的那组写入，如果之后再没有写出任何 chunk，那段区域里的损坏无法与崩溃残尾区分，会被当作残尾丢弃。Pebble 有同样的局限。
  2. 32 位 CRC 每次比对有 2⁻³² 的漏检概率。
  3. NoSync 的丢失窗口没有时间上界（§2.2）。
  4. 磁盘满可能在 fsync 时才报出，进而毒化（§9）。
  5. 虚拟化环境的 fsync 可能达不到物理落盘。本机 OrbStack 实测见 spec-closure §2.2，持久性取决于宿主与虚拟化层。
  6. NoSync 写入可见先于持久；同步写入不会（INV-7）。

---

## 13. 旧编号对照

| 旧编号 | 出处 | 本文 |
|---|---|---|
| R1 / R2 / R3（lane 摘要中的三条不变量） | `.autoresearch/work/block-B-digest.md` | INV-1 / INV-2 / INV-3 |
| INV-1 … INV-5 | D03 §0.1 | 同号（§3.1、§3.2、§9） |
| INV-6 | spec-closure F-3 | 同号（§5.2） |
| iter-15 的 INV-1 … INV-4 | iter-15 | MI-1 … MI-4（§6.2） |
| iter-08 的 I1 / I2 / I3 | iter-08 | I1 → §5.1 的释放条件；I2 → SC-09（`MemTableSize ≤ 1 GiB`）；I3 → INV-3 |
| iter-15 的 R1 … R9 | iter-15 | §8.2 的 R1 … R10（重排；MANIFEST 残尾处理改用 I-1 规则） |
| iter-15 的 D1 … D6 | iter-15 | §7 的 D1 … D6（D1 措辞按代码修正；D4、D6 降为非必需；D5 收紧） |
| iter-15 的 P1 … P4、S1 … S6 | iter-15 | §6.2（失败一律毒化） |
