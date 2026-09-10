// Fixture A behavior. Purely client-side; no network, no real auth. Keeps an
// in-memory rule table so find/verify workflows have something to check.
(function () {
  const rules = [];
  const tbody = document.getElementById("rules");
  const status = document.getElementById("rule-status");

  function render() {
    tbody.innerHTML = "";
    for (const r of rules) {
      const tr = document.createElement("tr");
      tr.setAttribute("data-rule-name", r.name);
      tr.innerHTML =
        `<td>${r.name}</td><td>${r.ext}</td>` +
        `<td>${r.ip}:${r.intp}</td><td>${r.proto}</td>`;
      tbody.appendChild(tr);
    }
  }

  document.getElementById("save-btn").addEventListener("click", function () {
    rules.push({
      name: document.getElementById("rule-name").value,
      ext: document.getElementById("ext-port").value,
      ip: document.getElementById("int-ip").value,
      intp: document.getElementById("int-port").value,
      proto: document.getElementById("protocol").value,
    });
    status.hidden = false;
    render();
  });
})();
