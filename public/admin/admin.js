(function () {
  var KEY = "gp-admin-key";
  var statusEl = document.getElementById("status");

  // Fill in the current host wherever the guide references it.
  document.querySelectorAll(".host").forEach(function (el) {
    el.textContent = location.host;
  });

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: {
        "Authorization": "Bearer " + sessionStorage.getItem(KEY),
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 401) {
        sessionStorage.removeItem(KEY);
        show(false);
        throw new Error("Invalid admin key.");
      }
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
        return data;
      });
    });
  }

  function setStatus(msg, isError) {
    statusEl.textContent = msg || "";
    statusEl.className = isError ? "danger" : "muted";
  }

  function show(loggedIn) {
    document.getElementById("login-box").classList.toggle("hidden", loggedIn);
    document.getElementById("app").classList.toggle("hidden", !loggedIn);
  }

  function fmtDate(iso) {
    return iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "";
  }

  function copyBtn(text) {
    var b = document.createElement("button");
    b.textContent = "Copy";
    b.addEventListener("click", function () {
      navigator.clipboard.writeText(text).then(function () {
        b.textContent = "Copied!";
        setTimeout(function () { b.textContent = "Copy"; }, 1500);
      });
    });
    return b;
  }

  function refresh() {
    return api("GET", "/admin/api/tokens").then(function (tokens) {
      var tbody = document.getElementById("rows");
      tbody.textContent = "";
      tokens.forEach(function (t) {
        var tr = document.createElement("tr");

        var tdLabel = document.createElement("td");
        tdLabel.textContent = t.label || "(no label)";

        var tdToken = document.createElement("td");
        var code = document.createElement("code");
        code.textContent = t.prefix + "…";
        tdToken.appendChild(code);

        var tdCreated = document.createElement("td");
        tdCreated.textContent = fmtDate(t.created);

        var tdLastUsed = document.createElement("td");
        tdLastUsed.textContent = t.lastUsed ? fmtDate(t.lastUsed) : "never";

        // Downloads are approximate (KV last-write-wins on concurrent updates).
        var tdDownloads = document.createElement("td");
        tdDownloads.textContent = t.downloads == null ? "never" : String(t.downloads);

        var tdActions = document.createElement("td");
        var del = document.createElement("button");
        del.textContent = "Revoke";
        del.className = "danger";
        del.addEventListener("click", function () {
          if (!confirm('Revoke "' + (t.label || t.prefix) + '"? Sites using it lose access immediately.')) return;
          api("DELETE", "/admin/api/tokens/" + t.id)
            .then(refresh)
            .then(function () { setStatus("Token revoked."); })
            .catch(function (e) { setStatus(e.message, true); });
        });
        tdActions.appendChild(del);

        tr.appendChild(tdLabel);
        tr.appendChild(tdToken);
        tr.appendChild(tdCreated);
        tr.appendChild(tdLastUsed);
        tr.appendChild(tdDownloads);
        tr.appendChild(tdActions);
        tbody.appendChild(tr);
      });
      if (tokens.length === 0) {
        var tr = document.createElement("tr");
        var td = document.createElement("td");
        td.colSpan = 6;
        td.className = "muted";
        td.textContent = "No tokens yet.";
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
    });
  }

  document.getElementById("login-btn").addEventListener("click", function () {
    var key = document.getElementById("admin-key").value.trim();
    if (!key) return;
    sessionStorage.setItem(KEY, key);
    setStatus("");
    refresh()
      .then(function () { show(true); })
      .catch(function (e) { setStatus(e.message, true); });
  });
  document.getElementById("admin-key").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("login-btn").click();
  });

  document.getElementById("create-btn").addEventListener("click", function () {
    var label = document.getElementById("label").value.trim();
    if (!label) { setStatus("Enter a label first.", true); return; }
    api("POST", "/admin/api/tokens", { label: label })
      .then(function (t) {
        document.getElementById("label").value = "";
        var box = document.getElementById("new-token");
        box.classList.remove("hidden");
        box.textContent = "";
        var p1 = document.createElement("div");
        p1.append("Token for ");
        var strong = document.createElement("strong");
        strong.textContent = t.label;
        p1.append(strong, ": ");
        var code = document.createElement("code");
        code.textContent = t.token;
        p1.append(code, " ");
        p1.appendChild(copyBtn(t.token));
        var p2 = document.createElement("div");
        p2.className = "muted";
        var cmd = "composer config --global http-basic." + location.host + " token " + t.token;
        p2.append("Setup command: ");
        var code2 = document.createElement("code");
        code2.textContent = cmd;
        p2.append(code2, " ");
        p2.appendChild(copyBtn(cmd));
        var p3 = document.createElement("div");
        p3.className = "muted";
        p3.textContent = "Copy it now — only a hash is stored, so the full token can't be shown again.";
        box.append(p1, p2, p3);
        setStatus("Token created.");
        return refresh();
      })
      .catch(function (e) { setStatus(e.message, true); });
  });

  if (sessionStorage.getItem(KEY)) {
    refresh()
      .then(function () { show(true); })
      .catch(function () { show(false); });
  }
})();
