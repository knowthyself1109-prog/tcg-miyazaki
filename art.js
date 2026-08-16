/* ジャンル／パックのビジュアルを生成する。
   公式ロゴ・キャラクター画像は著作権があるため使わず、
   タイトルごとの配色と抽象的な図形だけでオリジナルの絵を作る。 */

// タイトル別の配色と模様。色はそのゲームの一般的なイメージに寄せた独自配色。
const GENRE_ART = {
  pokemon:  { c1: "#ffcb05", c2: "#e3350d", ink: "#1a1d27", motif: "circles", label: "ポケカ" },
  yugioh:   { c1: "#8b5cf6", c2: "#c9a227", ink: "#0f1117", motif: "diamond", label: "遊戯王" },
  onepiece: { c1: "#e11d48", c2: "#1f2937", ink: "#fff8e7", motif: "waves",   label: "ワンピ" },
  gundam:   { c1: "#2563eb", c2: "#dc2626", ink: "#f8fafc", motif: "mech",    label: "ガンダム" },
  naruto:   { c1: "#f97316", c2: "#1e3a8a", ink: "#fff7ed", motif: "spiral",  label: "ナルト" },
};
const DEFAULT_ART = { c1: "#64748b", c2: "#334155", ink: "#f1f5f9", motif: "circles", label: "TCG" };

const artOf = (key) => GENRE_ART[key] || DEFAULT_ART;

/** 模様（ジャンルごとに違う抽象パターン） */
function motifPaths(motif, ink) {
  const o = `fill="none" stroke="${ink}" stroke-opacity=".28" stroke-width="2"`;
  switch (motif) {
    case "diamond":
      return `<path d="M60 8 L112 60 L60 112 L8 60Z" ${o}/>
              <path d="M60 30 L90 60 L60 90 L30 60Z" ${o}/>`;
    case "waves":
      return `<path d="M0 78 q15 -12 30 0 t30 0 t30 0 t30 0" ${o}/>
              <path d="M0 94 q15 -12 30 0 t30 0 t30 0 t30 0" ${o}/>
              <path d="M0 62 q15 -12 30 0 t30 0 t30 0 t30 0" ${o}/>`;
    case "mech":
      return `<path d="M18 24 h34 v10 h-24 v52 h-10Z" ${o}/>
              <path d="M102 96 h-34 v-10 h24 v-52 h10Z" ${o}/>
              <circle cx="60" cy="60" r="13" ${o}/>`;
    case "spiral":
      return `<path d="M60 60 m0 -6 a6 6 0 1 1 -6 6 a12 12 0 1 0 12 -12 a20 20 0 1 0 -20 20 a30 30 0 1 0 30 -30" ${o}/>`;
    default: // circles
      return `<circle cx="60" cy="60" r="34" ${o}/>
              <circle cx="60" cy="60" r="20" ${o}/>
              <path d="M18 60 h84" ${o}/>`;
  }
}

/** ジャンルタブ用のアイコン（正方形） */
function genreArtSVG(key, size = 120) {
  const a = artOf(key);
  const id = "g" + key + Math.random().toString(36).slice(2, 6);
  return `<svg viewBox="0 0 120 120" width="${size}" height="${size}" aria-hidden="true">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${a.c1}"/><stop offset="1" stop-color="${a.c2}"/>
      </linearGradient>
    </defs>
    <rect width="120" height="120" rx="18" fill="url(#${id})"/>
    ${motifPaths(a.motif, a.ink)}
  </svg>`;
}

/** 画像が読めなかったとき（403のホットリンク制限など）に自作の絵へ差し替える。
    属性へSVGを直接埋め込むと壊れやすいので、data-属性から作り直す。 */
function packFallback(img) {
  const box = img.parentNode;
  if (!box) return;
  box.innerHTML = packArtSVG(box.dataset.title || "", box.dataset.tcg || "");
}

/** 「すべて」タブ用。5タイトルの色を扇状に並べたアイコン。 */
function allGenresArt(size = 120) {
  const keys = Object.keys(GENRE_ART);
  const id = "all" + Math.random().toString(36).slice(2, 6);
  const slices = keys.map((k, i) => {
    const a = GENRE_ART[k];
    const x = (120 / keys.length) * i;
    return `<rect x="${x}" y="0" width="${120 / keys.length + 0.5}" height="120" fill="${a.c1}"/>`;
  }).join("");
  return `<svg viewBox="0 0 120 120" width="${size}" height="${size}" aria-hidden="true">
    <defs><clipPath id="${id}"><rect width="120" height="120" rx="18"/></clipPath></defs>
    <g clip-path="url(#${id})">${slices}
      <circle cx="60" cy="60" r="30" fill="#0f1117" opacity=".55"/>
      <path d="M42 60 h36 M60 42 v36" stroke="#fff" stroke-opacity=".8" stroke-width="3"/>
    </g>
  </svg>`;
}

/** 文字列から安定した数値（同じ商品名なら毎回同じ絵になるように） */
function hashOf(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** パック／BOXの箱をイメージした絵。商品名から模様が決まる。 */
let artSeq = 0;   // SVGのid衝突を避けるための連番

function packArtSVG(title, tcgKey, w = 300, h = 170) {
  const a = artOf(tcgKey);
  const n = hashOf(title);
  // ハッシュだけだと同一ページ内でidが衝突し、別カードの配色が混ざることがある
  const id = "p" + (n % 99999) + "_" + (artSeq++);
  const tilt = (n % 5) - 2;                   // 箱の傾き
  const bars = 3 + (n % 3);                   // 帯の本数
  let deco = "";
  for (let i = 0; i < bars; i++) {
    const y = 40 + i * 14 + (n % 7);
    deco += `<rect x="112" y="${y}" width="${60 + ((n >> i) % 40)}" height="5" rx="2.5"
              fill="${a.ink}" opacity="${0.18 + i * 0.06}"/>`;
  }
  return `<svg viewBox="0 0 300 170" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <linearGradient id="bg${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${a.c1}"/><stop offset="1" stop-color="${a.c2}"/>
      </linearGradient>
      <linearGradient id="bx${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity=".95"/>
        <stop offset="1" stop-color="#ffffff" stop-opacity=".72"/>
      </linearGradient>
    </defs>
    <rect width="300" height="170" fill="url(#bg${id})"/>
    <g opacity=".35">${motifPaths(a.motif, a.ink)}</g>
    <!-- 箱（正面＋側面）で立体感を出す -->
    <g transform="translate(30 26) rotate(${tilt} 45 60)">
      <path d="M0 12 L46 0 L46 108 L0 120Z" fill="${a.ink}" opacity=".35"/>
      <rect x="46" y="0" width="72" height="108" rx="4" fill="url(#bx${id})"/>
      <rect x="46" y="0" width="72" height="26" rx="4" fill="${a.c2}" opacity=".85"/>
      ${deco}
    </g>
  </svg>`;
}
