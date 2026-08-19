// ---- 状態 ----
let META = { tcgs: [], shops: [] };
let ITEMS = [];
let calYear, calMonth; // カレンダー表示中の年月

const $ = (id) => document.getElementById(id);

// ---- 静的公開モード ----
// 書き出したサイト（GitHub Pages等）では API サーバーが無いので、
// 同梱した data.json を代わりに使い、編集系の機能は隠す。
const STATIC = typeof window.TCG_STATIC !== "undefined" ? window.TCG_STATIC : null;
const isStatic = () => STATIC !== null;

/** APIの代わり。静的モードでは同梱データから同じ形の結果を返す。 */
async function apiGet(path) {
  if (!isStatic()) return fetch(path).then((r) => r.json());

  const [base, qs] = path.split("?");
  const p = new URLSearchParams(qs || "");
  if (base === "/api/meta") return STATIC.meta;
  if (base === "/api/refresh/status") return STATIC.refresh || {};
  if (base !== "/api/items") return [];

  let rows = STATIC.items.slice();
  const cat = p.get("category");
  if (cat) rows = rows.filter((r) => (r.category || "reserve") === cat);
  if (p.get("tcg")) rows = rows.filter((r) => r.tcg_key === p.get("tcg"));
  if (p.get("kind")) rows = rows.filter((r) => r.shop_kind === p.get("kind"));
  if (p.get("shop_id")) rows = rows.filter((r) => String(r.shop_id) === p.get("shop_id"));
  if (p.get("status")) rows = rows.filter((r) => r.status === p.get("status"));
  if (p.get("sns_only")) {
    rows = rows.filter((r) => /^https:\/\/(x|twitter|www\.twitter)\.com\//.test(r.source_url || "")
      || (r.source_url || "").startsWith("https://nyuka-now.com/"));
  }
  const q = (p.get("q") || "").trim();
  if (q) {
    const k = q.toLowerCase();
    rows = rows.filter((r) =>
      (r.title || "").toLowerCase().includes(k)
      || (r.note || "").toLowerCase().includes(k)
      || (r.shop_name || "").toLowerCase().includes(k));
  }
  return rows;
}

// ---- 書き込み用の合言葉（公開運用時のみ）----
// 端末内(localStorage)にのみ保存。サーバーには送信時のヘッダとしてのみ渡す。
const PW_KEY = "tcg_admin_pw";
const getPw = () => localStorage.getItem(PW_KEY) || "";
const setPw = (v) => localStorage.setItem(PW_KEY, v);

function askPw(msg) {
  const v = prompt(msg || "編集用の合言葉を入力してください");
  if (v !== null) setPw(v.trim());
  return v !== null;
}

/** 書き込み系fetch。合言葉が要る環境なら自動で付け、401なら再入力を促す。 */
async function writeFetch(url, opts = {}, retry = true) {
  const headers = Object.assign({}, opts.headers || {});
  if (META.auth_required) headers["X-Admin-Password"] = getPw();
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  if (res.status === 401 && retry) {
    if (askPw("合言葉が違います。もう一度入力してください")) {
      return writeFetch(url, opts, false);
    }
  }
  return res;
}
const shopById = (id) => META.shops.find((s) => s.id === id);
const tcgName = (key) => (META.tcgs.find((t) => t.key === key) || {}).name || key;

// ---- 初期化 ----
async function init() {
  META = await apiGet("/api/meta");
  fillSelect($("i-tcg"), META.tcgs, "key", "name", null);
  renderGenreTabs();
  fillSelect($("f-shop"), META.shops, "id", "name", "全店舗");
  fillSelect($("i-shop"), META.shops, "id", "name", "（未選択）");

  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();

  bindTabs();
  bindFilters();
  bindCalendar();
  if (isStatic()) {
    applyStaticMode();      // 公開版は閲覧専用。編集系を隠す
  } else {
    bindForm();
    bindRefresh();
  }
  await loadItems();
  showRefreshStatus();          // 起動時の自動更新の結果を表示
  setTimeout(refreshStatusPoll, 4000);  // 起動直後の更新は裏で走るので少し後にもう一度見る
}

/** 公開版（静的サイト）の見た目に整える。閲覧に不要なものを消す。 */
function applyStaticMode() {
  ["add"].forEach((v) => {
    const tab = document.querySelector(`.tab[data-view="${v}"]`);
    if (tab) tab.remove();
    const view = $("view-" + v);
    if (view) view.remove();
  });
  const btn = $("refresh-btn");
  if (btn) btn.remove();
  // 最終更新の表示は、いつ時点のデータかを示すので残す
  const st = $("refresh-status");
  if (st && STATIC.built_at) {
    st.innerHTML = `<span>このページのデータ: <b>${escapeHtml(STATIC.built_at)}</b> 時点`
      + `（閲覧専用）</span>`;
  }
}

// ---- 更新 ----
function bindRefresh() {
  $("refresh-btn").addEventListener("click", doRefresh);
}

function fmtStatus(r, running) {
  if (running) return `<span>🔄 更新中… 情報源を巡回しています</span>`;
  if (!r || !r.ran_at) return `<span>最終更新: まだ実行されていません</span>`;
  const bad = r.errors > 0;
  return `<span>最終更新: <b>${escapeHtml(r.ran_at)}</b> ／ `
    + `<span class="ok">追加 ${r.added}</span>・<span class="ok">補完 ${r.updated}</span>`
    + `・<span class="${bad ? "ng" : ""}">エラー ${r.errors}</span></span>`
    + (r.detail ? `<details><summary>内訳を見る</summary><pre>${escapeHtml(r.detail)}</pre></details>` : "");
}

async function showRefreshStatus(running) {
  const el = $("refresh-status");
  // 公開版は更新できないので、いつ時点のデータかだけを示す
  if (isStatic()) {
    el.innerHTML = `<span>📅 このページのデータ: <b>${escapeHtml(STATIC.built_at || "")}</b> 時点`
      + `（閲覧専用。最新は管理者が更新します）</span>`;
    return;
  }
  if (running) { el.innerHTML = fmtStatus(null, true); return; }
  try {
    const r = await apiGet("/api/refresh/status");
    el.innerHTML = fmtStatus(r, false);
  } catch { el.innerHTML = ""; }
}

// 起動時の自動更新はバックグラウンドで走るため、少し待って結果を反映する
async function refreshStatusPoll() {
  await showRefreshStatus();
  await loadItems();
}

async function doRefresh() {
  const btn = $("refresh-btn");
  btn.disabled = true;
  showRefreshStatus(true);
  try {
    const res = await writeFetch("/api/refresh", { method: "POST" });
    if (!res.ok) {
      $("refresh-status").innerHTML = '<span class="ng">更新できません（合言葉を確認してください）</span>';
      btn.disabled = false;
      return;
    }
  } catch (e) {
    $("refresh-status").innerHTML = '<span class="ng">更新に失敗しました（ネットワークを確認してください）</span>';
    btn.disabled = false;
    return;
  }
  await showRefreshStatus();
  await loadItems();
  btn.disabled = false;
}

function fillSelect(el, arr, valKey, labelKey, placeholder) {
  el.innerHTML = "";
  if (placeholder !== null) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = placeholder; el.appendChild(o);
  }
  for (const a of arr) {
    const o = document.createElement("option");
    o.value = a[valKey];
    o.textContent = a.kind ? `${a[labelKey]}（${labelJP(a.kind)}）` : a[labelKey];
    el.appendChild(o);
  }
}
function labelJP(kind) {
  return { shop: "店舗", convenience: "コンビニ", maker: "公式", online: "通販" }[kind] || kind;
}

// ---- タブ ----
function bindTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const view = btn.dataset.view;
      // 公開版では「追加」タブを取り除くので、無い要素を触らないようにする
      ["list", "restock", "online", "topps", "history", "calendar", "search", "add"].forEach((v) => {
        const el = $("view-" + v);
        if (el) el.classList.toggle("hidden", v !== view);
      });
      if (view === "calendar") renderCalendar();
      if (view === "search") renderSearchLinks();
      if (view === "restock")
        loadCategory("restock", "restock-cards", "notify-restock", {
          snsOnly: true,
          emptyMsg:
            "SNS(X)で確認できた再販情報はまだありません。" +
            "「🔍 探す」タブの再販速報アカウントで再販投稿を見つけたら、" +
            "その投稿URLを「➕ 情報を追加」に貼ってください。",
        });
      if (view === "online") loadCategory("online", "online-cards", "notify-online");
      if (view === "topps") loadTopps();
      if (view === "history") loadHistory();
    });
  });
}

// ---- ジャンル別タブ ----
let CUR_GENRE = "";   // "" = すべて

function renderGenreTabs() {
  const el = $("genre-tabs");
  const tabs = [{ key: "", name: "すべて" }].concat(META.tcgs);
  el.innerHTML = tabs.map((t) =>
    `<button class="gtab${t.key === CUR_GENRE ? " active" : ""}" data-key="${t.key}">
       <span class="gart">${t.key ? genreArtSVG(t.key, 56) : allGenresArt(56)}</span>
       <span class="gname">${escapeHtml(t.name)}</span>
       <span class="gcount" data-c="${t.key}"></span>
     </button>`
  ).join("");
  el.querySelectorAll(".gtab").forEach((b) =>
    b.addEventListener("click", () => {
      CUR_GENRE = b.dataset.key;
      el.querySelectorAll(".gtab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      loadItems();
    })
  );
}

/** 各ジャンルの件数バッジを更新（現在の検索語での件数） */
async function updateGenreCounts() {
  // 一覧と同じ条件で数えないと、バッジの件数と実際の表示件数が食い違う
  const p = new URLSearchParams({ category: "reserve" });
  const q = $("f-q").value.trim();
  if (q) p.set("q", q);
  if ($("f-kind").value) p.set("kind", $("f-kind").value);
  if ($("f-shop").value) p.set("shop_id", $("f-shop").value);
  if ($("f-status").value) p.set("status", $("f-status").value);
  const all = await apiGet("/api/items?" + p.toString()).catch(() => []);
  const by = {};
  for (const it of all) by[it.tcg_key] = (by[it.tcg_key] || 0) + 1;
  document.querySelectorAll(".gcount").forEach((s) => {
    const k = s.dataset.c;
    const n = k === "" ? all.length : (by[k] || 0);
    s.textContent = n ? ` ${n}` : "";
  });
}

// ---- 一覧 ----
let qTimer = null;
function bindFilters() {
  ["f-kind", "f-shop", "f-status"].forEach((id) =>
    $(id).addEventListener("change", loadItems)
  );
  // 入力のたびに叩かないよう少し待ってから検索する
  $("f-q").addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(loadItems, 250);
  });
  $("f-q-clear").addEventListener("click", () => {
    $("f-q").value = "";
    loadItems();
  });
}

async function loadItems() {
  const p = new URLSearchParams();
  // 一覧は「予約・抽選」だけを出す。指定しないと再販メモや通販在庫まで
  // 商品として並んでしまう（記事見出しが商品に見える原因だった）。
  p.set("category", "reserve");
  if (CUR_GENRE) p.set("tcg", CUR_GENRE);
  if ($("f-q").value.trim()) p.set("q", $("f-q").value.trim());
  if ($("f-kind").value) p.set("kind", $("f-kind").value);
  if ($("f-shop").value) p.set("shop_id", $("f-shop").value);
  if ($("f-status").value) p.set("status", $("f-status").value);
  ITEMS = await apiGet("/api/items?" + p.toString());
  updateGenreCounts();
  ITEMS.forEach((it) => (it._phase = phaseOf(it)));
  // 行動できる順に並べる: 受付中 → 予約開始前 → 発売待ち → 終了
  // 🟡締切要確認(unknown)を入れ忘れると比較結果がNaNになり並び順が壊れる
  const order = { open: 0, unknown: 1, upcoming: 2, waiting: 3, tbd: 4, closed: 5 };
  ITEMS.sort((a, b) => {
    const d = (order[a._phase.key] ?? 9) - (order[b._phase.key] ?? 9);
    if (d !== 0) return d;
    return (a._phase.sortDate || 99999999) - (b._phase.sortDate || 99999999);
  });
  renderCards();
}

function todayMidnight() {
  const t = new Date(); t.setHours(0, 0, 0, 0); return t;
}
function toDate(s) {
  const p = parseDate(s);
  return p ? new Date(p.y, p.m - 1, p.d) : null;
}
const numOf = (d) => (d ? d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate() : null);

/** その案件が今どの段階かを判定する。 */
// メモに終了が明記されているもの（Toppsの【終了】など）
const ENDED_RE = /【終了】|【発売済】|終了しました|応募は終了|受付終了|販売終了/;

function phaseOf(it) {
  const today = todayMidnight();
  const rs = toDate(it.reserve_start);
  const re = toDate(it.reserve_end);
  const lot = toDate(it.lottery_date);
  const rel = toDate(it.release_date);

  // 明示的に終了と書かれていれば、日付に関わらず終了
  if (ENDED_RE.test(it.note || "")) {
    return { key: "closed", label: "⚫ 終了", sortDate: numOf(rel || lot || re || rs) };
  }
  // 当選発表日を過ぎているなら、受付はもう終わっている
  if (lot && lot < today && (!re || re < today)) {
    return { key: "closed", label: "⚫ 終了", sortDate: numOf(rel || lot) };
  }
  // 受付中: 開始済みで、締切が未来
  if (rs && rs <= today && re && re >= today) {
    return { key: "open", label: "🟢 受付中", sortDate: numOf(re) };
  }
  // 締切が分からないまま開始だけ判明している場合。
  // ずっと「受付中」に見えてしまうのを避け、確認を促す表示にする。
  if (rs && rs <= today && !re) {
    const stale = (today - rs) / 86400000 > 30;   // 開始から1ヶ月以上
    if (!stale && (!rel || rel >= today)) {
      return { key: "unknown", label: "🟡 締切要確認", sortDate: numOf(lot || rel) };
    }
  }
  // これから受付
  if (rs && rs > today) {
    return { key: "upcoming", label: "🔵 受付前", sortDate: numOf(rs) };
  }
  // 受付は終わった/無いが、当選発表や発売がこれから
  if ((lot && lot >= today) || (rel && rel >= today)) {
    const next = lot && lot >= today ? lot : rel;
    return { key: "waiting", label: lot && lot >= today ? "🟣 発表待ち" : "🔷 発売待ち", sortDate: numOf(next) };
  }
  if (!rs && !re && !lot && !rel) {
    return { key: "tbd", label: "⚪ 日程未定", sortDate: null };
  }
  return { key: "closed", label: "⚫ 終了", sortDate: numOf(rel || lot || re || rs) };
}

/** 応募ボタン＋応募済みチェック。応募URLが無ければ店舗サイトで代用する。 */
function applyRow(it) {
  const url = it.apply_url || it.shop_web;
  if (!url) return "";
  // 応募ページが分からず店舗トップで代用する場合は、その旨を出して誤解を避ける
  const isTop = !it.apply_url && !!it.shop_web;
  const done = !!it.applied;
  const closed = (it._phase && it._phase.key === "closed");

  // 受付が終わったものは応募できないので、チェックは出さず、ボタンも控えめにする
  if (closed) {
    return `<div class="apply-row ended">
      <a class="apply-btn muted" href="${escapeHtml(url)}" target="_blank" rel="noopener">販売ページ</a>
      <span class="ended-note">受付は終了しています</span>
    </div>`;
  }

  const label = isTop ? "販売サイトを開く"
    : it.method === "抽選" ? "応募する"
      : it.method === "先着" ? "購入ページへ" : "予約する";
  return `<div class="apply-row">
    <a class="apply-btn${isTop ? " muted" : ""}" href="${safeUrl(url)}" target="_blank" rel="noopener">🎫 ${label}</a>
    ${isTop ? '<span class="ended-note">※応募ページ未特定。サイト内で該当商品を探してください</span>' : ""}
    <label class="applied-check${done ? " on" : ""}">
      <input type="checkbox" ${done ? "checked" : ""} onchange="toggleApplied(${it.id}, this)">
      <span>${done ? "応募済み" : "応募したらチェック"}</span>
    </label>
    ${it.applied_at ? `<span class="applied-at">${escapeHtml(it.applied_at)}</span>` : ""}
  </div>`;
}

/** チェックの切り替えをサーバーに保存する。 */
window.toggleApplied = async (id, el) => {
  const on = el.checked;
  const res = await writeFetch(`/api/items/${id}/applied`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ applied: on }),
  });
  if (!res.ok) {
    el.checked = !on;
    alert("保存できませんでした（合言葉を確認してください）");
    return;
  }
  // 画面のラベルだけ即時更新（一覧の再読込はしない＝スクロール位置が飛ばない）
  const wrap = el.closest(".applied-check");
  wrap.classList.toggle("on", on);
  wrap.querySelector("span").textContent = on ? "応募済み" : "応募したらチェック";
  const it = ITEMS.find((x) => x.id === id);
  if (it) it.applied = on ? 1 : 0;
};

// 宮崎から応募・受取できるかの表示（通販は全国どこからでも可）
const PICKUP = {
  mail:  { label: "📮 通販可", cls: "ok",    title: "全国発送。宮崎からも応募・受取できます" },
  local: { label: "🏬 宮崎で受取", cls: "ok", title: "宮崎県内の店舗で受け取れます" },
  check: { label: "❓ 県内店舗を要確認", cls: "warn", title: "宮崎県内に対象店舗があるか要確認" },
  other: { label: "✕ 宮崎県外のみ", cls: "ng", title: "宮崎からは受け取れません" },
};

function pickupBadge(it) {
  const p = PICKUP[it.pickup];
  if (!p) return "";
  return `<span class="badge pickup ${p.cls}" title="${escapeHtml(p.title)}">${p.label}</span>`;
}

/** リンク先として安全なURLだけを通す。javascript: 等の注入を防ぐ。 */
function safeUrl(u) {
  const s = String(u || "").trim();
  return /^https?:\/\//i.test(s) ? escapeHtml(s) : "";
}

function dateBox(cls, label, val) {
  if (!val) return "";
  return `<div class="date-box ${cls}"><b>${label}</b>${escapeHtml(val)}</div>`;
}

function renderSummary() {
  const el = $("list-summary");
  if (!el) return;
  const total = ITEMS.length;
  // タイトル別の件数
  const byTcg = {};
  for (const it of ITEMS) byTcg[it.tcg_key] = (byTcg[it.tcg_key] || 0) + 1;
  const chips = META.tcgs
    .filter((t) => byTcg[t.key])
    .map((t) => `<span class="chip">${t.name} <b>${byTcg[t.key]}</b></span>`)
    .join("");
  // いま応募できるもの・次に動きがあるもの
  const open = ITEMS.filter((it) => it._phase.key === "open");
  const openHtml = open.length
    ? `　｜　🟢 <b>受付中 ${open.length}件</b>: ${escapeHtml(open[0].title)}${open[0].reserve_end ? `（〜${escapeHtml(open[0].reserve_end)}）` : ""}`
    : "　｜　🟢 受付中の案件はありません";

  // 次に来る予定（受付開始・当選発表・発売のうち最も近い未来）
  const today = todayMidnight();
  let next = null;
  for (const it of ITEMS) {
    for (const [f, label] of [["reserve_start", "予約開始"], ["lottery_date", "当選発表"], ["release_date", "発売"]]) {
      const d = toDate(it[f]);
      if (d && d >= today && (!next || d < next.d)) next = { d, label, it, raw: it[f] };
    }
  }
  const nextHtml = next
    ? `<div class="summary-next">⏰ 次の予定: <b>${escapeHtml(next.raw)}</b> ${next.label} — ${escapeHtml(next.it.title)}</div>`
    : "";
  el.innerHTML = `<div class="summary-line">📊 取得情報 <b>${total}</b> 件${openHtml}</div>
    ${nextHtml}
    <div class="chips">${chips || '<span class="chip muted">データなし</span>'}</div>`;
}

function renderCards() {
  renderSummary();
  const wrap = $("cards");
  if (!ITEMS.length) {
    wrap.innerHTML = `<p class="msg">該当する情報がありません。「➕ 情報を追加」から登録できます。</p>`;
    return;
  }
  wrap.innerHTML = ITEMS.map((it) => {
    const src = it.source_url
      ? `<a href="${safeUrl(it.source_url)}" target="_blank" rel="noopener">ソース(${escapeHtml(it.source_type)})</a>`
      : `<span>${it.source_type}</span>`;
    // 公式ページのOGP画像があればそれを、読めなければ自作の箱イメージに差し替える
    const visual = it.image_url
      ? `<img class="pack-img" src="${escapeHtml(it.image_url)}" alt="" loading="lazy"
            referrerpolicy="no-referrer" onerror="packFallback(this)">`
      : packArtSVG(it.title, it.tcg_key);
    return `
    <div class="card">
      <div class="pack-visual" data-title="${escapeHtml(it.title)}" data-tcg="${escapeHtml(it.tcg_key)}">${visual}</div>
      <div class="top">
        <div>
          <h3>${escapeHtml(it.title)}</h3>
          <div class="badges">
            <span class="badge phase ${it._phase.key}">${it._phase.label}</span>
            ${pickupBadge(it)}
            <span class="badge tcg">${tcgName(it.tcg_key)}</span>
            <span class="badge method">${it.method || "未定"}</span>
            ${it.status === "review" ? '<span class="badge review">要確認</span>' : ""}
          </div>
        </div>
        ${isStatic() ? "" : `<div class="actions">
          <button onclick="editItem(${it.id})">編集</button>
          <button onclick="delItem(${it.id})">削除</button>
        </div>`}
      </div>
      <div class="dates">
        ${dateBox("start", "予約開始", it.reserve_start)}
        ${dateBox("end", "締切", it.reserve_end)}
        ${dateBox("lot", "当選発表", it.lottery_date)}
        ${dateBox("rel", "発売", it.release_date)}
      </div>
      ${applyRow(it)}
      ${resultBox(it)}
      <div class="meta">
        <span>🏬 ${it.shop_name ? escapeHtml(it.shop_name) : "未設定"}${it.shop_area ? " / " + it.shop_area : ""}</span>
        ${it.shop_x ? `<a href="https://x.com/${encodeURIComponent(it.shop_x)}" target="_blank" rel="noopener">@${escapeHtml(it.shop_x)}</a>` : ""}
        <span>${src}</span>
        ${it.note ? `<span>📝 ${escapeHtml(it.note)}</span>` : ""}
      </div>
    </div>`;
  }).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- 再販 / 通販 / Topps の各タブ ----

/** カード1枚分のHTML（一覧と同じ見た目を使い回す） */
function itemCardHTML(it) {
  const visual = it.image_url
    ? `<img class="pack-img" src="${escapeHtml(it.image_url)}" alt="" loading="lazy"
          referrerpolicy="no-referrer" onerror="packFallback(this)">`
    : packArtSVG(it.title, it.tcg_key);
  const src = it.source_url
    ? `<a href="${safeUrl(it.source_url)}" target="_blank" rel="noopener">情報源を開く</a>` : "";
  return `<div class="card">
    <div class="pack-visual" data-title="${escapeHtml(it.title)}" data-tcg="${escapeHtml(it.tcg_key)}">${visual}</div>
    <div class="top"><div>
      <h3>${escapeHtml(it.title)}</h3>
      <div class="badges">
        ${it._phase ? `<span class="badge phase ${it._phase.key}">${it._phase.label}</span>` : ""}
        ${pickupBadge(it)}
        <span class="badge tcg">${tcgName(it.tcg_key)}</span>
        <span class="badge method">${it.method || "未定"}</span>
      </div>
    </div>
    ${isStatic() ? "" : `<div class="actions"><button onclick="editItem(${it.id})">編集</button></div>`}</div>
    <div class="dates">
      ${dateBox("start", "受付/開始", it.reserve_start)}
      ${dateBox("end", "締切", it.reserve_end)}
      ${dateBox("rel", "発売", it.release_date)}
    </div>
    ${applyRow(it)}
    ${resultBox(it)}
    <div class="meta">
      <span>🏬 ${it.shop_name ? escapeHtml(it.shop_name) : "未設定"}</span>
      <span>${src}</span>
      ${it.note ? `<span>📝 ${escapeHtml(it.note)}</span>` : ""}
    </div></div>`;
}

async function loadCategory(cat, targetId, notifyId, opts = {}) {
  let url = "/api/items?category=" + cat;
  if (opts.snsOnly) url += "&sns_only=1";
  const rows = await apiGet(url).catch(() => []);
  // 終了判定に使うので、こちらのタブでも状態を計算しておく
  rows.forEach((it) => (it._phase = phaseOf(it)));
  $(targetId).innerHTML = rows.length
    ? rows.map(itemCardHTML).join("")
    : `<p class="msg">${opts.emptyMsg ||
        "まだ登録がありません。「➕ 情報を追加」からURLを貼って登録できます。"}</p>`;
  if (notifyId) renderNotifyBox(notifyId, rows);
  return rows;
}

/** Toppsタブ: カレンダー（日付順の一覧）＋カード */
async function loadTopps() {
  const rows = await loadCategory("topps", "topps-cards", "notify-topps");
  const today = todayMidnight();
  // プレオーダー開始と発売日を1つの時系列にまとめる
  const events = [];
  for (const it of rows) {
    if (it.reserve_start) events.push({ raw: it.reserve_start, kind: "プレオーダー", it });
    if (it.release_date) events.push({ raw: it.release_date, kind: "発売", it });
  }
  events.forEach((e) => (e.d = toDate(e.raw)));
  events.sort((a, b) => (a.d && b.d ? a.d - b.d : 0));

  $("topps-cal").innerHTML = events.length ? events.map((e) => {
    const past = e.d && e.d < today;
    const days = e.d ? Math.round((e.d - today) / 86400000) : null;
    const when = days === null ? "" : days < 0 ? "終了" : days === 0 ? "本日！" : `あと${days}日`;
    return `<div class="tc-row${past ? " past" : ""}${days === 0 ? " today" : ""}">
      <span class="tc-date">${escapeHtml(e.raw)}</span>
      <span class="tc-kind ${e.kind === "発売" ? "rel" : "pre"}">${e.kind}</span>
      <span class="tc-title">${escapeHtml(e.it.title)}</span>
      <span class="tc-when">${when}</span>
    </div>`;
  }).join("") : '<p class="msg">日程が登録されていません</p>';
}

// ---- 通知 ----
const NOTIFY_KEY = "tcg_notify_on";
const notifyOn = () => localStorage.getItem(NOTIFY_KEY) === "1";

/** 通知の状態と有効化ボタン。※実際にスマホへ届けるにはクラウド公開が必要 */
function renderNotifyBox(id, rows) {
  const el = $(id);
  if (!el) return;
  const supported = "Notification" in window;
  if (!supported) {
    el.innerHTML = '<span class="msg">この端末は通知に対応していません</span>';
    return;
  }
  const perm = Notification.permission;
  if (perm === "granted" && notifyOn()) {
    const n = upcomingAlerts(rows).length;
    el.innerHTML = `<span class="notify-on">🔔 通知オン</span>
      <span class="msg">直近の予定 ${n} 件を監視中（このアプリを開いている間）</span>
      <button id="${id}-off" class="mini">オフにする</button>`;
    $(id + "-off").onclick = () => { localStorage.setItem(NOTIFY_KEY, "0"); renderNotifyBox(id, rows); };
  } else {
    el.innerHTML = `<button id="${id}-on" class="primary mini">🔔 通知をオンにする</button>
      <span class="msg">受付開始・発売の前日と当日にお知らせします</span>`;
    $(id + "-on").onclick = async () => {
      const p = await Notification.requestPermission();
      if (p === "granted") {
        localStorage.setItem(NOTIFY_KEY, "1");
        new Notification("宮崎トレカ 予約まとめ", { body: "通知をオンにしました", icon: "/static/icons/icon-192.png" });
        checkAlerts();
      }
      renderNotifyBox(id, rows);
    };
  }
}

/** 明日または本日に動きがある項目を拾う */
function upcomingAlerts(rows) {
  const today = todayMidnight();
  const out = [];
  for (const it of rows) {
    for (const [f, label] of [["reserve_start", "受付開始"], ["reserve_end", "締切"],
                              ["lottery_date", "当選発表"], ["release_date", "発売"]]) {
      const d = toDate(it[f]);
      if (!d) continue;
      const days = Math.round((d - today) / 86400000);
      if (days === 0 || days === 1) out.push({ it, label, days, raw: it[f] });
    }
  }
  return out;
}

/** 通知を出す。同じ内容を何度も出さないよう記録しておく。 */
async function checkAlerts() {
  if (!("Notification" in window) || Notification.permission !== "granted" || !notifyOn()) return;
  const rows = await apiGet("/api/items").catch(() => []);
  const sent = JSON.parse(localStorage.getItem("tcg_sent") || "{}");
  const todayKey = new Date().toDateString();
  for (const a of upcomingAlerts(rows)) {
    const key = `${a.it.id}:${a.label}:${todayKey}`;
    if (sent[key]) continue;
    new Notification(a.days === 0 ? `本日 ${a.label}` : `明日 ${a.label}`, {
      body: `${a.it.title}（${a.raw}）`,
      icon: "/static/icons/icon-192.png",
      tag: key,
    });
    sent[key] = 1;
  }
  localStorage.setItem("tcg_sent", JSON.stringify(sent));
}

// ---- 応募履歴と当落 ----
const RESULT = {
  won:     { label: "🎉 当選", cls: "won" },
  lost:    { label: "😢 落選", cls: "lost" },
  pending: { label: "⏳ 発表待ち", cls: "pending" },
};

/** 応募済みの項目に出す「当落を記録する」ボックス */
function resultBox(it) {
  if (isStatic() || !it.applied) return "";
  const cur = it.result || "pending";
  const btn = (key, text) =>
    `<button class="res-btn ${key}${cur === key ? " on" : ""}"
             onclick="setResult(${it.id}, '${key}')">${text}</button>`;
  return `<div class="result-row">
    <span class="res-label">当落:</span>
    ${btn("pending", "⏳ 未確認")}
    ${btn("won", "🎉 当選")}
    ${btn("lost", "😢 落選")}
    ${it.result_at ? `<span class="applied-at">${escapeHtml(it.result_at)}</span>` : ""}
  </div>`;
}

/** 当落を保存する。画面は該当箇所だけ更新して、スクロール位置を保つ。 */
window.setResult = async (id, value) => {
  const res = await writeFetch(`/api/items/${id}/result`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result: value }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    alert("保存できませんでした: " + (e.detail || "エラー"));
    return;
  }
  const row = document.querySelector(`.result-row button[onclick*="${id},"]`)?.closest(".result-row");
  if (row) {
    row.querySelectorAll(".res-btn").forEach((b) => b.classList.remove("on"));
    row.querySelector(`.res-btn.${value}`)?.classList.add("on");
  }
  const it = ITEMS.find((x) => x.id === id);
  if (it) it.result = value;
  // 履歴タブを開いていれば集計も更新する
  if (!$("view-history").classList.contains("hidden")) loadHistory();
};

async function loadHistory() {
  const el = $("history-cards");
  const sum = $("history-summary");
  const d = await (isStatic()
    ? Promise.resolve({ items: [], total: 0, won: 0, lost: 0, pending: 0, win_rate: null })
    : fetch("/api/history").then((r) => r.json()).catch(() => null));
  if (!d) { el.innerHTML = '<p class="msg">読み込めませんでした</p>'; return; }

  sum.innerHTML = `<div class="summary-line">🎟 応募 <b>${d.total}</b> 件`
    + `　｜　🎉 当選 <b>${d.won}</b>　😢 落選 <b>${d.lost}</b>　⏳ 発表待ち <b>${d.pending}</b></div>`
    + (d.win_rate !== null
      ? `<div class="summary-next">当選率 <b>${d.win_rate}%</b>（結果が出た ${d.won + d.lost} 件のうち）</div>`
      : `<div class="summary-next">まだ結果が出た応募はありません</div>`);

  if (!d.items.length) {
    el.innerHTML = '<p class="msg">応募済みの項目はまだありません。'
      + '各カードの「応募したらチェック」を入れると、ここに残ります。</p>';
    return;
  }
  d.items.forEach((it) => (it._phase = phaseOf(it)));
  el.innerHTML = d.items.map(itemCardHTML).join("");
}

// ---- 探す（検索リンク生成）----
// APIキー不要。宮崎向けの検索を組み立てて新しいタブで開くだけ。
const G = (q) => "https://www.google.com/search?q=" + encodeURIComponent(q);

function linkCard(label, href, sub) {
  return `<a class="linkcard" href="${href}" target="_blank" rel="noopener">
    <span class="lc-title">${escapeHtml(label)}</span>
    ${sub ? `<span class="lc-sub">${escapeHtml(sub)}</span>` : ""}
  </a>`;
}

// 再販・入荷を速報しているXアカウント（検索で実在を確認したもの）
const RESTOCK_ACCOUNTS = [
  // 入荷Nowは在庫復活をリアルタイム追跡しているので最優先
  ["nyuka_now", "★入荷Now（再販の一次確認先）"],
  ["pokecamatomeru", "ポケカ速報＠予約抽選・最新情報まとめ"],
  ["PokeGetInfoMain", "ポケゲトちゃんねる"],
  ["pokeca_new_card", "ポケモンカード新作・再販速報"],
];

function renderSearchLinks() {
  // ⓪ 再販・入荷を探す（見つけたらURLを「URLから追加」に貼る）
  const restock = RESTOCK_ACCOUNTS.map(([h, name]) =>
    linkCard(name, `https://x.com/${h}`, `@${h} の投稿を見る`)
  ).join("")
    + linkCard("★入荷Now（サイト）", "https://nyuka-now.com/",
        "在庫復活をリアルタイム追跡。再販はまずここ")
    + linkCard("再販×宮崎で検索",
        G("site:x.com 宮崎 ポケカ 再販 OR 入荷 -オリパ -買取"), "宮崎の入荷情報")
    + linkCard("ゲオ・ブックオフ・ドンキの再販",
        G("site:x.com ポケカ 再販 ゲオ OR ブックオフ OR ドンキ 入荷"), "量販店の入荷情報")
    + linkCard("コンビニの再販",
        G("site:x.com ポケカ 再販 コンビニ 入荷 セブン OR ローソン OR ファミマ"), "コンビニ入荷");
  $("search-restock").innerHTML = restock;

  // ① タイトル別（新品パック/BOXの予約に絞った語を使う）
  $("search-tcg").innerHTML = META.tcgs.map((t) =>
    linkCard(t.name, G(`site:x.com 宮崎 ${t.name} 予約 OR 抽選 -オリパ -買取`), "宮崎のX投稿を検索")
  ).join("") + linkCard("すべて（横断）",
    G("site:x.com 宮崎 トレカ 予約 OR 抽選 BOX -オリパ -買取"), "タイトルを問わず検索");

  // ② 登録済みの宮崎の店舗（Xを直接開く／その店に絞って検索）
  //    Xを持つ宮崎の店を先に並べる（そこが予約告知の主戦場のため）
  const shops = META.shops.filter((s) => s.kind === "shop")
    .sort((a, b) => (b.x_handle ? 1 : 0) - (a.x_handle ? 1 : 0));
  $("search-shops").innerHTML = shops.map((s) => {
    // 括弧書き（別名・所在地）は検索精度を下げるので落とす
    const q = s.name.replace(/[（(].*?[）)]/g, "").trim();
    const href = s.x_handle
      ? `https://x.com/${s.x_handle}`
      : G(`${q} トレカ 予約 OR 抽選`);
    return linkCard(s.name, href, s.x_handle ? `@${s.x_handle} の投稿を見る` : "Googleで検索");
  }).join("") || '<p class="msg">店舗が登録されていません</p>';

  // ③ コンビニ・通販・メーカー公式
  const others = META.shops.filter((s) => s.kind !== "shop");
  $("search-official").innerHTML = others.map((s) =>
    linkCard(s.name, s.website || G(`${s.name} トレカ 予約 抽選`),
             s.website ? "公式サイトを開く" : "Googleで検索")
  ).join("");
}

// ---- 追加/編集フォーム ----
// ---- 巡回先の管理 ----
async function loadSources() {
  const el = $("src-list");
  if (!el) return;
  const rows = await fetch("/api/sources").then((r) => r.json()).catch(() => []);
  if (!rows.length) { el.innerHTML = '<p class="msg">巡回先がありません</p>'; return; }
  el.innerHTML = rows.map((s) => {
    const state = s.last_error
      ? `<span class="ng">✗ ${escapeHtml(s.last_error.slice(0, 40))}</span>`
      : s.last_ok
        ? `<span class="ok">✓ ${escapeHtml(s.last_ok)} に ${s.found_count}件</span>`
        : '<span class="msg">未巡回</span>';
    return `<div class="src-row${s.enabled ? "" : " off"}">
      <label class="src-on">
        <input type="checkbox" ${s.enabled ? "checked" : ""}
               onchange="toggleSource(${s.id}, this.checked)">
      </label>
      <div class="src-main">
        <a href="${safeUrl(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.name)}</a>
        <div class="src-meta">${state} ／ 取り込み先: ${escapeHtml(s.category || "reserve")}</div>
      </div>
      <button class="mini" onclick="delSource(${s.id})">削除</button>
    </div>`;
  }).join("");
}

window.toggleSource = async (id, on) => {
  await writeFetch(`/api/sources/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: on }),
  });
  loadSources();
};

window.delSource = async (id) => {
  if (!confirm("この巡回先を削除しますか？（取り込み済みの情報は残ります）")) return;
  await writeFetch(`/api/sources/${id}`, { method: "DELETE" });
  loadSources();
};

async function addSource() {
  const url = $("src-url").value.trim();
  const name = $("src-name").value.trim();
  if (!url) { $("src-msg").textContent = "URLを入力してください"; return; }
  $("src-msg").textContent = "このページから取り込めるか試しています…";
  const res = await writeFetch("/api/sources", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, name: name || url, category: $("src-cat").value }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    $("src-msg").textContent = "追加できません: " + (e.detail || "エラー");
    return;
  }
  const r = await res.json();
  $("src-msg").textContent = r.error
    ? `追加しましたが、取得に失敗しました（${r.error.slice(0, 50)}）。URLを確認してください`
    : r.found
      ? `✅ 追加しました。試しに ${r.found} 件を検出: ${r.samples.join(" / ").slice(0, 60)}`
      : "追加しました。ただし今回は何も検出できませんでした（日付が無いページかもしれません）";
  $("src-url").value = "";
  $("src-name").value = "";
  loadSources();
}

function bindForm() {
  $("draft-btn").addEventListener("click", makeDraft);
  $("add-btn").addEventListener("click", addFromUrl);
  $("src-add").addEventListener("click", addSource);
  loadSources();
  $("item-form").addEventListener("submit", saveItem);
  $("i-reset").addEventListener("click", resetForm);
}

/** URLを貼るだけで登録まで完了させる。まとめページなら複数件まとめて入る。 */
async function addFromUrl() {
  const url = $("draft-url").value.trim();
  if (!url) { $("draft-msg").textContent = "URLを入力してください"; return; }
  const btn = $("add-btn");
  btn.disabled = true;
  $("draft-msg").textContent = "読み取り中…";
  try {
    const res = await writeFetch("/api/items/from_url", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      $("draft-msg").textContent = "登録できませんでした（合言葉やURLを確認してください）";
      return;
    }
    const r = await res.json();
    if (r.count > 0) {
      $("draft-msg").textContent =
        `✅ ${r.count}件を「要確認」で登録しました: ${r.created.join(" / ").slice(0, 80)}`;
      $("draft-url").value = "";
      await loadItems();
    } else {
      $("draft-msg").textContent =
        "登録できる情報が見つかりませんでした。" +
        (r.skipped && r.skipped.length ? `（${r.skipped[0]}）` : "") +
        " 『内容を確認してから追加』で手入力できます。";
    }
  } catch (e) {
    $("draft-msg").textContent = "通信に失敗しました";
  } finally {
    btn.disabled = false;
  }
}

async function makeDraft() {
  const url = $("draft-url").value.trim();
  if (!url) return;
  $("draft-msg").textContent = "取得中…";
  try {
    const d = await fetch("/api/draft", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (d.title) $("i-title").value = d.title;
    if (d.tcg_key) $("i-tcg").value = d.tcg_key;
    if (d.shop_id) $("i-shop").value = d.shop_id;      // 店舗を自動判別
    if (d.method) $("i-method").value = d.method;      // 抽選/先着も推測
    if (d.reserve_start) $("i-rstart").value = d.reserve_start;
    if (d.reserve_end) $("i-rend").value = d.reserve_end;
    if (d.lottery_date) $("i-lot").value = d.lottery_date;
    if (d.release_date) $("i-rel").value = d.release_date;
    $("i-url").value = d.source_url || url;
    $("draft-msg").textContent = d.note || "下書きを作成しました。内容を確認して保存してください。";
  } catch (e) {
    $("draft-msg").textContent = "取得に失敗しました。手入力してください。";
  }
}

function formPayload() {
  return {
    tcg_key: $("i-tcg").value,
    title: $("i-title").value.trim(),
    shop_id: $("i-shop").value ? Number($("i-shop").value) : null,
    method: $("i-method").value,
    reserve_start: $("i-rstart").value.trim() || null,
    reserve_end: $("i-rend").value.trim() || null,
    lottery_date: $("i-lot").value.trim() || null,
    release_date: $("i-rel").value.trim() || null,
    source_url: $("i-url").value.trim() || null,
    source_type: $("i-url").value.includes("x.com") || $("i-url").value.includes("twitter.com") ? "x"
      : ($("i-url").value ? "web" : "manual"),
    status: $("i-status").value,
    note: $("i-note").value.trim() || null,
  };
}

async function saveItem(e) {
  e.preventDefault();
  const id = $("i-id").value;
  const payload = formPayload();
  const url = id ? `/api/items/${id}` : "/api/items";
  const method = id ? "PATCH" : "POST";
  const res = await writeFetch(url, {
    method, headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) { alert("保存できませんでした（合言葉を確認してください）"); return; }
  resetForm();
  document.querySelector('.tab[data-view="list"]').click();
  await loadItems();
}

window.editItem = (id) => {
  const it = ITEMS.find((x) => x.id === id);
  if (!it) return;
  $("i-id").value = it.id;
  $("i-title").value = it.title || "";
  $("i-tcg").value = it.tcg_key || "";
  $("i-shop").value = it.shop_id || "";
  $("i-method").value = it.method || "未定";
  $("i-status").value = it.status || "review";
  $("i-rstart").value = it.reserve_start || "";
  $("i-rend").value = it.reserve_end || "";
  $("i-lot").value = it.lottery_date || "";
  $("i-rel").value = it.release_date || "";
  $("i-url").value = it.source_url || "";
  $("i-note").value = it.note || "";
  document.querySelector('.tab[data-view="add"]').click();
};

window.delItem = async (id) => {
  if (!confirm("この情報を削除しますか？")) return;
  const res = await writeFetch(`/api/items/${id}`, { method: "DELETE" });
  if (!res.ok) { alert("削除できませんでした（合言葉を確認してください）"); return; }
  await loadItems();
};

function resetForm() {
  $("item-form").reset();
  $("i-id").value = "";
  $("draft-url").value = "";
  $("draft-msg").textContent = "";
}

// ---- カレンダー ----
function bindCalendar() {
  $("cal-prev").addEventListener("click", () => { shiftMonth(-1); });
  $("cal-next").addEventListener("click", () => { shiftMonth(1); });
}
function shiftMonth(d) {
  calMonth += d;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
}

// "2026-08-01" / "2026/8/1" / "8/1" を {y,m,d} に解釈する。
// 年月だけの "2026-08" は日が無いので null を返す（カレンダーには置けないため）。
function parseDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  // 年つき（年・月・日がそろっているものだけ）
  const full = t.match(/(20\d{2})[./年-]\s*(\d{1,2})[./月-]\s*(\d{1,2})/);
  if (full) return validYMD(Number(full[1]), Number(full[2]), Number(full[3]));
  // 年なし「8/1」「8月1日」。ただし "2026-08" の "26-08" を拾わないよう先頭から見る
  const md = t.match(/^(\d{1,2})[./月]\s*(\d{1,2})/);
  if (md) return validYMD(calYear, Number(md[1]), Number(md[2]));
  return null;
}

/** 月13以上・日32以上のような、日付として成立しない値を弾く */
function validYMD(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

/** 「2026-09」のように日が無い表記も拾う。日が不明なら d=null を返す。 */
function parseLooseDate(s) {
  if (!s) return null;
  const full = String(s).match(/(20\d{2})[./年-]\s*(\d{1,2})[./月-]\s*(\d{1,2})/);
  if (full) return { y: +full[1], m: +full[2], d: +full[3], raw: s };
  const ym = String(s).match(/(20\d{2})[./年-]\s*(\d{1,2})月?$/);
  if (ym) return { y: +ym[1], m: +ym[2], d: null, raw: s };
  const md = String(s).match(/^(\d{1,2})[./月]\s*(\d{1,2})/);
  if (md) return { y: new Date().getFullYear(), m: +md[1], d: +md[2], raw: s };
  return null;
}

/** 最新弾の公式発売日をタイトル別に1件ずつ拾って、目立つ形で表示する。 */
function renderUpcomingReleases() {
  const el = $("next-releases");
  if (!el) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);

  // タイトルごとに「今日以降で最も近い発売日」を選ぶ
  const best = {};
  for (const it of ITEMS) {
    const p = parseLooseDate(it.release_date);
    if (!p) continue;
    const dt = new Date(p.y, p.m - 1, p.d || 1);
    if (dt < today) continue;                       // 過ぎたものは出さない
    const cur = best[it.tcg_key];
    if (!cur || dt < cur.dt) best[it.tcg_key] = { dt, p, it };
  }

  const list = META.tcgs.map((t) => best[t.key] && { ...best[t.key], tcg: t })
                        .filter(Boolean)
                        .sort((a, b) => a.dt - b.dt);
  if (!list.length) {
    el.innerHTML = '<p class="msg">今後の発売予定が登録されていません</p>';
    return;
  }

  el.innerHTML = list.map(({ dt, p, it, tcg }) => {
    const days = Math.round((dt - today) / 86400000);
    const when = days === 0 ? "本日発売！" : days === 1 ? "明日発売" : `あと ${days} 日`;
    const dateTxt = p.d ? `${p.m}月${p.d}日` : `${p.m}月（日付未定）`;
    return `<div class="rel-card${days <= 7 ? " soon" : ""}">
      <span class="rel-tcg">${escapeHtml(tcg.name)}</span>
      <span class="rel-date">${p.y}年${dateTxt}</span>
      <span class="rel-days">${when}</span>
      <span class="rel-title">${escapeHtml(it.title)}</span>
    </div>`;
  }).join("");
}

function renderCalendar() {
  renderUpcomingReleases();
  $("cal-label").textContent = `${calYear}年 ${calMonth + 1}月`;
  const first = new Date(calYear, calMonth, 1);
  const startDow = first.getDay();
  const days = new Date(calYear, calMonth + 1, 0).getDate();

  // 日付→イベント配列
  const evMap = {};
  const add = (val, cls, label, title) => {
    const p = parseDate(val);
    if (!p || p.y !== calYear || p.m !== calMonth + 1) return;
    (evMap[p.d] ||= []).push({ cls, label, title });
  };
  for (const it of ITEMS) {
    add(it.reserve_start, "start", "予約開始", it.title);
    add(it.reserve_end, "end", "締切", it.title);
    add(it.lottery_date, "lot", "当選発表", it.title);
    add(it.release_date, "rel", "発売", it.title);
  }

  const cal = $("calendar");
  cal.innerHTML = "";
  ["日","月","火","水","木","金","土"].forEach((d) => {
    const c = document.createElement("div");
    c.className = "cal-cell dow"; c.textContent = d; cal.appendChild(c);
  });
  for (let i = 0; i < startDow; i++) {
    const c = document.createElement("div"); c.className = "cal-cell empty"; cal.appendChild(c);
  }
  for (let day = 1; day <= days; day++) {
    const c = document.createElement("div");
    const evs = evMap[day] || [];
    // 発売日のマスは枠ごと強調する（公式発売日を見落とさないため）
    const isRelease = evs.some((e) => e.cls === "rel");
    c.className = "cal-cell" + (isRelease ? " release-day" : "");
    c.innerHTML = `<div class="cal-num">${day}</div>`;
    // 発売を先頭に持ってきて目立たせる
    for (const ev of evs.slice().sort((a, b) => (a.cls === "rel" ? -1 : b.cls === "rel" ? 1 : 0))) {
      const star = ev.cls === "rel" ? "🎉 " : "";
      c.innerHTML += `<span class="cal-ev ${ev.cls}" title="${escapeHtml(ev.title)}（${ev.label}）">${star}${ev.label}: ${escapeHtml(ev.title.slice(0, 8))}</span>`;
    }
    cal.appendChild(c);
  }
}

// ---- PWA: サービスワーカー登録（対応ブラウザのみ・失敗しても本体は動く）----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/static/sw.js").catch(() => {});
  });
}

// オフライン時は「表示中の情報が最新でない可能性」を明示する
function bindOnline() {
  const paint = () => {
    const el = $("refresh-status");
    if (!el) return;
    let bar = document.getElementById("offline-bar");
    if (!navigator.onLine) {
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "offline-bar";
        bar.className = "offline-bar";
        bar.textContent = "⚠️ オフラインです。表示中の予約日程は最新でない可能性があります。";
        el.parentNode.insertBefore(bar, el);
      }
    } else if (bar) {
      bar.remove();
    }
  };
  window.addEventListener("online", paint);
  window.addEventListener("offline", paint);
  paint();
}

init();
bindOnline();
// 起動時と、開いている間は1時間ごとに通知の要否を確認する
setTimeout(checkAlerts, 5000);
setInterval(checkAlerts, 60 * 60 * 1000);
