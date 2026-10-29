# CairnKV 磁盘格式规格（格式版本 1）

| 项 | 内容 |
|---|---|
| 适用 | store 格式版本 1（`marker.format-version` 的值为 `1`）；WAL、MANIFEST 文件头 `formatVersion = 1`；SSTable footer `formatVersion = 1` |
| 日期 | 2026-10-29（第二版：按审阅结果修订，见 `docs/spec-closure.md` §2.4） |
| 地位 | **字节布局与解析判定以本文为准**。决策理由见 `docs/spec-closure.md`（SC-xx、I-x）；写入顺序与恢复判定见 `docs/durability.md` |
| 守护 | §9 的样例由测试逐字节校验（spec-closure I-5(a)）。§9.0、§9.1 已由独立脚本算出，不依赖引擎实现 |

---

## 0. 通用约定

- **字节序**：所有定长整数都是小端。
- **varint**：无符号 LEB128，**必须是最短编码**，否则 `ErrCorruption`。
  - `uvarint32`：值 ≤ 2^32 − 1，最多 5 字节；值超出 ⇒ `ErrCorruption`。
  - `uvarint64`：最多 10 字节。
  - Go 的 `binary.Uvarint` 既不检查 32 位越界，也不检查是否最短编码，实现时要另外检查。
- **LPS**（length-prefixed slice）：`uvarint32 长度 ‖ 字节`。
- **maskedCRC32C(x)** = `rotr32(crc32c(x), 15) + 0xa282ead8`（模 2^32）。
  - crc32c 使用 Castagnoli 多项式（Go：`crc32.MakeTable(crc32.Castagnoli)`）。
  - 掩码与 LevelDB 相同（`leveldb/util/crc32c.h:22,31`）。
- **上下文校验和**（WAL / MANIFEST 的 chunk 和 SSTable 的块共用）：

  ```text
  base            = crc32c(dbID ‖ u64LE(fileNum))，结果为 0 时取 1
  modifier(b, o)  = b XOR (lo32(o) + hi32(o))           加法模 2^32
  ctxChecksum(x, o) = maskedCRC32C(x) + modifier(base, o)  模 2^32；o 为该 chunk 或块在文件中的起始偏移
  ```

  这里沿用 RocksDB format_version 6 的修正函数（`rocksdb/table/format.h:154-178`）。
  - 读错位置、混进别的文件、用户值里伪造的 chunk，都会因此校验失败。
  - 由于 base ≠ 0，RocksDB 里关掉修正的掩码在这里用不到。
- **魔数**：8 字节 ASCII，按字节写入，不当整数处理：`CairnWAL` / `CairnMAN` / `CairnSST`（SC-11）。
- **文件号**：全局单调递增的 uint64，WAL、SSTable、MANIFEST 共用一个计数器，永不复用（打开时的推进规则见 `durability.md` R7）。
  - 文件名中写成至少 6 位、左补零的十进制（`%06d`，超过 6 位时自然变宽）。
  - 新库固定为 `MANIFEST-000001`、首个 WAL `000002.wal`，`NextFileNumber = 3`。
- **错误分类**（SC-39）：结构不合法 ⇒ `ErrCorruption`；能识别、但本构建不支持 ⇒ `ErrUnsupported`。后者包括：更高的格式版本、预留的压缩类型、必须理解的自定义字段。

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
| 255（`KindSeek`） | 查找用 | 只能与 `seq = SeqMax` 组合，且只出现在查找目标和索引分隔键里 |

- **seq**（56 位）：0–9 保留；用户数据的序号 ∈ [10, 2^56 − 2]；`SeqMax = 2^56 − 1` 只作哨兵。v1 不做 SeqNumZero 优化。
- **合法内部键只有两类**，其他组合（含长度不足 8 字节）都是 `ErrCorruption`：
  - **数据键**：seq ∈ [10, 2^56 − 2] 且 kind ∈ {1, 2}。数据块、NewFile 的 smallest/largest 只能是数据键。
  - **查找键**：`(SeqMax, 255)`，只出现在索引块和查找目标里。
- **InternalCompare(a, b)**：先用 `Comparer.Compare` 比较用户键；相等时按 trailer **数值降序**。
  - 必须先把 trailer 解码成 uint64 再比较。如果对 8 个小端字节直接做字节序比较，不会报错，但点查会返回最旧的版本。
  - 「trailer 降序」是格式常量。
- **查找目标**：读快照序号 S 时，用 `user_key ‖ trailer(S, 255)`，它排在该用户键所有 `seq ≤ S` 的版本之前。
- 格式本身不限制用户键长度；API 限制为 64 KiB（SC-09）。

---

## 2. WAL 文件（`<编号>.wal`）

### 2.1 文件头（48 字节）

| 偏移 | 大小 | 字段 | 规则 |
|---|---|---|---|
| [0..8) | 8 | magic | `"CairnWAL"` |
| [8..10) | 2 | formatVersion | u16 = 1 |
| [10..12) | 2 | flags | u16 = 0 |
| [12..16) | 4 | blockSize | u32 = 32768 |
| [16..24) | 8 | fileNum | u64，等于文件名中的编号（I-3） |
| [24..40) | 16 | dbID | 等于 MANIFEST 记录的 dbID（I-3） |
| [40..44) | 4 | reserved | 0 |
| [44..48) | 4 | headerChecksum | `maskedCRC32C([0..44))`（文件头不加上下文修正） |

按以下顺序判定：

1. 文件短于 48 字节、全零，或魔数不是 `CairnWAL`（MANIFEST 是 `CairnMAN`）⇒ **文件头无效**，按 `durability.md` §8.3 处理（视为偏移 0 处无效）。
2. 魔数正确且 formatVersion > 1 ⇒ `ErrUnsupported`（先于校验和检查，因为新版本的头部布局可能不同）。
3. headerChecksum 错 ⇒ 文件头无效（同第 1 条）。
4. 校验和正确，但 formatVersion = 0、flags ≠ 0、blockSize ≠ 32768、reserved ≠ 0、fileNum 不符或 dbID 不符 ⇒ `ErrCorruption`。

### 2.2 物理块与 chunk（I-1）

文件按 32 KiB 分成物理块，块 k 从偏移 `k × 32768` 开始；块 0 的可用区域从偏移 48 开始。

**chunk 头（19 字节）**

| 偏移 | 大小 | 字段 | 规则 |
|---|---|---|---|
| [0..4) | 4 | checksum | `ctxChecksum(type ‖ logNum ‖ syncOffset ‖ payload, chunk 偏移)`（§0） |
| [4..6) | 2 | length | payload 字节数，≥ 1 |
| [6] | 1 | type | 1 = FULL，2 = FIRST，3 = MIDDLE，4 = LAST |
| [7..11) | 4 | logNum | 本文件文件号的低 32 位 |
| [11..19) | 8 | syncOffset | 写出该 chunk 时，本文件已确认 fsync 到的长度 |

**写入端规则**（决定字节，必须遵守）：

1. 每个 chunk 的 payload 长度 = `min(记录剩余字节, 块剩余空间 − 19)`，即尽量装满。
2. 写完一个 chunk 后，如果块剩余空间 < 20 字节，**立即**写零填满到块尾，与该 chunk 一起写出。因此块内剩余空间从不会只有 19 字节，也不存在 payload 为空的 chunk。
3. 不预先写出块内还没用到的零字节。
4. chunk 按文件顺序写出。syncOffset 取写出时的 `syncedOffset`（`durability.md` §5.3），必然 ≤ 该 chunk 的偏移，并且同一文件内单调不减。

**无效位置**：从某个偏移 p 开始解析时，满足下列任一条就是无效位置。遇到无效位置后怎么处理，见 `durability.md` §8.3。

- 块内剩余空间 < 20 字节，但这段剩余不全为零；
- 文件在 chunk 头中途或 payload 中途结束；
- chunk 头或 payload 越过块尾；
- type ∉ 1–4，或 length = 0；
- checksum 错，或 logNum 不符。

**结构错误**：checksum 正确的 chunk 满足下列任一条 ⇒ `ErrCorruption`，**不论它在文件的什么位置**。崩溃不会产生这类 chunk：v1 每个位置只写一次，checksum 又绑定了位置。

- syncOffset 大于本 chunk 的偏移，或比前一个有效 chunk 的 syncOffset 小；
- 片段顺序违反下面的状态机：
  - 「不在记录中」时只接受 FULL 或 FIRST；
  - 「在记录中」（读到 FIRST 之后、读到 LAST 之前）时只接受 MIDDLE 或 LAST。

一条逻辑记录 = 一个 FULL，或 FIRST + 若干 MIDDLE + LAST。

### 2.3 逻辑记录：一个批次一条

```text
[0..8)   base    u64   批次第一个操作的序号
[8..12)  count   u32   操作数，≥ 1
之后 count 个条目：
  kind      u8          1 = Set，2 = Delete（与内部键 kind 是同一个枚举）
  keyLen    uvarint32
  key       keyLen 字节
  valueLen  uvarint32   仅 Set
  value     valueLen 字节，仅 Set
```

- 第 i 个条目（从 0 起）的序号是 `base + i`。WAL 不存 trailer。
- 以下情况一律 `ErrCorruption`，不论在文件的什么位置：
  - 记录短于 12 字节；`count = 0`；kind 不是 1 或 2；
  - 长度字段超出剩余字节；解析完 `count` 个条目后还有剩余字节；
  - 序号越界：`base < 10`、`base > 2^56 − 2`，或 `count − 1 > 2^56 − 2 − base`。请按这种形式写，防止 uint64 回绕。

---

## 3. MANIFEST 文件（`MANIFEST-<编号>`）

- 文件头同 §2.1，魔数换成 `"CairnMAN"`，fileNum 是该 MANIFEST 自己的编号。
- chunk 格式同 §2.2：logNum 取 MANIFEST 自身文件号的低 32 位，base 由文件头中的 dbID 和 fileNum 派生。
- 每条逻辑记录是一个 VersionEdit。一条有效记录都没有的 MANIFEST ⇒ `ErrCorruption`。

### 3.1 VersionEdit 编码

VersionEdit 是一串 `tag ‖ 负载`，直到记录结束。tag 用 `uvarint32` 编码：

| tag | 名称 | 负载 |
|---|---|---|
| 1 | ComparatorName | LPS |
| 2 | LogNumber | uvarint64：仍需重放的最小 WAL 编号 |
| 3 | NextFileNumber | uvarint64 |
| 4 | LastSequence | uvarint64：写这条 edit 时的 `visibleSeq` |
| 5 | DeletedFile | `level uvarint32 ‖ fileNum uvarint64` |
| 6 | NewFile | §3.2 |
| 7 | DBID | 16 字节 |

**规范顺序**（写入端必须遵守，读取端检查，不符 ⇒ `ErrCorruption`）：

```text
[1 ComparatorName] [7 DBID]       仅首条快照，且两者都必须有
2 LogNumber  3 NextFileNumber  4 LastSequence     每条 edit 必有，各一次
5 DeletedFile*   按 (level, fileNum) 严格升序
6 NewFile*       按 (level, fileNum) 严格升序
```

- tag 为 0 或未知 ⇒ `ErrCorruption`。格式演进靠提升 store 格式版本，旧构建在打开阶段就会拒绝。
- **首条记录是快照**：用 NewFile 列出全部活文件，不得含 DeletedFile。之后的 edit 不得含 1、7。

**应用规则**（以下各条，不满足即 `ErrCorruption`）：

1. 同一条 edit 内先应用全部删除，再应用全部新增。
2. DeletedFile 的 `(level, fileNum)` 必须与当前版本中的某个文件精确匹配。
3. NewFile 的 fileNum < **本条 edit** 的 NextFileNumber，并且不得与应用删除后的版本中已有的文件号重复。
   - **唯一例外是平移**：同一条 edit 里删除 `(L₁, f)`、新增 `(L₂, f)`，要求 L₁ ≠ L₂，且 size、smallest、largest、smallestSeq、largestSeq 都与被删的那一项完全相同。
4. `level < 7`；LogNumber < NextFileNumber。
5. LogNumber、NextFileNumber、LastSequence 在相继的 edit 中不得减小。

v1 不持久化 CompactPointer。注意 tag 5–7 的含义与 LevelDB 不同（见 §8）。

### 3.2 NewFile 负载

```text
level        uvarint32
fileNum      uvarint64
size         uvarint64   文件字节数，打开时与 stat 比对
smallest     LPS         数据键（§1）
largest      LPS         数据键，InternalCompare(smallest, largest) ≤ 0
smallestSeq  uvarint64   ∈ [10, 2^56 − 2]
largestSeq   uvarint64   ≥ smallestSeq，且 ≤ 2^56 − 2
自定义字段    { customTag uvarint32 ‖ LPS }*，以单独一个 customTag = 1 结束（结束标记后面没有 LPS）
```

| customTag | 含义 |
|---|---|
| 0 | `ErrCorruption` |
| 1 | 结束标记 |
| 2–63 | 可安全忽略：跳过其 LPS |
| 64–127 | 必须理解；v1 一个都没定义，遇到 ⇒ `ErrUnsupported` |
| ≥ 128 | `ErrCorruption` |

- 同一个 customTag 在一个 NewFile 中重复出现 ⇒ `ErrCorruption`。
- 在 1–127 区间内，上表与 Pebble 的位 6 语义相同（`pebble/internal/manifest/version_edit.go:67-96`）。对 0 和 ≥ 128 我们更严格：Pebble 对它们同样按位 6 判断（`:545`）。
- v1 写入端只写结束标记。

---

## 4. 标记文件

- 文件名格式：`marker.<名称>.<迭代号>.<值>`。
  - 名称只有 `manifest` 和 `format-version`。
  - 迭代号：至少 6 位、补零的十进制，从 `000001` 开始，每次移动加 1。
  - 值：`manifest` 族为 `MANIFEST-<编号>`；`format-version` 族为十进制版本号。
- 内容：空文件。语义全在文件名里。
- 示例：`marker.manifest.000003.MANIFEST-000017`、`marker.format-version.000001.1`。
- 打开时如何解析见 `durability.md` R2–R3。

---

## 5. SSTable 文件（`<编号>.sst`）

### 5.1 总体布局

```text
[数据块 1] … [数据块 N]       N ≥ 1
[过滤器块]                     可选
[索引块]                       单级：1 块；两级：若干分区块，后跟 1 个顶层块
[属性块]
[metaindex 块]                 紧贴 footer
[footer 53 字节]
```

- 块与块之间紧挨着写，没有填充，也没有对齐要求。
- 空表不合法：写入端从不产生，读到 ⇒ `ErrCorruption`。
- 写入端要在内存里攒下全部索引分区，最后一起写出。

### 5.2 块、句柄与 trailer

- **块** = `data[n] ‖ type u8 ‖ checksum u32`。
  - data 是存储形式：压缩块存压缩后的字节，restart 数组也在压缩范围内。
  - checksum = `ctxChecksum(data ‖ type, data 的起始偏移)`（§0）。base 取 footer 的 `baseContextChecksum`。
  - checksum 不符 ⇒ `ErrCorruption`。
- **BlockHandle** = `offset uvarint64 ‖ size uvarint64`。
  - `size = n`，**不含** 5 字节 trailer。
  - 句柄指向的范围 `[offset, offset + size + 5)` 必须落在 metaindex 块起点之前（指向 metaindex 的那个除外），否则 `ErrCorruption`。
- **type**：

| type | 含义 | 规则 |
|---|---|---|
| 0 | 无压缩 | 所有块都可用 |
| 1 | Snappy | 只允许数据块使用；其他块出现 ⇒ `ErrCorruption` |
| 2 / 3 | Zstd / MinLZ，仅为 M5 对照实验预留 | v1 读到 ⇒ `ErrUnsupported` |
| 其他 | — | `ErrCorruption` |

- 块的原始（未压缩）大小 ≤ 1 GiB。

### 5.3 键值块编码（数据块、索引块、metaindex、属性块共用）

```text
entry = shared uvarint32 ‖ unshared uvarint32 ‖ valueLen uvarint32 ‖ keyDelta[unshared] ‖ value[valueLen]
block = entry+ ‖ restarts u32 × P ‖ P u32
```

- **写入端**：
  - `shared` 取当前键与前一个键的完整字节的**最长公共前缀**长度。
  - 每隔 `RestartInterval` 个条目设一个 restart 点，restart 点处 `shared = 0`，第一个条目一定是 restart 点。
  - RestartInterval：数据块取 `Options.RestartInterval`（默认 16）；索引块（各级）、metaindex、属性块固定为 1。
- **键序**：严格递增。数据块、索引块按 InternalCompare 比较；metaindex、属性块按名称的字节序比较。
- **读取端检查**（任一失败 ⇒ `ErrCorruption`）：
  - `n < 4`、`P = 0`、`4 + 4P > n`；
  - `restarts[0] ≠ 0`；restart 偏移不严格递增，或越过 restart 数组的起点；
  - 任一 restart 点上的条目 `shared ≠ 0`；
  - `shared` 大于前一个键的长度；
  - 长度字段越过数据区；没有条目；键不严格递增。
- 读取端不依赖 RestartInterval 的取值，只用 restart 数组。
- **切块规则**（写入端，数据块与索引分区共用）：
  - 估算大小 `est = 已写条目字节数 + 4 × P + 4`，P 计入刚追加的条目所新增的 restart 点。
  - 每追加一个条目后，`est ≥ 目标大小`（数据块为 `BlockSize`，索引分区为 `IndexBlockSize`）就结束当前块。
  - 一个大条目会让它所在的块直接超出目标。

### 5.4 数据块

- 键都是数据键（§1）。
- Set 的值是用户值；Delete 的 `valueLen` 必须为 0。

### 5.5 索引块

**条目**：键是分隔键；值是目标块的 BlockHandle，必须恰好被句柄编码用完。

**分隔键**的取法如下（a = 块 i 的末键，b = 块 i+1 的首键，ua、ub 是它们的用户键）。规则与 Pebble 相同（`pebble/internal/base/internal.go:457-491`）；LevelDB 还要求结果在物理上更短，我们**不要求**。

- 非最后一块：
  - 若 `ua = ub`（同一用户键的版本跨越了块边界），分隔键 = a。
  - 否则 `u = Comparer.Separator(ua, ub)`。若 `ua < u < ub`，分隔键 = `u ‖ trailer(SeqMax, 255)`；否则分隔键 = a。
- 最后一块：`u = Comparer.Successor(ua)`。若 `u > ua`，分隔键 = `u ‖ trailer(SeqMax, 255)`；否则分隔键 = a。
- Comparer 契约：`Separator(a, b)`（a < b）返回 x，满足 `a ≤ x < b`；`Successor(a)` 返回 x，满足 `x ≥ a`。写入端在使用结果前按上面的条件再检查一遍，不满足就退回用 a，所以比较器写错也不会产生错误的索引。
- 点查和 SeekGE 在块尾没找到时，继续读下一块。

**两级索引**：

- 按 §5.3 的切块规则，用 `IndexBlockSize`（默认 8 × BlockSize）切出分区块。
- 顶层块的条目：键 = 分区的最后一个分隔键，值 = 分区块的句柄。
- 结束时只有一个分区 ⇒ 写成单级索引。

**单级与两级的判定**（首次加载索引时检查，不符 ⇒ `ErrCorruption`）：

| 情形 | metaindex | `cairn.index-partitions` | 附加条件 |
|---|---|---|---|
| 单级 | `cairn.index` | 0 | — |
| 两级 | `cairn.index.top` | ≥ 2 | 等于顶层块的条目数 |

### 5.6 过滤器块（缓存行分块 Bloom）

位级规格与 Pebble 相同（`pebble/sstable/tablefilters/bloom/`），只有一处不同：**哈希尾部字节按无符号处理**，与现行 LevelDB 一致（`leveldb/util/hash.cc:38-50`）。照抄 Pebble 的 `hash()` 会得到带符号版本，必须改掉。§9.0 给出了测试向量。

```text
hash32(key)：所有运算模 2^32，m = 0xc6a4a793
  h = 0xbc9f1d34 XOR (len(key) × m)
  对每个完整的 4 字节组（小端 u32 w）：h += w；h *= m；h ^= h >> 16
  r = 剩余字节数（0–3），b 为剩余字节（按无符号取值）：
    r = 3：h += b[2] << 16；h += b[1] << 8；h += b[0]；h *= m；h ^= h >> 24
    r = 2：h += b[1] << 8；h += b[0]；h *= m；h ^= h >> 24
    r = 1：h += b[0]；h *= m；h ^= h >> 24
    r = 0：不做任何事（最后的乘法与移位只在 r ≥ 1 时执行）

输入：表中每个**不同的用户键**按出现顺序求 hash32，相邻相同的哈希只算一次，共 n 个
bitsPerKey = Options.FilterBitsPerKey（默认 10）；n = 0 或 bitsPerKey < 2 ⇒ 不写过滤器
k    = [1,1,2,3,3,4,4,5,5,6][min(bitsPerKey, 10) − 1]
rows = ((n × bitsPerKey + 511) / 512) | 1              按 64 位整数计算，结果为奇数
块内容 = bits[rows × 64] ‖ k u8 ‖ rows u32

对每个 h 置位：
  row = h mod rows；delta = rotr32(h, 17)
  重复 k 次：bit = h & 511；bits[row × 64 + (bit >> 3)] |= 1 << (bit & 7)；h += delta
查询：用同样的步骤；只要有一位为 0，就说明键一定不在这个表中
```

- 过滤器块不压缩（type = 0），照常带 trailer。
- 读取端检查（任一失败 ⇒ `ErrCorruption`）：块长 < 5；`rows = 0`；`k ∉ [1, 30]`；`(块长 − 5) ≠ rows × 64`。乘法用 64 位计算。
- 过滤器给出「不存在」时，跳过这个表；过滤器缺失、或 family 不认识时，退回读索引和数据块。

### 5.7 属性块

按 §5.3 编码，键是属性名，按字节序升序。每个值必须恰好被它的编码用完，否则 `ErrCorruption`。

| 名称 | 值编码 | 打开时检查 |
|---|---|---|
| `cairn.block-size` | uvarint64 | 只记录 |
| `cairn.comparator` | 字节串 | 必须等于 MANIFEST 中的比较器名，否则 `ErrCorruption`（比较器与 Options 是否一致，在 R5 已用 `ErrInvalidOptions` 检查过） |
| `cairn.compression` | 字节串：`snappy` / `none` | 只记录（块的 type 字节才是权威） |
| `cairn.db-id` | 16 字节 | 必须等于 MANIFEST 的 dbID，否则 `ErrCorruption` |
| `cairn.file-num` | uvarint64 | 必须等于文件名中的编号，否则 `ErrCorruption` |
| `cairn.filter` | 字节串：`bloom` / `none` | 只记录 |
| `cairn.format-version` | uvarint64 | 必须等于 footer 中的值，否则 `ErrCorruption` |
| `cairn.index-partitions` | uvarint64 | 见 §5.5 |
| `cairn.internal-key-version` | uvarint64 | 0 ⇒ `ErrCorruption`；> 1 ⇒ `ErrUnsupported` |
| `cairn.num-data-blocks` | uvarint64 | 只记录 |
| `cairn.num-entries` | uvarint64 | 只记录 |
| `cairn.restart-interval` | uvarint64 | 只记录 |

- 上表各项都必需，缺失 ⇒ `ErrCorruption`；不认识的属性名一律忽略。
- **格式参数由文件自带**（SC-44，作者 2026-10-29 确认）：块大小、restart 间隔、压缩方式都只是这个文件自己的记录。改 `Options` 只影响新写的文件，旧文件照常可读，由后台合并逐步重写。

### 5.8 metaindex 块

按 §5.3 编码，键是名称，按字节序升序；值是 BlockHandle，必须恰好被句柄编码用完。

| 名称 | 指向 | 出现 |
|---|---|---|
| `cairn.filter.bloom` | 过滤器块 | 可选 |
| `cairn.index` | 单级索引块 | 与下一项恰好出现一个 |
| `cairn.index.top` | 两级索引的顶层块 | 同上 |
| `cairn.properties` | 属性块 | 必需 |

- `cairn.index` 和 `cairn.index.top` 都出现或都不出现 ⇒ `ErrCorruption`。
- 其他 `cairn.filter.<family>` 当作不认识的过滤器，忽略；其他不认识的名称也忽略。

### 5.9 Footer（53 字节）

| 偏移 | 大小 | 字段 | 规则 |
|---|---|---|---|
| [0] | 1 | checksumType | = 1，否则 `ErrCorruption` |
| [1..5) | 4 | footerChecksum | `maskedCRC32C(整个 footer，本字段置零) + modifier(base, footerOffset)` |
| [5..9) | 4 | baseContextChecksum | ≠ 0 |
| [9..13) | 4 | metaindexSize | metaindex 块 data 的字节数，**不含** trailer |
| [13..41) | 28 | reserved | 全零，否则 `ErrCorruption` |
| [41..45) | 4 | formatVersion | u32 = 1；更高 ⇒ `ErrUnsupported`；0 ⇒ `ErrCorruption` |
| [45..53) | 8 | magic | `"CairnSST"`，否则 `ErrCorruption` |

- 偏移计算：
  - `footerOffset = 文件长度 − 53`；
  - metaindex 的 data 从 `footerOffset − 5 − metaindexSize` 开始；
  - 文件短于 53 字节，或这个减法会下溢 ⇒ `ErrCorruption`。
  - 校验和算法与 RocksDB format_version 6 相同（`rocksdb/table/format.cc:362-382,496-521`）。
- **打开顺序**（检查顺序与 RocksDB 一致，所以 formatVersion 字段的位翻转会报成 `ErrUnsupported`）：
  1. 读最后 53 字节：魔数 → formatVersion → checksumType → reserved → footerChecksum → base ≠ 0。
  2. 读 metaindex，校验它的 trailer。
  3. 读属性块，校验它的 trailer。
  4. 核对 dbID、fileNum，以及 `base = derive(dbID, fileNum)`。
  5. 按 metaindex 定位索引和过滤器。

### 5.10 压缩

- 只有数据块可以压缩。
- **写入端**：用 `klauspost/compress` 的 `s2.EncodeSnappy` 生成标准 Snappy 块。只有 `len(压缩后) × 100 ≤ len(原始) × 88` 时才采用压缩结果，否则存原始数据，type 写 0。这是整数比较，与 Pebble 的默认 12% 等价（`pebble/sstable/block/compressor.go:82-92`、`compression.go:146`）。
- **压缩后的字节不属于规范**：不同编码器、不同版本的输出可以不同，跨实现只要求能互相解码。所以 golden 样例只用 type = 0，压缩阈值单独用 `(原始, 压缩后)` 长度向量来测。
- **读取端**：用 `s2.Decode`，它能解码标准 Snappy 块。下列情况 ⇒ `ErrCorruption`，不得 panic：Snappy 头声明的解压长度 > 1 GiB；解压失败；解压后长度与声明不符。
- 块缓存里存放解压后的块。

---

## 6. 数据目录

```text
<data-dir>/
├── LOCK                                      进程独占（flock，非阻塞）；空文件，不 fsync
├── marker.format-version.<迭代号>.<版本>
├── marker.manifest.<迭代号>.MANIFEST-<编号>   当前 MANIFEST（取代 CURRENT）
├── MANIFEST-<编号>
├── <编号>.wal
└── <编号>.sst
```

- **CairnKV 文件名模式**：
  - `^\d{6,}\.(wal|sst|tmp)$`
  - `^\d{6,}\.sst\.orphan$`（被隔离的孤儿表，见 `durability.md` R12；引擎从不自动删除）
  - `^MANIFEST-\d{6,}$`
  - `^marker\.`
  - `LOCK`
- 不符合上述模式的文件，引擎一律不读、不删。
- v1 不产生 `*.tmp`；打开时如果发现，在 R12 删除。
- 计算文件号最大值时（`durability.md` R7），孤儿表也算在内。

---

## 7. 版本边界

一共三个版本号：

- **store 格式版本**：总开关，记在标记文件里；
- **WAL / MANIFEST 文件头的 formatVersion**；
- **SSTable footer 的 formatVersion**。

| 改动 | 需要提升 |
|---|---|
| 块条目编码、trailer 布局、footer 字段、校验和算法、索引项编码 | SSTable formatVersion 与 store 版本 |
| 过滤器分区、字典压缩 | 同上 |
| 新的压缩类型投入写入 | store 版本 |
| 文件头字段、chunk 格式、逻辑记录编码、新的 VersionEdit tag | WAL/MANIFEST formatVersion 与 store 版本 |
| 新的 kind | store 版本与 `cairn.internal-key-version`（同时出现在 WAL 和 SSTable 中） |
| 「必须理解」的 NewFile 自定义字段（64–127） | 旧构建读到就拒绝；仍应同时提升 store 版本，让旧构建在打开阶段就报错 |
| 可忽略的自定义字段、新的可选属性、新的可选 metaindex 条目 | 不需要 |
| 块大小、restart 间隔、单级 ↔ 两级索引、写不写过滤器 | 不需要（结构自描述） |

- SSTable formatVersion = 2 预留给列式块，目前未分配；同一个版本号内不得混用两种块布局。
- 不做原地迁移。旧版本文件由后台合并重写。

---

## 8. 与研究文档、LevelDB、Pebble 的差异（照抄会写错的地方）

被本文取代的研究条目，见 `docs/spec-closure.md` §5。

- WAL chunk 头是 19 字节，不是 LevelDB 的 7 字节。chunk 校验和带上下文修正：读到错误位置的数据就会校验失败。
- WAL 条目的 tag 就是内部键的 kind：`1 = Set`、`2 = Delete`，没有 `0 = Delete`。
- VersionEdit 的 tag 是 CairnKV 自定的：5 = DeletedFile、6 = NewFile、7 = DBID。LevelDB 中 5 = CompactPointer、6 = DeletedFile、7 = NewFile。
- footer 采用 RocksDB v6 式的 53 字节，所有句柄都在 metaindex 中，footer 里没有句柄。
- 魔数是 ASCII 字节，不是 64 位整数。
- 分隔键不要求比原键短（与 LevelDB 不同，与 Pebble 相同）。
- Bloom 哈希的尾部字节按无符号处理（与 LevelDB 相同，与 Pebble 不同）。

---

## 9. 样例

**公共输入**：dbID = `00 01 02 … 0f`；WAL 的 syncOffset 为 0。各样例的 fileNum 在样例里单独给出。

### 9.0 基础向量（独立脚本算出）

| 输入 | 结果 |
|---|---|
| `crc32c("123456789")` | `0xe3069283`；masked 后为 `0xc78ab0e5` |
| `crc32c("")` | `0x00000000`；masked 后为 `0xa282ead8` |
| `hash32("")` | `0xbc9f1d34` |
| `hash32("a")` | `0x286e9db0` |
| `hash32("abcd")` | `0xb9c83353`（r = 0，不做最后的混合） |
| `hash32("\x80")` | `0x365ee853`（按无符号；照抄 Pebble 会得到 `0x91b755f4`） |
| `hash32("ab\xff")` | `0xa2f10108` |
| `hash32("hello world")` | `0x008dfddb` |
| `modifier(0x12345678, 48)` | `0x12345648` |
| `modifier(0x12345678, 2^32 + 5)` | `0x1234567e` |
| `derive(dbID, 2)` | `0x5c9e2bcc` |
| `uvarint32` 的非最短编码 `80 00` | `ErrCorruption` |

### 9.1 新库的 WAL `000002.wal`：文件头 + 一个 FULL chunk（批次 base = 10，Set `"a"` → `"1"`）

```hex
0000: 43 61 69 72 6e 57 41 4c 01 00 00 00 00 80 00 00
0010: 02 00 00 00 00 00 00 00 00 01 02 03 04 05 06 07
0020: 08 09 0a 0b 0c 0d 0e 0f 00 00 00 00 56 9a 86 dc
0030: ca 56 a3 04 11 00 01 02 00 00 00 00 00 00 00 00
0040: 00 00 00 0a 00 00 00 00 00 00 00 01 00 00 00 01
0050: 01 61 01 31
```

逐字段说明：

| 偏移 | 字节 | 字段 |
|---|---|---|
| 0x00 | `43 61 69 72 6e 57 41 4c` | 魔数 `CairnWAL` |
| 0x08 | `01 00` | formatVersion = 1 |
| 0x0a | `00 00` | flags = 0 |
| 0x0c | `00 80 00 00` | blockSize = 32768 |
| 0x10 | `02 00 00 00 00 00 00 00` | fileNum = 2 |
| 0x18 | `00 01 … 0f` | dbID |
| 0x28 | `00 00 00 00` | reserved |
| 0x2c | `56 9a 86 dc` | headerChecksum |
| 0x30 | `ca 56 a3 04` | chunk checksum = `0x04a356ca`（含 `modifier(0x5c9e2bcc, 48)`） |
| 0x34 | `11 00` | length = 17 |
| 0x36 | `01` | type = FULL |
| 0x37 | `02 00 00 00` | logNum = 2 |
| 0x3b | `00 00 00 00 00 00 00 00` | syncOffset = 0 |
| 0x43 | `0a 00 00 00 00 00 00 00` | base = 10 |
| 0x4b | `01 00 00 00` | count = 1 |
| 0x4f | `01` | kind = Set |
| 0x50 | `01 61` | keyLen = 1，key = `"a"` |
| 0x52 | `01 31` | valueLen = 1，value = `"1"` |

### 9.2 待补（M1 / M2 由编码器生成，再与独立脚本交叉核对）

| # | 内容 | 用来固定的分歧点 |
|---|---|---|
| 9.2.1 | 跨块的 WAL 记录。两个变体：块尾恰好剩 19 字节（必须补零）、恰好剩 20 字节（写一个 1 字节 payload 的 FIRST）。记录中含 Delete 条目和 ≥ 128 字节的值 | 装满、即时补零、多字节 varint |
| 9.2.2 | MANIFEST：快照里至少有 2 个分属不同 level 的 NewFile，后面跟一条同时含 DeletedFile 和 NewFile 的 edit | tag 顺序、文件排序、结束标记 |
| 9.2.3 | 数据块，RestartInterval = 2：同一用户键的两个版本，外加一个 Delete | restart 数组、trailer 降序、延伸进 trailer 的 shared |
| 9.2.4 | 索引块，覆盖四种分隔键：`"abc"/"abz"` → `"abd"`；不缩短（退回用 a）；跨块的同一用户键；末块用 Successor（`"c"` → `"d"`） | 分隔键规则 |
| 9.2.5 | n = 3、bitsPerKey = 10 的过滤器块（rows = 1，共 69 字节） | 哈希、置位、尾部布局 |
| 9.2.6 | 最小完整 SSTable（全部 type = 0），以及调小 IndexBlockSize 后的两级索引小例 | 块顺序、句柄、base、footer、metaindex 位置 |
| 9.2.7 | 压缩阈值向量：(100, 88) 采用压缩；(100, 89) 不采用 | 整数阈值 |

样例写成 ```` ```hex ```` 代码块并附逐字段说明。测试会解析这些代码块，断言编码器输出逐字节一致、解码器能还原出说明中的各字段值。
