// Fixture B behavior: nested nav, loading spinner, confirmation dialog, and an
// in-memory rule list. Client-side only; no network, no real auth.
(function () {
  const rules = [];
  const spinner = document.getElementById("spinner");
  const panel = document.getElementById("nat-panel");
  const dialog = document.getElementById("confirm");
  const list = document.getElementById("rules");

  function showNat() {
    spinner.classList.add("on");
    panel.classList.add("hidden");
    // Artificial loading delay before the NAT panel appears.
    setTimeout(function () {
      spinner.classList.remove("on");
      panel.classList.remove("hidden");
    }, 400);
  }

  function route() {
    if (location.hash === "#/advanced/nat") showNat();
    else panel.classList.add("hidden");
  }
  window.addEventListener("hashchange", route);
  route();

  document.getElementById("z91k-ap").addEventListener("click", function () {
    dialog.showModal();
  });
  document.getElementById("confirm-no").addEventListener("click", function () {
    dialog.close();
  });
  document.getElementById("confirm-yes").addEventListener("click", function () {
    rules.push({
      name: document.getElementById("z91k-nm").value,
      ext: document.getElementById("z91k-ep").value,
      ip: document.getElementById("z91k-ip").value,
      intp: document.getElementById("z91k-lp").value,
      proto: document.getElementById("z91k-pr").value,
    });
    const li = document.createElement("li");
    li.setAttribute("data-rule-name", rules[rules.length - 1].name);
    li.textContent = rules[rules.length - 1].name;
    list.appendChild(li);
    dialog.close();
  });
})();
