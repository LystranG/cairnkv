# 存储引擎前置知识 Resources

## Knowledge

### 存储与文件系统（§2.1）
- [Book: OSTEP, Arpaci-Dusseau（免费）](https://pages.cs.wisc.edu/~remzi/OSTEP/)
  持久化部分是 §2.1 的主教材。用户手上是**中文版《操作系统导论》（人民邮电出版社）**，课程一律按中文版章节号 + 章节名引用（不写页码）。
  - **中英章节号不一致**：中文版基于较早的英文版，第 39 章少一节。中文 §39.6 用 fsync()立即写入、§39.7 文件重命名
    = 英文 v1.10 的 §39.7、§39.8。第 44 章起也不同：中文第 44 章是"数据完整性和保护"，英文 v1.10 第 44 章是 Flash SSD（中文版无此章）。
  - 已核对的中文版持久化章节：38 RAID · 39 插叙：文件和目录· 40 文件系统实现 · 41 局部性和快速文件系统 ·
    42 崩溃一致性：FSCK 和日志（42.1 例子、42.2 FSCK、42.3 日志、42.4 其他方法）· 43 日志结构文件系统 · 44 数据完整性和保护
  - 中文分章 PDF（作者网站）：https://pages.cs.wisc.edu/~remzi/OSTEP/Chinese/39.pdf、…/Chinese/42.pdf
  - 英文 PDF：https://pages.cs.wisc.edu/~remzi/OSTEP/file-intro.pdf（ch39）、…/file-journaling.pdf（ch42）
  - 中文版缺的一章：**Flash-based SSDs**（英文 v1.10 第 44 章）https://pages.cs.wisc.edu/~remzi/OSTEP/file-ssd.pdf
  - 作业模拟器：https://github.com/remzi-arpacidusseau/ostep-homework （file-disks/disk.py、file-implementation/vsfs.py、
    file-journaling/fsck.py、file-lfs/lfs.py、file-integrity/checksum.py、file-ssd/ssd.py）。中文版第 42–44 章书中无作业，用这里的英文 README
  - 重读计划：`reference/ostep-persistence-reading-plan.html`（第 35–45 章 + SSD；分布式第 46–50 章不读，NFS 48.7/48.11 留到 M4）
- [Paper: Pillai et al., *All File Systems Are Not Created Equal*, OSDI 2014](https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-pillai.pdf)
  用 BOB/ALICE 实测 6 个 Linux 文件系统的"持久化属性"，在 11 个应用中发现 60 个崩溃漏洞（含 LevelDB）。Use for: 文件系统差异、追加/rename 的重排序。
- [Article: Dan Luu, "Files are hard"](https://danluu.com/file-consistency/)
  Pillai 论文与 fsync 错误研究的通俗综述。Use for: 先读它再读论文；data=ordered/writeback 的直觉。
- [Article: LWN, "PostgreSQL's fsync() surprise" (Corbet, 2018)](https://lwn.net/Articles/752063/)
  fsyncgate：写回失败后页面被标记为 clean，再次 fsync 返回成功。Use for: V-04 毒化状态机的动机。
- [Paper: Rebello et al., *Can Applications Recover from fsync Failures?*, ATC 2020 / TOS 2021](https://doi.org/10.1145/3450338)
  Use for: fsync 失败后各文件系统与应用的行为（第 3 课以后）。

### LSM 核心（§2.2）
- Book: Alex Petrov, *Database Internals*（O'Reilly 2019）第 1 部分。Use for: LSM 结构、SSTable、合并（付费书）。
- Book: Kleppmann, *Designing Data-Intensive Applications* 第 3 章。Use for: 从日志到 SSTable/LSM 的入门直觉。
- 本地一手规范（已钉版，见 `.autoresearch/third_party/PINS.md`）：
  `leveldb/doc/impl.md`、`doc/log_format.md`、`doc/table_format.md`。Use for: WAL 与 SSTable 格式的权威定义。
- [RocksDB wiki](https://github.com/facebook/rocksdb/wiki/)：Leveled-Compaction、Universal-Compaction、Write-Stalls。

### 源码（本地钉版）
- `leveldb/util/env_posix.cc`：`SyncDirIfManifest`、`SyncFd`（macOS `F_FULLFSYNC` 回退）。Use for: 第 1–2 课的"代码证据"。
- `badger/dir_unix.go`：`syncDir` 及其注释（引 etcd#6368）。
- `pebble/vfs/`、`pebble/vfs/atomicfs/marker.go`、`pebble/vfs/errorfs/`。

### 仓库内（结论与证据）
- `docs/research/DELIVERABLE-02-design-decisions.md` §9.3（目录 fsync）、§9.5（毒化）
- `.autoresearch/work/iter-15-manifest-versioning.md`（D1–D6 目录 fsync 调用点表）

## Wisdom (Communities)
- [r/databasedevelopment](https://www.reddit.com/r/databasedevelopment/)
  Phil Eaton 运营的存储/数据库内核子版块（1 万+ 成员）。Use for: 设计取舍提问、分享 CairnKV 进展。
- [Software Internals Discord](https://eatonphil.com/discord.html)
  数据库与分布式系统开发者聚集地（约 9k 成员），有读书会。Use for: 实时讨论、找人 review 崩溃一致性方案。

## Gaps
- APFS / macOS 上目录 fsync 与 `F_FULLFSYNC` 的一手文档（Apple 官方 man page 之外）尚未收录
- overlayfs / tmpfs / NFS 上目录 fsync 行为（仓库 U-15，未测）
