// 学习清单组件：带勾选状态的步骤清单，勾选结果按页面保存在浏览器本地（localStorage）。
// 用法：
// <ol class="checklist" data-key="0001">
//   <li><label><input type="checkbox"> 步骤说明</label></li> ...
// </ol>
// data-key 用来区分不同课的清单；同一页可以有多个清单，用不同的 key。
(function () {
  /** 读取本地保存的勾选状态；存储不可用时返回空对象，组件照常工作只是不记忆。 */
  function load(key) {
    try { return JSON.parse(localStorage.getItem("checklist:" + key) || "{}"); }
    catch (e) { return {}; }
  }

  /** 保存勾选状态；失败（隐私模式等）时静默忽略。 */
  function save(key, state) {
    try { localStorage.setItem("checklist:" + key, JSON.stringify(state)); }
    catch (e) { /* 不记忆也不影响使用 */ }
  }

  function init() {
    document.querySelectorAll(".checklist[data-key]").forEach((list) => {
      const key = list.dataset.key;
      const state = load(key);
      const boxes = Array.from(list.querySelectorAll('input[type="checkbox"]'));
      const progress = document.createElement("div");
      progress.className = "checklist-progress";
      list.after(progress);

      /** 刷新"已完成 x / n"进度文字。 */
      function render() {
        const done = boxes.filter((b) => b.checked).length;
        progress.textContent = `已完成 ${done} / ${boxes.length}`;
      }

      boxes.forEach((box, i) => {
        box.checked = !!state[i];
        box.addEventListener("change", () => {
          state[i] = box.checked;
          save(key, state);
          render();
        });
      });
      render();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
