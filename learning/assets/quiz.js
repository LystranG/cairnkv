// 测验组件：即时反馈的单选题。
// 用法：
// <div class="quiz" data-answer="c">
//   <p class="q">题干</p>
//   <div class="opts">
//     <button class="opt" data-k="a">选项</button> ...
//   </div>
//   <div class="why" hidden>答对/答错后显示的解释</div>
// </div>
// 页面内可放 <p class="quiz-score"></p> 显示总分（首次作答计分）。
(function () {
  function init() {
    const quizzes = Array.from(document.querySelectorAll(".quiz"));
    const scoreEl = document.querySelector(".quiz-score");
    let answered = 0, correct = 0;

    function renderScore() {
      if (!scoreEl) return;
      scoreEl.textContent = `首次作答得分：${correct} / ${answered}（共 ${quizzes.length} 题）`;
    }

    quizzes.forEach((quiz) => {
      const answer = quiz.dataset.answer;
      const why = quiz.querySelector(".why");
      const opts = Array.from(quiz.querySelectorAll("button.opt"));
      let first = true;

      opts.forEach((btn) => {
        btn.type = "button";
        btn.addEventListener("click", () => {
          const ok = btn.dataset.k === answer;
          if (first) {
            answered++;
            if (ok) correct++;
            first = false;
            renderScore();
          }
          if (ok) {
            btn.classList.add("correct");
            opts.forEach((b) => (b.disabled = true));
            if (why) why.hidden = false;
          } else {
            btn.classList.add("wrong");
            btn.disabled = true;
          }
        });
      });
    });
    renderScore();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
