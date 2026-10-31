// 步骤排序组件：点击步骤按顺序排出协议，检查"先后约束"并逐条给出崩溃后果。
// 用法：
// <div class="seq" data-config='{"steps":[{"id":"w","label":"write(tmp)"},...],
//      "rules":[{"before":"w","after":"s","msg":"违反时的后果"}],
//      "success":"全部正确时的说明"}'></div>
// steps 会被打乱显示；rules 中的每一条都要求 before 出现在 after 之前。
(function () {
  function shuffle(a) {
    const b = a.slice();
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  }

  function mount(root) {
    const cfg = JSON.parse(root.dataset.config);
    root.innerHTML = `
      <div class="hint">点击下方步骤，按执行顺序排列（再次点击可撤回）：</div>
      <div class="picked" aria-label="已排列"></div>
      <div class="pool" aria-label="待选步骤"></div>
      <div class="actions">
        <button type="button" class="check">检查顺序</button>
        <button type="button" class="ghost reset">重来</button>
      </div>
      <div class="feedback" aria-live="polite"></div>`;
    const pool = root.querySelector(".pool");
    const picked = root.querySelector(".picked");
    const feedback = root.querySelector(".feedback");

    function chip(step) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "chip";
      el.textContent = step.label;
      el.dataset.id = step.id;
      el.addEventListener("click", () => {
        (el.parentElement === pool ? picked : pool).appendChild(el);
        feedback.innerHTML = "";
      });
      return el;
    }

    function reset() {
      pool.innerHTML = "";
      picked.innerHTML = "";
      feedback.innerHTML = "";
      shuffle(cfg.steps).forEach((s) => pool.appendChild(chip(s)));
    }

    root.querySelector(".reset").addEventListener("click", reset);
    root.querySelector(".check").addEventListener("click", () => {
      const order = Array.from(picked.children).map((c) => c.dataset.id);
      if (order.length < cfg.steps.length) {
        feedback.innerHTML = `<span class="badmsg">还有 ${cfg.steps.length - order.length} 个步骤没排。</span>`;
        return;
      }
      const pos = Object.fromEntries(order.map((id, i) => [id, i]));
      const broken = cfg.rules.filter((r) => pos[r.before] > pos[r.after]);
      if (broken.length === 0) {
        feedback.innerHTML = `<span class="okmsg">✓ 顺序正确。</span> ${cfg.success || ""}`;
      } else {
        feedback.innerHTML = broken.map((r) => `<div class="badmsg">✗ ${r.msg}</div>`).join("");
      }
    });
    reset();
  }

  function init() {
    document.querySelectorAll(".seq[data-config]").forEach(mount);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
