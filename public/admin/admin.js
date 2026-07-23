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

  function fmtSize(bytes) {
    if (bytes == null) return "";
    var kb = bytes / 1024;
    return kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(kb)) + " KB";
  }

  function refreshVersions() {
    return api("GET", "/admin/api/versions").then(function (versions) {
      var tbody = document.getElementById("version-rows");
      tbody.textContent = "";
      // Already sorted newest first by the API; the first row is "latest".
      versions.forEach(function (v, i) {
        var tr = document.createElement("tr");

        var tdVersion = document.createElement("td");
        var code = document.createElement("code");
        code.textContent = v.version;
        tdVersion.appendChild(code);
        if (i === 0) {
          var badge = document.createElement("span");
          badge.className = "badge";
          badge.textContent = "latest";
          tdVersion.append(" ", badge);
        }

        var tdTime = document.createElement("td");
        tdTime.textContent = fmtDate(v.time);

        var tdSha = document.createElement("td");
        var sha = document.createElement("code");
        sha.textContent = (v.sha1 || "").slice(0, 7);
        sha.title = v.sha1 || "";
        tdSha.appendChild(sha);

        var tdDist = document.createElement("td");
        if (v.dist) {
          tdDist.className = "ok";
          tdDist.textContent = "✓" + (v.size != null ? " " + fmtSize(v.size) : "");
        } else {
          tdDist.className = "danger";
          tdDist.textContent = "✗ missing";
        }

        var tdActions = document.createElement("td");
        var del = document.createElement("button");
        del.textContent = "Delete";
        del.className = "danger";
        del.addEventListener("click", function () {
          if (!confirm("Delete release " + v.version + "? Its zip is removed permanently, and any " +
              "consumer pinned to " + v.version + " will fail to install or update. This cannot be undone.")) return;
          api("DELETE", "/admin/api/versions/" + encodeURIComponent(v.version))
            .then(refreshVersions)
            .then(function () { setStatus("Release " + v.version + " deleted."); })
            .catch(function (e) { setStatus(e.message, true); });
        });
        tdActions.appendChild(del);

        tr.appendChild(tdVersion);
        tr.appendChild(tdTime);
        tr.appendChild(tdSha);
        tr.appendChild(tdDist);
        tr.appendChild(tdActions);
        tbody.appendChild(tr);
      });
      if (versions.length === 0) {
        var tr = document.createElement("tr");
        var td = document.createElement("td");
        td.colSpan = 5;
        td.className = "muted";
        td.textContent = "No releases published yet.";
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
    });
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
    Promise.all([refresh(), refreshVersions()])
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
    Promise.all([refresh(), refreshVersions()])
      .then(function () { show(true); })
      .catch(function () { show(false); });
  }
})();
