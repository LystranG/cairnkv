# CairnKV 磁盘格式规格（格式版本 1）

| 项 | 内容 |
|---|---|
| 适用 | store 格式版本 1（`marker.format-version` 的值为 `1`）；WAL、MANIFEST 文件头 `formatVersion = 1`；SSTable footer `formatVersion = 1` |
| 日期 | 2026-10-29 |
| 地位 | 规范性文档：字节布局以本文为准。决策理由见 `docs/spec-closure.md`（SC-xx、I-x），写入顺序与恢复判定见 `docs/durability.md` |
| 守护 | §9 的 hex 样例由测试逐字节比对编码器输出（spec-closure I-5(a)）；样例在 M1 / M2 由编码器生成后补齐 |

---

## 0. 通用约定

- **字节序**：所有定长整数都是小端。
- **varint**：无符号 LEB128（Go `encoding/binary.PutUvarint` / `Uvarint`），**必须是最短编码**，否则 `ErrCorruption`（SC-32）。
  - `uvarint32`：取值 ≤ 2^32 − 1，最多 5 字节；`uvarint64`：最多 10 字节。
- **LPS**（length-prefixed slice）：`uvarint32 长度 ‖ 字节`。
- **maskedCRC32C(x)** = `rotr32(crc32c(x), 15) + 0xa282ead8`（模 2^32）。`crc32c` 用 Castagnoli 多项式（Go `crc32.MakeTable(crc32.Castagnoli)`）。掩码与 LevelDB 相同（`leveldb/util/crc32c.h:22,31`）。
- **魔数**：8 字节 ASCII，按字节写入，不当整数处理：`CairnWAL` / `CairnMAN` / `CairnSST`（SC-11）。
- **文件号**：全局单调递增的 uint64，WAL、SSTable、MANIFEST 共用一个计数器，永不复用。文件名中写成至少 6 位、左侧补零的十进制（`%06d`，超过 6 位时自然变宽）。新库固定为 `MANIFEST-000001`、首个 WAL `000002.wal`，`NextFileNumber = 3`。
- **错误分类**（SC-39）：
  - 结构不合法 ⇒ `ErrCorruption`。
  - 能识别、但本构建不支持（更高的格式版本、预留的压缩类型、必须理解的自定义字段）⇒ `ErrUnsupported`。

---

## 1. 内部键

```text
internal_key = user_key ‖ trailer
trailer      = uint64 LE，值为 (seq << 8) | kind
```

| kind | 名称 | 允许出现的位置 |
|---|---|---|
| 0 | Invalid | 任何位置出现 ⇒ `ErrCorruption` |
| 1 | Set | 数据条目、WAL 条目 |
| 2 | Delete | 数据条目、WAL 条目 |
| 3–7 | 预留给 CairnKV（如 SingleDelete、Merge） | v1 中出现 ⇒ `ErrCorruption` |
| 8–15 | 预留给范围删除、范围键 | 同上 |
| 16–254 | 未分配 | 同上 |
| 255（`KindSeek`） | 查找用 | **只**出现在查找目标与索引分隔键里，绝不出现在数据条目或 WAL 中 |

- **seq**（56 位，SC-27）：
  - 0–9 保留；用户数据的序号 ∈ [10, 2^56 − 2]。
  - `SeqMax = 2^56 − 1` 只作哨兵。
  - 数据条目或 WAL 中的序号超出用户数据范围 ⇒ `ErrCorruption`。
  - v1 不做「把底层键的序号清零」的优化（Pebble 的 `SeqNumZero`）。
- **InternalCompare(a, b)**：先用 `Comparer.Compare` 比较用户键；相等时按 trailer **数值降序**。
  - 必须先把 trailer 解码成 uint64 再比较，不能对 8 个小端字节做字节序比较（那样不会报错，但会让点查返回最旧的版本）。
  - 「trailer 降序」是格式常量。
- **查找目标**：读取快照序号 `S` 时用 `user_key ‖ trailer(S, 255)`；它排在该用户键所有 `seq ≤ S` 的版本之前。
- 格式本身不限制用户键长度；API 限制为 64 KiB（SC-09）。

---

## 2. WAL 文件（`<编号>.wal`）

### 2.1 文件头（48 字节，SC-08）

| 偏移 | 大小 | 字段 | 规则 |
|---|---|---|---|
| [0..8) | 8 | magic | `"CairnWAL"` |
| [8..10) | 2 | formatVersion | u16 = 1；更高 ⇒ `ErrUnsupported` |
| [10..12) | 2 | flags | u16 = 0；v1 中非零 ⇒ `ErrCorruption` |
| [12..16) | 4 | blockSize | u32 = 32768 |
| [16..24) | 8 | fileNum | u64，必须等于文件名中的编号（I-3） |
| [24..40) | 16 | dbID | 必须等于 MANIFEST 记录的 dbID（I-3） |
| [40..44) | 4 | reserved | 必须为 0 |
| [44..48) | 4 | headerChecksum | `maskedCRC32C([0..44))` |

文件头无效（短于 48 字节、全零或校验和错）时，不直接报错，按 `durability.md` §8.3 的规则判定（视为「偏移 0 处无效」）。

### 2.2 物理块与 chunk（I-1）

- 文件按 32 KiB 切成物理块，块 k 从偏移 `k × 32768` 开始；块 0 的可用区域从偏移 48 开始。
- **chunk 头（19 字节）**：

| 偏移 | 大小 | 字段 | 规则 |
|---|---|---|---|
| [0..4) | 4 | checksum | `maskedCRC32C(type ‖ logNum ‖ syncOffset ‖ payload)` |
| [4..6) | 2 | length | payload 字节数，≥ 1 |
| [6] | 1 | type | 1 = FULL，2 = FIRST，3 = MIDDLE，4 = LAST；其余值无效 |
| [7..11) | 4 | logNum | 文件号的低 32 位 |
| [11..19) | 8 | syncOffset | 写这个 chunk 时，本文件已确认 fsync 到的长度 |

- chunk 绝不跨块。块内剩余不足 20 字节时，写入端用零填满，换到下一块（因此不存在 payload 为空的 chunk）。
- `syncOffset` 的约束：不大于该 chunk 自身的偏移；同一文件内单调不减。
- 一条逻辑记录 = 一个 FULL，或 FIRST + 若干 MIDDLE + LAST。
- **无效 chunk**（任一条即无效；遇到无效位置后如何处理见 `durability.md` §8.3）：
  - 块尾不足 20 字节的区域不全为零；
  - chunk 头或 payload 越过块尾；
  - type 不在 1–4；length = 0；校验和错；logNum 不匹配；
  - syncOffset 违反上述约束；
  - 片段顺序错：MIDDLE / LAST 之前没有 FIRST，或 FIRST 之后紧跟 FIRST / FULL；
  - 文件在一条记录的中途结束。

### 2.3 逻辑记录：一个批次一条（SC-32）

```text
[0..8)   base    u64   批次第一个操作的序号
[8..12)  count   u32   操作数，≥ 1
之后 count 个条目：
  kind      u8          1 = Set，2 = Delete（与内部键 kind 是同一个枚举，SC-03）
  keyLen    uvarint32
  key       keyLen 字节
  valueLen  uvarint32   仅 Set
  value     valueLen 字节，仅 Set
```

- 第 i 个条目（从 0 起）的序号是 `base + i`。WAL 不存 trailer。
- 以下情况一律 `ErrCorruption`，与在文件中的位置无关：
  - 记录短于 12 字节；`count = 0`；kind 不是 1 或 2；
  - 长度字段超出剩余字节；解析完 `count` 个条目后还有剩余字节；
  - `base < 10`；`base + count − 1 > 2^56 − 2`。

---

## 3. MANIFEST 文件（`MANIFEST-<编号>`）

- 文件头与 §2.1 相同，只有魔数换成 `"CairnMAN"`；chunk 格式与 §2.2 完全相同。
- 每条逻辑记录是一个 VersionEdit。

### 3.1 VersionEdit 编码（SC-33 / SC-34）

VersionEdit 是一串 `tag ‖ 负载`，直到记录结束。tag 用 `uvarint32` 编码：

| tag | 名称 | 负载 |
|---|---|---|
| 1 | ComparatorName | LPS |
| 2 | LogNumber | uvarint64：仍需重放的最小 WAL 编号 |
| 3 | NextFileNumber | uvarint64 |
| 4 | LastSequence | uvarint64：写这条 edit 时的 `visibleSeq` |
| 5 | DeletedFile | `level uvarint32 ‖ fileNum uvarint64` |
| 6 | NewFile | 见 §3.2 |
| 7 | DBID | 16 字节 |

- tag 为 0 或未知 ⇒ `ErrCorruption`。格式演进靠 store 格式版本：新版本写入新 tag 之前必须先提升 store 版本，因此旧构建会在打开阶段就拒绝。
- 除 DeletedFile、NewFile 外，每个 tag 在一条 edit 中最多出现一次。
- **每条** edit 都必须含 LogNumber、NextFileNumber、LastSequence（LevelDB 同法，`leveldb/db/version_set.cc:777-790`）。
- **首条记录是快照**：
  - 额外必须含 ComparatorName 和 DBID；
  - 用 NewFile 列出全部活文件；
  - 不得含 DeletedFile。
- 之后的 edit 不得含 ComparatorName、DBID。
- **应用规则**：
  - 同一条 edit 内先应用全部删除，再应用全部新增。
  - 以下情况 ⇒ `ErrCorruption`：删除不存在的文件；新增已存在的文件号；同一 edit 里删除又新增同一文件号；文件号 ≥ NextFileNumber；`level ≥ 7`。
  - LogNumber、NextFileNumber、LastSequence 在相继的 edit 中不得减小，否则 `ErrCorruption`。
- v1 不持久化 CompactPointer（LevelDB 的 tag 5 在这里另作他用；本格式不与 LevelDB 兼容，D-10）。

### 3.2 NewFile 负载

```text
level        uvarint32   0 ≤ level < 7
fileNum      uvarint64
size         uvarint64   文件字节数，打开时与 stat 结果比对
smallest     LPS         最小内部键
largest      LPS         最大内部键
smallestSeq  uvarint64
largestSeq   uvarint64
自定义字段    { customTag uvarint32 ‖ LPS }*，以 customTag = 1 结束
```

- 自定义字段的取值规则（沿用 Pebble 的位 6 语义，`pebble/internal/manifest/version_edit.go:67-96`）：

| customTag | 含义 |
|---|---|
| 0 | `ErrCorruption` |
| 1 | 结束标记 |
| 2–63 | 可安全忽略：跳过其 LPS |
| 64–127 | 必须理解：v1 一个都没定义，读到 ⇒ `ErrUnsupported` |
| ≥ 128 | `ErrCorruption` |

- v1 的写入端只写结束标记。

---

## 4. 标记文件（SC-06 / SC-37）

- 文件名：`marker.<名称>.<迭代号>.<值>`。
  - 名称只有 `manifest` 与 `format-version` 两种；名称里不含 `.`。
  - 迭代号：至少 6 位、补零的十进制，从 `000001` 开始，每次移动加 1。
  - 值：`manifest` 族为 `MANIFEST-<编号>`；`format-version` 族为十进制版本号（v1 为 `1`）。
- 内容：空文件（0 字节）。标记的语义全在文件名里。
- 示例：`marker.manifest.000003.MANIFEST-000017`、`marker.format-version.000001.1`。
- 打开时的处理规则（解析失败、迭代号并列、族缺失）见 `durability.md` §8.2。

---

## 5. SSTable 文件（`<编号>.sst`）

### 5.1 总体布局

```text
[数据块 1] … [数据块 N]       N ≥ 1
[过滤器块]                     可选
[索引块]                       单级：1 块；两级：若干分区块 + 1 个顶层块
[属性块]
[metaindex 块]                 紧贴 footer
[footer 53 字节]
```

- 块与块之间紧挨着写，没有填充或对齐要求。
- 空表不合法：写入端从不产生 0 条目的 SSTable；读到没有数据块的表 ⇒ `ErrCorruption`。

### 5.2 块、句柄与 trailer（I-2）

- **块** = `data[n] ‖ type u8 ‖ checksum u32`。
- **BlockHandle** = `offset uvarint64 ‖ size uvarint64`。`size = n`，**不含** 5 字节 trailer，所以读一个块要读 `size + 5` 字节。
- **checksum** = `maskedCRC32C(data ‖ type) + modifier(base, offset)`（模 2^32）。
  - `offset` 是该块 data 的起始文件偏移。
  - `modifier(b, o) = b XOR (lo32(o) + hi32(o))`，加法模 2^32（RocksDB 同款，`rocksdb/table/format.h:154-178`）。
  - `base` 取 footer 的 `baseContextChecksum`。
- **base 的派生**（I-3）：`base = crc32c(dbID ‖ u64LE(fileNum))`，结果为 0 时取 1。
- **type**：

| type | 含义 | 处理 |
|---|---|---|
| 0 | 无压缩 | 所有块都可用 |
| 1 | Snappy | 只允许数据块使用；其他块出现 ⇒ `ErrCorruption` |
| 2 / 3 | Zstd / MinLZ，仅为 M5 对照实验预留 | v1 读到 ⇒ `ErrUnsupported` |
| 其他 | — | `ErrCorruption` |

### 5.3 键值块编码（数据块、索引块、metaindex、属性块共用）

```text
entry = shared uvarint32 ‖ unshared uvarint32 ‖ valueLen uvarint32 ‖ keyDelta[unshared] ‖ value[valueLen]
block = entry+ ‖ restarts u32 × P ‖ P u32          P ≥ 1
```

- `shared` 是与前一个条目的键共享的前缀长度。restart 点的 `shared = 0`。`restarts[0] = 0`；restart 偏移严格递增，且小于 restart 数组的起点。
- 键严格递增。数据块、索引块按 InternalCompare 比较；metaindex、属性块按名称的字节序比较。
- **restart 间隔**：数据块 16；索引块（各级）、metaindex、属性块都是 1。读取端不依赖间隔值，只用 restart 数组。
- 以下情况 ⇒ `ErrCorruption`：`P = 0`；没有条目；restart 偏移越界；`shared` 大于前一个键的长度；长度字段越过块的数据区。
- **数据块的切块规则**（写入端）：
  - 追加一个条目后，若「已写条目 + restart 数组」的估算大小 ≥ `BlockSize`，结束当前块。
  - 单个条目大于 `BlockSize` 时独占一块。
  - 块的原始大小必须 < 2^32。

### 5.4 数据块

- 键是内部键：kind 只能是 1 或 2，序号必须在用户数据范围内。
- Set 的值是用户值；Delete 的 `valueLen` 必须为 0。

### 5.5 索引块

- 条目：键 = 分隔键（内部键），值 = 目标块的 BlockHandle（值必须恰好被句柄编码用完）。
- **分隔键**（SC-10；LevelDB 的内部键封装，`leveldb/db/dbformat.cc:65-96`）：
  - 非最后一块 i：`u = Comparer.Separator(块 i 末键的用户键, 块 i+1 首键的用户键)`。
    - 若 `u` 严格大于块 i 末键的用户键 ⇒ 分隔键 = `u ‖ trailer(SeqMax, 255)`；
    - 否则分隔键 = 块 i 末键的完整内部键。
  - 最后一块：用 `Comparer.Successor(末键的用户键)`，规则同上。
  - 同一用户键的多个版本可以跨越块边界；点查在块尾时继续读下一个块。
- **两级索引**：
  - 写入端在「再加一项会使在建索引块的原始大小 ≥ `IndexBlockSize`（默认 8 × BlockSize）」时结束当前分区。
  - 顶层块的条目：键 = 分区的最后一个分隔键，值 = 分区块的句柄。
  - 结束时若只有一个分区，就写成单级索引。
- **读取端怎么区分单级和两级**：看 metaindex 里出现的是 `cairn.index` 还是 `cairn.index.top`（§5.8），并与属性 `cairn.index-partitions` 交叉校验。

### 5.6 过滤器块（缓存行分块 Bloom）

位级规格取自 Pebble 的实现（`pebble/sstable/tablefilters/bloom/`），只改了一处：哈希尾部字节按无符号处理，与现行 LevelDB 一致（`leveldb/util/hash.cc:41-47`）。

```text
hash32(key)：m = 0xc6a4a793，h = 0xbc9f1d34 XOR (len(key) × m)
  每 4 字节（小端 u32 w）：h += w；h *= m；h ^= h >> 16
  剩余字节（无符号）：若有第 3 字节 h += b[2] << 16；若有第 2 字节 h += b[1] << 8；
                     若有第 1 字节 h += b[0]；然后 h *= m；h ^= h >> 24
  （全部运算模 2^32）

输入：表内所有用户键的 hash32；相邻相同的哈希只算一次，得到 n 个
bitsPerKey = Options.FilterBitsPerKey（默认 10）；n = 0 或 bitsPerKey < 2 ⇒ 不写过滤器
k    = [1,1,2,3,3,4,4,5,5,6][min(bitsPerKey,10) − 1]
rows = ((n × bitsPerKey + 511) / 512) | 1            整数除，结果为奇数
块内容 = bits[rows × 64] ‖ k u8 ‖ rows u32

对每个 h 置位：
  row = h mod rows；delta = rotr32(h, 17)
  重复 k 次：bit = h & 511；bits[row × 64 + (bit >> 3)] |= 1 << (bit & 7)；h += delta（模 2^32）
查询：同样的步骤，任一位为 0 ⇒ 键一定不在表中
```

- 用**用户键**做哈希：同一用户键的多个版本只计一次。
- 过滤器块不压缩（type = 0），照常带 trailer。校验和错 ⇒ `ErrCorruption`。
- 读取端校验：块长 < 5、`rows = 0`、`(块长 − 5) ≠ rows × 64` 或 `k ∉ [1, 30]` ⇒ `ErrCorruption`。
- 过滤器给出「不存在」时可以跳过这个表；过滤器缺失或 family 不认识时，回退到读索引和数据块。

### 5.7 属性块

属性块按 §5.3 编码，键是属性名，按字节序升序排列：

| 名称 | 值编码 | 打开时的检查 |
|---|---|---|
| `cairn.block-size` | uvarint64 | 仅记录 |
| `cairn.comparator` | 字节串 | 必须等于 `Options.Comparer.Name()`，否则 `ErrInvalidOptions` |
| `cairn.compression` | 字节串（`snappy` / `none`） | 仅记录（每个块的 type 字节才是权威） |
| `cairn.db-id` | 16 字节 | 必须等于 MANIFEST 中的 dbID，否则 `ErrCorruption` |
| `cairn.file-num` | uvarint64 | 必须等于文件名中的编号，否则 `ErrCorruption` |
| `cairn.filter` | 字节串（`bloom` / `none`） | 仅记录 |
| `cairn.format-version` | uvarint64 | 必须等于 footer 中的值 |
| `cairn.index-partitions` | uvarint64 | 0 = 单级；必须与 metaindex 中的索引条目一致 |
| `cairn.internal-key-version` | uvarint64 | 必须为 1，否则 `ErrUnsupported` |
| `cairn.num-data-blocks` | uvarint64 | 仅记录 |
| `cairn.num-entries` | uvarint64 | 仅记录 |
| `cairn.restart-interval` | uvarint64 | 仅记录 |

- 上表各项都是必需的，缺任何一项 ⇒ `ErrCorruption`；不认识的属性名忽略（向前兼容）。
- 块大小、restart 间隔、压缩方式只是该文件自己的记录。修改 `Options` 只影响新写的文件，旧文件照常可读。

### 5.8 metaindex 块

metaindex 块按 §5.3 编码，键是名称（按字节序升序），值是 BlockHandle：

| 名称 | 指向 | 出现 |
|---|---|---|
| `cairn.filter.bloom` | 过滤器块 | 可选 |
| `cairn.index` | 单级索引块 | 与下一项恰好出现一个 |
| `cairn.index.top` | 两级索引的顶层块 | 同上 |
| `cairn.properties` | 属性块 | 必需 |

- `cairn.index` 与 `cairn.index.top` 都出现或都不出现 ⇒ `ErrCorruption`。
- 其他 `cairn.filter.<family>` 视为不认识的过滤器，忽略。
- 其他不认识的名称忽略。

### 5.9 Footer（53 字节，I-2）

| 偏移 | 大小 | 字段 | 规则 |
|---|---|---|---|
| [0] | 1 | checksumType | = 1（masked CRC32C + 上下文修正）；其他 ⇒ `ErrCorruption` |
| [1..5) | 4 | footerChecksum | `maskedCRC32C(footer，本字段置零) + modifier(base, footerOffset)` |
| [5..9) | 4 | baseContextChecksum | ≠ 0；必须等于由 dbID、fileNum 派生的值（§5.2） |
| [9..13) | 4 | metaindexSize | metaindex 块 data 的字节数（**不含** trailer） |
| [13..41) | 28 | reserved | 必须全零，否则 `ErrCorruption` |
| [41..45) | 4 | formatVersion | u32 = 1；更高 ⇒ `ErrUnsupported`；0 ⇒ `ErrCorruption` |
| [45..53) | 8 | magic | `"CairnSST"` |

- `footerOffset = 文件长度 − 53`；metaindex 块的 data 从 `footerOffset − 5 − metaindexSize` 开始。footer 校验和的算法与 RocksDB format_version 6 相同（`rocksdb/table/format.cc:376-380`）。
- **打开顺序**：
  1. 读最后 53 字节，依次检查魔数、formatVersion、checksumType、reserved、footer 校验和、base ≠ 0；
  2. 读 metaindex（校验 trailer）；
  3. 读属性块（校验 trailer）；
  4. 核对 dbID、fileNum 与 base 的派生值；
  5. 按 metaindex 定位索引与过滤器。

### 5.10 压缩（SC-41）

- 只有数据块可能被压缩。
- 写入端用标准 Snappy 块格式（`klauspost/compress` 的 `s2.EncodeSnappy`，SC-15）。只有 `len(压缩后) × 100 ≤ len(原始) × 88` 时才采用压缩结果，否则存原始数据、type 写 0。这是纯整数比较，与 Pebble 的实际代码一致（`pebble/sstable/block/compressor.go:82-92`）。
- 读取端：Snappy 头声明的解压长度 > 1 GiB，或与实际解压结果不符，或解压失败 ⇒ `ErrCorruption`（不得 panic）。
- 块缓存存放的是解压后的块。

---

## 6. 数据目录

```text
<data-dir>/
├── LOCK                                      进程独占（flock，SC-40）；空文件，不 fsync
├── marker.format-version.<迭代号>.<版本>      store 格式版本
├── marker.manifest.<迭代号>.MANIFEST-<编号>   当前 MANIFEST（取代 CURRENT）
├── MANIFEST-<编号>
├── <编号>.wal
└── <编号>.sst
```

- v1 不产生 `*.tmp`；打开时如果发现，一律删除。
- 打开时如何归类、清理这些文件，见 `durability.md` §8.2 的 R2、R3、R7。

---

## 7. 版本边界

三个版本号：

- **store 格式版本**（标记文件）：总开关，决定本库允许哪些文件格式与特性（SC-06）。
- **WAL / MANIFEST 文件头的 formatVersion**。
- **SSTable footer 的 formatVersion**。

| 改动 | 需要提升 |
|---|---|
| 块条目编码、trailer 布局、footer 字段、校验和算法集合、索引项编码 | SSTable formatVersion + store 版本 |
| 过滤器分区（新增顶层过滤器索引与新的 metaindex 名称） | 同上 |
| 新的压缩类型（Zstd、MinLZ 等）投入写入 | store 版本（旧构建在打开阶段就拒绝；单个文件内类型字节自描述） |
| 字典压缩（新增 meta 块与字典标识） | SSTable formatVersion + store 版本 |
| 文件头字段、chunk 格式、逻辑记录编码、新的 VersionEdit tag、新的 kind | WAL/MANIFEST formatVersion + store 版本 |
| 「必须理解」的 NewFile 自定义字段（64–127） | 不必（旧构建读到即拒绝），但应同时提升 store 版本，以便在打开阶段就报出 |
| 可忽略的自定义字段（2–63）、新的可选属性、新的可选 metaindex 条目 | 不需要 |
| 块大小、restart 间隔、单级 ↔ 两级索引、写不写过滤器 | 不需要（结构自描述） |

- SSTable formatVersion = 2 预留给列式块，目前未分配。同一个版本号内不得混用两种块布局。
- 迁移：不做原地迁移。旧版本文件由后台合并重写（D02 §17 第 21 行）。

---

## 8. 与研究文档的差异

本文取代的研究条目见 `docs/spec-closure.md` §5。下面几处如果对照 LevelDB / Pebble 源码照抄，会写错：

- WAL chunk 头 19 字节，不是 7 字节。
- WAL 条目 tag 复用内部键 kind：`1 = Set`、`2 = Delete`，没有 `0 = Delete`。
- VersionEdit 的 tag 编号是 CairnKV 自定的：5 = DeletedFile，而 LevelDB 的 5 是 CompactPointer。
- footer 是 RocksDB v6 式的 53 字节，句柄全在 metaindex 里，footer 中没有句柄。
- 魔数是 ASCII 字节，不是 64 位整数。

---

## 9. hex 样例（I-5(a)，待补）

| # | 内容 | 由谁生成 |
|---|---|---|
| 9.1 | 新库 WAL `000002.wal`：48 字节文件头 + 一个 FULL chunk（批次 base = 10，Set `"a"` → `"1"`） | M1 编码器 |
| 9.2 | 新库 `MANIFEST-000001`：文件头 + 快照记录 | M2 编码器 |
| 9.3 | 一个含 3 个条目的数据块（含 restart 数组与 trailer） | M2 编码器 |
| 9.4 | 一个 footer | M2 编码器 |

样例写成 ```` ```hex ```` 代码块，并附逐字段注释。测试解析这些代码块，断言编码器输出逐字节一致、解码器能还原出注释中的字段值。
