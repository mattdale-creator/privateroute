const API = window.PRIVATEROUTE_API || "";

const state = {
  token: localStorage.getItem("pr_token") || "",
  mode: "login",
  lastConfig: "",
  lastName: "device",
};

const $ = (sel) => document.querySelector(sel);

function show(id) {
  ["landing", "auth", "dash"].forEach((v) => {
    $(`#view-${v}`)?.classList.toggle("hidden", v !== id);
  });
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers, credentials: "include" });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(data.error?.formErrors || data.error || res.statusText);
  return data;
}

function setToken(token) {
  state.token = token || "";
  if (token) localStorage.setItem("pr_token", token);
  else localStorage.removeItem("pr_token");
  renderNav();
}

function renderNav() {
  const nav = $("#nav-auth");
  if (!nav) return;
  if (state.token) {
    nav.innerHTML = `
      <button class="btn ghost" data-go="dash">Dashboard</button>
      <button class="btn ghost" id="btn-logout">Log out</button>`;
    $("#btn-logout")?.addEventListener("click", async () => {
      try { await api("/api/auth/logout", { method: "POST" }); } catch {}
      setToken("");
      show("landing");
    });
  } else {
    nav.innerHTML = `
      <button class="btn ghost" data-go="login">Log in</button>
      <button class="btn primary" data-go="register">Sign up</button>`;
  }
  nav.querySelectorAll("[data-go]").forEach((el) =>
    el.addEventListener("click", () => go(el.getAttribute("data-go"))),
  );
}

function go(where) {
  if (where === "register" || where === "login") {
    state.mode = where;
    $("#auth-title").textContent = where === "register" ? "Create account" : "Log in";
    show("auth");
    return;
  }
  if (where === "dash") {
    loadDash();
    return;
  }
  show("landing");
}

document.querySelectorAll("[data-go]").forEach((el) =>
  el.addEventListener("click", (e) => {
    e.preventDefault();
    go(el.getAttribute("data-go"));
  }),
);

$("#auth-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = { email: fd.get("email"), password: fd.get("password") };
  $("#auth-error").textContent = "";
  try {
    const path = state.mode === "register" ? "/api/auth/register" : "/api/auth/login";
    const data = await api(path, { method: "POST", body: JSON.stringify(body) });
    setToken(data.token);
    await loadDash();
  } catch (err) {
    $("#auth-error").textContent = String(err.message || err);
  }
});

async function loadDash() {
  show("dash");
  try {
    const me = await api("/api/me");
    $("#sub-line").textContent = `${me.email} · ${me.subscription.status} · ${me.deviceCount}/${me.subscription.device_limit} devices`;
    const nodes = await api("/api/nodes");
    $("#nodes").innerHTML = (nodes.nodes || [])
      .map(
        (n) =>
          `<span class="pill">${n.region} · ${n.name} · ${n.public_ip}:${n.wg_listen_port} · ${n.used}/${n.capacity}</span>`,
      )
      .join("") || `<span class="pill">No nodes registered yet</span>`;

    const devices = await api("/api/devices");
    const list = $("#devices");
    list.innerHTML = "";
    (devices.devices || [])
      .filter((d) => !d.revoked_at)
      .forEach((d) => {
        const el = document.createElement("div");
        el.className = "device";
        el.innerHTML = `
          <div>
            <h3>${escapeHtml(d.name)}</h3>
            <p class="muted">${escapeHtml(d.assigned_ipv4)} · ${escapeHtml(d.region)} · ${escapeHtml(d.public_ip)}</p>
          </div>
          <div class="row">
            <button class="btn ghost" data-cfg="${d.id}">Config</button>
            <button class="btn danger" data-del="${d.id}">Revoke</button>
          </div>`;
        list.appendChild(el);
      });

    list.querySelectorAll("[data-cfg]").forEach((btn) =>
      btn.addEventListener("click", () => showConfig(btn.getAttribute("data-cfg"))),
    );
    list.querySelectorAll("[data-del]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!confirm("Revoke this device?")) return;
        await api(`/api/devices/${btn.getAttribute("data-del")}`, { method: "DELETE" });
        await loadDash();
      }),
    );
  } catch (err) {
    setToken("");
    show("landing");
    alert(String(err.message || err));
  }
}

async function showConfig(id) {
  const data = await api(`/api/devices/${id}/config`);
  state.lastConfig = data.config;
  $("#qr").src = data.qrDataUrl;
  $("#conf").textContent = data.config;
  $("#config-panel").classList.remove("hidden");
}

$("#btn-add")?.addEventListener("click", async () => {
  const name = prompt("Device name", `device-${new Date().toISOString().slice(0, 10)}`) || "device";
  try {
    const data = await api("/api/devices", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    state.lastConfig = data.config;
    state.lastName = name;
    $("#qr").src = data.qrDataUrl;
    $("#conf").textContent = data.config;
    $("#config-panel").classList.remove("hidden");
    await loadDash();
  } catch (err) {
    alert(String(err.message || err));
  }
});

$("#btn-download")?.addEventListener("click", () => {
  const blob = new Blob([state.lastConfig], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `privateroute-${state.lastName}.conf`;
  a.click();
});

$("#btn-close-conf")?.addEventListener("click", () => {
  $("#config-panel").classList.add("hidden");
});

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function init() {
  renderNav();
  try {
    const meta = await api("/api/meta");
    $("#meta").textContent = `${meta.name} · nodes: ${meta.nodes} · auto-activate: ${meta.autoActivate}`;
  } catch {
    $("#meta").textContent = "API offline — start the control plane.";
  }
  if (state.token) await loadDash();
  else show("landing");
}

init();
