let masterKey = "";
let vaultEntries = [];

function getSelectedShardId() {
    const select = document.getElementById("shardSelect");
    if (!select) return 0;
    const value = Number(select.value);
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

function setSelectedShardId(shardId) {
    const select = document.getElementById("shardSelect");
    if (!select) return;
    const value = String(shardId ?? 0);
    if (Array.from(select.options).some(option => option.value === value)) {
        select.value = value;
    }
    localStorage.setItem("byteLabsShardId", value);
}

async function loadShardOptions() {
    const select = document.getElementById("shardSelect");
    const hint = document.getElementById("shardHint");
    if (!select) return;

    try {
        const res = await fetch("/shards");
        const data = await res.json();
        const shards = Array.isArray(data?.shards) && data.shards.length ? data.shards : [{ id: 1, host: window.location.origin, name: "shard1" }];
        const current = localStorage.getItem("byteLabsShardId") || String(shards[0]?.id ?? 1);
        select.innerHTML = shards.map(shard => `<option value="${shard.id}">${shard.name} • ${shard.host}</option>`).join("");
        if (Array.from(select.options).some(option => option.value === current)) {
            select.value = current;
        } else {
            select.value = String(shards[0]?.id ?? 1);
        }
        if (hint) {
            const selected = shards.find(shard => String(shard.id) === select.value) || shards[0];
            hint.textContent = `Selected shard ${selected?.id ?? 1} · ${selected?.host || window.location.origin}`;
        }
    } catch {
        if (hint) hint.textContent = "Shard selection unavailable";
    }
}

window.addEventListener("DOMContentLoaded", () => {
    loadShardOptions();
    const select = document.getElementById("shardSelect");
    if (select) {
        select.addEventListener("change", () => {
            setSelectedShardId(select.value);
            const hint = document.getElementById("shardHint");
            if (hint) hint.textContent = `Selected shard ${select.value}`;
        });
    }
});

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(err => {
            console.warn("Service worker registration failed:", err);
        });
    });
}

function escapeHtml(value = "") {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function getSearchState() {
    return {
        query: document.getElementById("search").value.trim().toLowerCase(),
        filter: document.getElementById("filter").value
    };
}

function matchesSearch(entry, query, filter) {
    if (!query) return true;

    const haystacks = {
        all: [entry.username, entry.email, entry.password, entry.token, entry.authenticator, (entry.backupCodes || []).join(" ")],
        username: [entry.username],
        email: [entry.email],
        password: [entry.password],
        token: [entry.token],
        authenticator: [entry.authenticator],
        backup: [(entry.backupCodes || []).join(" ")]
    };

    const values = haystacks[filter] || haystacks.all;
    return values.some(value => String(value || "").toLowerCase().includes(query));
}

function renderVault() {
    const box = document.getElementById("vault");
    const { query, filter } = getSearchState();
    const visibleEntries = vaultEntries.filter(entry => matchesSearch(entry, query, filter));

    box.innerHTML = "";

    if (!visibleEntries.length) {
        box.innerHTML = "<div class='card'>No matching entries.</div>";
        return;
    }

    visibleEntries.forEach(renderEntry);
}

async function createVault() {
    const vaultOwner = document.getElementById("vaultUser") ? document.getElementById("vaultUser").value.trim() : "";
    const password = document.getElementById("master").value;

    if (!vaultOwner || !password) {
        alert("Enter a vault username and master password first.");
        return;
    }

    const shardId = getSelectedShardId();
    setSelectedShardId(shardId);
    const res = await fetch("/create-vault", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ master: password, username: vaultOwner, shardId })
    });

    const data = await res.json();
    if (data.error) {
        alert(data.error);
        return;
    }

    masterKey = password;
    await loadVault();
}

document.addEventListener("DOMContentLoaded", () => {
    const createBtn = document.getElementById("createVaultBtn");
    if (createBtn) {
        createBtn.addEventListener("click", () => {
            createVault();
        });
    }

    const createForm = document.getElementById("createVaultForm");
    if (createForm) {
        createForm.addEventListener("submit", event => {
            event.preventDefault();
            createVault();
        });
    }
});

// 🔓 unlock vault
async function loadVault() {
    masterKey = document.getElementById("master").value;
    const vaultOwner = document.getElementById("vaultUser") ? document.getElementById("vaultUser").value.trim() : undefined;

    if (!masterKey) {
        vaultEntries = [];
        renderVault();
        return;
    }

    const shardId = getSelectedShardId();
    setSelectedShardId(shardId);
    const res = await fetch("/get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ master: masterKey, username: vaultOwner, shardId })
    });

    const data = await res.json();

    if (data.error) {
        vaultEntries = [];
        renderVault();
        // show unlock panel on error
        const up = document.getElementById('unlock-panel');
        if (up) up.style.display = '';
        const lb = document.getElementById('lockBtn');
        if (lb) lb.style.display = 'none';
        return;
    }

    vaultEntries = data;
    renderVault();

    // hide the unlock panel on successful unlock and show lock button
    const up = document.getElementById('unlock-panel');
    if (up) up.style.display = 'none';
    const lb = document.getElementById('lockBtn');
    if (lb) lb.style.display = 'inline-block';
}

// ➕ add entry
async function addEntry() {
    const entry = {
        username: document.getElementById("username").value,
        email: document.getElementById("email").value,
        password: document.getElementById("password").value,
        token: document.getElementById("token").value,
        authenticator: document.getElementById("authenticator").value,
        backupCodes: document.getElementById("backup")
            .value
            .split("\n")
            .filter(Boolean)
    };

    const vaultOwner = document.getElementById("vaultUser") ? document.getElementById("vaultUser").value.trim() : undefined;
    const shardId = getSelectedShardId();
    setSelectedShardId(shardId);
    const res = await fetch("/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            master: masterKey,
            username: vaultOwner,
            shardId,
            entry
        })
    });

    const data = await res.json();
    if (data.error) {
        alert(data.error);
        return;
    }

    document.getElementById("username").value = "";
    document.getElementById("email").value = "";
    document.getElementById("password").value = "";
    document.getElementById("token").value = "";
    document.getElementById("authenticator").value = "";
    document.getElementById("backup").value = "";
    await loadVault();
}

// 🧾 render vault card
function renderEntry(acc) {
    const box = document.getElementById("vault");
    const idx = typeof acc.index !== 'undefined' ? acc.index : -1;

    box.insertAdjacentHTML('beforeend', `
        <div class="card">
            <div><b>Username:</b> ${escapeHtml(acc.username)}</div>
            <div><b>Email:</b> ${escapeHtml(acc.email)}</div>
            <div><b>Password:</b> ${escapeHtml(acc.password)}</div>

            <hr>

            <div><b>🔐 Security</b></div>

            <div class="field">
                <b>Token</b>
                <input value="${escapeHtml(acc.token)}" readonly />
            </div>

            <div class="field">
                <b>Authenticator Secret</b>
                <input value="${escapeHtml(acc.authenticator)}" readonly />
            </div>

            <div class="field">
                <b>Authenticator Code (LIVE)</b>
                <input value="${escapeHtml(acc.authCode)}" readonly />
            </div>

            <div class="field">
                <b>Backup Codes</b>
                <textarea readonly rows="8">${escapeHtml((acc.backupCodes || []).join("\n"))}</textarea>
            </div>
            <div class="actions">
                <button class="edit-entry-btn">Edit</button>
            </div>
        </div>
    `);

    const card = box.lastElementChild;
    const editBtn = card ? card.querySelector('.edit-entry-btn') : null;
    if (editBtn) {
        editBtn.addEventListener('click', () => startEdit(idx));
    }
}

function startEdit(idx) {
    if (idx === -1) return alert('Cannot edit: index unknown. Reload vault first.');

    const entry = vaultEntries[idx];
    if (!entry) return alert('Entry not found');

    document.getElementById('username').value = entry.username || '';
    document.getElementById('email').value = entry.email || '';
    document.getElementById('password').value = entry.password || '';
    document.getElementById('token').value = entry.token || '';
    document.getElementById('authenticator').value = entry.authenticator || '';
    document.getElementById('backup').value = (entry.backupCodes || []).join('\n');

    // replace Save button behavior to perform update
    const saveBtn = document.querySelector('#add-save-btn');
    if (saveBtn) {
        saveBtn.textContent = 'Update Entry';
        saveBtn.onclick = async () => {
            const updated = {
                username: document.getElementById('username').value,
                email: document.getElementById('email').value,
                password: document.getElementById('password').value,
                token: document.getElementById('token').value,
                authenticator: document.getElementById('authenticator').value,
                backupCodes: document.getElementById('backup').value.split('\n').filter(Boolean)
            };

            const vaultOwner = document.getElementById("vaultUser") ? document.getElementById("vaultUser").value.trim() : undefined;
            const shardId = getSelectedShardId();
            setSelectedShardId(shardId);
            const res = await fetch('/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ master: masterKey, username: vaultOwner, shardId, index: idx, entry: updated })
            });

            const data = await res.json();
            if (data.error) return alert(data.error);

            // reset save button
            saveBtn.textContent = 'Save Entry';
            saveBtn.onclick = addEntry;

            await loadVault();
        };
    }
}

// ---------- Account generator ----------
function getSecureRandomIndex(maxExclusive) {
    if (!window.crypto || !window.crypto.getRandomValues) {
        throw new Error("Secure random number generation is not available in this browser.");
    }

    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 256) {
        throw new Error("maxExclusive must be a positive integer up to 256.");
    }

    const randomByte = new Uint8Array(1);
    const limit = Math.floor(256 / maxExclusive) * maxExclusive;

    let value;
    do {
        window.crypto.getRandomValues(randomByte);
        value = randomByte[0];
    } while (value >= limit);

    return value % maxExclusive;
}

function generateUsername(length = 8) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let result = "bytelabs_";

    for (let i = 0; i < length; i++) {
        result += chars[getSecureRandomIndex(chars.length)];
    }

    return result;
}

function generatePassword(length = 15) {
    const chars =
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
    let password = "";

    for (let i = 0; i < length; i++) {
        password += chars[getSecureRandomIndex(chars.length)];
    }

    return password;
}

function generateAccount() {
    const username = generateUsername();
    const password = generatePassword();

    const u = document.getElementById('username');
    const p = document.getElementById('password');
    if (u) u.value = username;
    if (p) p.value = password;
}

function lockVault() {
    masterKey = "";
    vaultEntries = [];
    renderVault();

    const up = document.getElementById('unlock-panel');
    if (up) up.style.display = '';
    const lb = document.getElementById('lockBtn');
    if (lb) lb.style.display = 'none';

    const masterInput = document.getElementById('master');
    if (masterInput) masterInput.value = '';
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("search").addEventListener("input", renderVault);
    document.getElementById("filter").addEventListener("change", renderVault);

    const generateBtn = document.getElementById("generateAccountBtn");
    if (generateBtn) generateBtn.addEventListener("click", generateAccount);

    const lockBtn = document.getElementById("lockBtn");
    if (lockBtn) lockBtn.addEventListener("click", lockVault);

    setInterval(() => {
        if (masterKey) {
            loadVault();
        }
    }, 30000);
});