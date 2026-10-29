# CairnKV 研究交付文档（docs/research/）

> **本目录是什么**：CairnKV 设计研究循环（autoresearch）的三份**交付文档**的受版本管理副本。
> 它们由补充轮结束、作者确认 C 类需求变更后，从 git-ignored 的 `.autoresearch/` 目录提升而来，
> 目的是防止误删丢失（`.autoresearch/` 不受版本管理）。
>
> **源文件**：`.autoresearch/DELIVERABLE-01/02/03-*.md`（工作副本；本目录副本与其逐字节一致）。
> **完整的迭代台账与全部证据**（21+5 份迭代工件、独立核验报告、仲裁记录、一手源码钉版）仍在
> `.autoresearch/` 内，**未**随本目录提升。
>
> **2026-10-29 起**：三份交付文档中与 `docs/spec-closure.md`（规格收口决议）冲突的条目以该决议为准，
> 被取代的条目清单见其 §5。三份文档本身保持原样，不做修改。

## 文件清单

| 文件 | 行数 | 内容 |
|---|---|---|
| `DELIVERABLE-01-lsm-theory.md` | 3886 | LSM 理论综述与 2020s 进展地图（含证据强度分级与诚实清单） |
| `DELIVERABLE-02-design-decisions.md` | 1532 | 逐项设计决策书（结论 / 候选 / 证据 / 代价 / 相对草案 v0.1 的差异 / 开放项） |
| `DELIVERABLE-03-implementation-plan.md` | 672 | 实现计划 M0–M5、接口草案、参数默认值表、测试金字塔、风险登记表 |

## 来源与状态（2026-09-29）

- **主轮**：iter 0–20（5 条并行 lane 研究 + 主代理仲裁 + 独立引用核验），门禁 20/20。
- **补充轮**：iter 21–25（Gap 1 自适应合并首次调研 / Gap 2 L0 子层量化 / Gap 3 准入控制 / 源码侧与网络侧证据收口），
  门禁 **25/25 PASS**，穷尽引用扫描 **0 处不存在**（`third_party/` 六仓库：pebble/badger/goleveldb/bbolt/leveldb/rocksdb）。
- **作者确认（2026-09-29）**：C-1 `C-01`↔`C-06` 优先级互换（leveled 升 M）、C-2 `S-07` 压缩升 M（默认 Snappy）、
  C-3 `N-06` 实现位置移至网络层——三项均已确认接受；草案需求表由作者自行修订（研究循环不改 `docs/` 草案）。
- **仍开放**：U-7 / U-8 / U-11 / U-13 / U-15（未核验，等引擎或上游），V-13（准入控制重新评估，触发条件见 `DELIVERABLE-02` §17）。
  （2026-10-29：U-11 以定义关闭、U-15 以收窄承诺关闭，见 `docs/spec-closure.md` §4。）

## 如何复核（在工作副本上执行）

```bash
cd <仓库根>
python3 .autoresearch/tools/scan_refs.py --exclude-report  # 期望 exit=0（全部代码引用真实存在）
bash .autoresearch/autoresearch.sh check                   # 期望 PASS（25/25）
bash .autoresearch/finalize.sh verify-files                # 期望缺失 0 项
```

> ⚠️ 三份文档内的 `<repo>/<path>:<line> @ <commit>` 引用均指向 `.autoresearch/third_party/` 的钉版浅克隆
> （commit 见 `.autoresearch/third_party/PINS.md`）；离开该目录后行号不可复核。
