(() => {
"use strict";

// NEG_GUARD is appended to every job's negative prompt; POS_GUARD is intentionally empty.
const POS_GUARD = "";
const NEG_GUARD = "";
// Sentence-style guards for the photoreal model types (Klein, Z-Image).
const KLEIN_POS_GUARD = "";
const KLEIN_NEG_GUARD = "";
// Photoreal, natural-language model types (Klein, Z-Image) share the sentence-style guards above.
const isPhotoEngine = (e) => e === "klein" || e === "zimage";
// Single-file checkpoints (model + text encoder + VAE in one file): SDXL and SD 1.5.
const isCkptEngine = (e) => e === "sdxl" || e === "sd15";

const ENGINE_LABEL = { sdxl: "SDXL", sd15: "SD1.5", anima: "Anima", klein: "Klein", zimage: "Z-Image" };
const ENGINE_DEFAULTS = {
  sdxl:  { steps: 28, cfg: 6, sampler: "euler_ancestral", scheduler: "normal", clipSkip: "2", strength: 0.8 },
  sd15:  { steps: 28, cfg: 7, sampler: "euler_ancestral", scheduler: "normal", clipSkip: "2", strength: 0.8 },
  anima: { steps: 30, cfg: 4, sampler: "er_sde", scheduler: "simple", strength: 1.0 },
  klein: { steps: 4, cfg: 1.5, sampler: "euler", scheduler: "simple", strength: 1.0 },
  // Z-Image Turbo defaults.
  zimage: { steps: 10, cfg: 1.5, sampler: "euler", scheduler: "simple", strength: 1.0 },
};
// Fixed prompts and trigger words the LoRAs were trained with (from their model cards); used until you type your own.
const DEFAULT_TRIGGERS = {};   // {"file.safetensors": "trigger words"}
const QUALITY = {
  pony:  { q: "score_9, score_8_up, score_7_up", n: "score_4, score_5, score_6, worst quality, low quality, bad anatomy, bad hands, jpeg artifacts, watermark, signature, blurry" },
  sdxl:  { q: "masterpiece, best quality, amazing quality, very aesthetic, absurdres", n: "lowres, worst quality, bad quality, bad anatomy, bad hands, extra digits, fewer digits, jpeg artifacts, signature, watermark, username, blurry" },
  sd15:  { q: "masterpiece, best quality", n: "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry" },
  anima: { q: "masterpiece, best quality, score_7", n: "worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration" },
  klein: { q: "", n: "blurry, low quality, deformed hands, extra fingers, bad anatomy, watermark, text" },
  // "text" and "logo" are left out on purpose: Z-Image is the model for ads with readable text.
  zimage: { q: "", n: "blurry, low quality, lowres, jpeg artifacts, oversaturated, overexposed, distorted anatomy, deformed hands, extra fingers, extra limbs, bad proportions, disfigured face, watermark, signature, cropped, out of frame, duplicate, ugly, noisy, grainy" },
};
// Settings recommended on the model cards (Civitai / Hugging Face), on top of the model type's defaults.
const MODEL_SPECS = [];   // [engine, /model file name/, {steps, cfg, sampler, scheduler, clipSkip}]
const SPEC_KEYS = ["steps", "cfg", "sampler", "scheduler", "clipSkip"];
function recSpecs(engine, model) {
  const d = ENGINE_DEFAULTS[engine], out = {};
  for (const k of SPEC_KEYS) if (d[k] != null) out[k] = d[k];
  for (const [en, re, s] of MODEL_SPECS) if (en === engine && re.test(model || "")) Object.assign(out, s);
  return out;
}
// Each model keeps its own steps/CFG/sampler/scheduler: the recommended ones until you change them for that model.
const specsFor = (e, model) => (e.specs || {})[model] || recSpecs(S.engine, model);
function setModel(e, model) {
  if (!e.specs) { e.specs = {}; delete e.stepSets; delete e.modelSched; e.model = ""; }
  if (e.model !== model) Object.assign(e, specsFor(e, model));
  e.model = model;
}
// The settings a job runs with on another model of the same type (multi-model runs).
function engFor(model) {
  const e = E(), qk = qualityKey(S.engine, e.model), mk = qualityKey(S.engine, model);
  return Object.assign({}, e, specsFor(e, model), { model },
    qk !== mk && e.quality === QUALITY[qk].q ? { quality: QUALITY[mk].q } : {},
    qk !== mk && e.negative === QUALITY[qk].n ? { negative: QUALITY[mk].n } : {});
}
const qualityKey = (engine, model) => engine !== "sdxl" ? engine : (/pony/i.test(model || "") ? "pony" : "sdxl");

const $ = (id) => document.getElementById(id);
const clientId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)) ;
const store = {
  get(k, d) { try { const v = localStorage.getItem("loraLab." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("loraLab." + k, JSON.stringify(v)); } catch {} },
};

// ---------- state ----------
// Two workspaces (General and Adult 18+), each with its own saved state and results, so they never mix.
// The single state saved before workspaces existed becomes the Adult workspace.
if (!store.get("state.general", null) && !store.get("state.adult", null) && store.get("state", null)) {
  store.set("state.adult", store.get("state", {}));
  store.set("batches.adult", store.get("batches", []));
}
// Character pictures moved from LoRA-Lab/<day>/<name> to LoRA-Lab/characters/<name>/<day> (2026-10-11).
const OLD_CHAR_DIR = /^LoRA-Lab[\\/](\d{4}-\d\d-\d\d)[\\/]([^\\/]+)$/;
for (const m of ["general", "adult", "story"]) {
  const list = store.get("batches." + m, []);
  let moved = 0;
  for (const b of list) for (const c of b.cells || []) if (c.image && OLD_CHAR_DIR.test(c.image.subfolder || "")) {
    c.image.subfolder = c.image.subfolder.replace(OLD_CHAR_DIR, "LoRA-Lab/characters/$2/$1"); moved++;
  }
  if (moved) store.set("batches." + m, list);
}
// Day folders moved into month folders: LoRA-Lab/<day> to LoRA-Lab/<yyyy-mm>/<day> (2026-11-08).
const OLD_DAY_DIR = /^LoRA-Lab[\\/](\d{4}-\d\d)(-\d\d)$/;
for (const m of ["general", "adult", "story"]) {
  const list = store.get("batches." + m, []);
  let moved = 0;
  for (const b of list) for (const c of b.cells || []) if (c.image && OLD_DAY_DIR.test(c.image.subfolder || "")) {
    c.image.subfolder = c.image.subfolder.replace(OLD_DAY_DIR, "LoRA-Lab/$1/$1$2"); moved++;
  }
  if (moved) store.set("batches." + m, list);
}
let mode =["adult", "story"].includes(store.get("mode", "general")) ? store.get("mode") : "general";
const defaultState = () => ({
  engine: "sdxl",
  prompt: "1girl, solo, long silver hair, golden eyes, elegant black kimono, standing on a wooden bridge, cherry blossoms, night, lanterns, soft lighting, looking at viewer, smile",
  size: "832x1216", w: 832, h: 1216, count: 1, seed: rand(), autoSeed: false,
  baseline: true, loraMix: true, showAll: false, thumb: 220, refThr: 0.35, refChars: true, tagModels: ["pixai", "haruka"],
  // refNameThr 0.6: on 120 recent Danbooru posts it kept 65% of characters with 2 wrong names (0.85 kept 59%, 0.35 had 12 wrong).
  // tagAdvanced off = the one Kōbō tagger (PixAI + Haruka); tagModels is only used when it's on.
  refNameThr: 0.6, refSimple: true, tagAdvanced: false,
  refUpload: null, refSize: null, useRef: false, denoise: 0.6, kleinRefMode: "reference", extraRefs: [null, null],
  ipaMode: "look", ipaWeight: 0.5, snapMode: "cs", snapWeight: 1,
  loraTab: "general",
  charId: "", charUse: { appearance: true, outfit: true, loras: true, ref: false, face: true }, faceWeight: 0.5, newLook: "ai",
  seq: { on: false, count: 4, story: "", beats: [], sameSeed: true, carry: true },
  poseUpload: null, poseSize: null, poseOn: true, poseKind: "pose", poseStrength: 0.9, poseDark: true,
  detail: 0, teaCache: "fast", couple: { on: false, left: "", right: "" },
  eng: {},
  loras: {},
  showGenLoras: false,
});
// The Story workspace draws with Anima or SDXL checkpoints only.
const STORY_ENGINES = ["anima", "sdxl"], STORY_SDXL = /./;
function loadWorkspace(m) {
  const fresh = m === "story" ? { engine: "anima", baseline: false, prompt: "",
    loras: {} } : {};
  const st = Object.assign(defaultState(), fresh, store.get("state." + m, {}));
  if (m === "story" && !STORY_ENGINES.includes(st.engine)) st.engine = "anima";
  // "Only the pose" became the sketch default (2026-10-25): switch saved workspaces over once.
  if (!st.posePoseOnly) { st.poseKind = "pose"; st.posePoseOnly = true; }
  // The Haruka tagger joined (2026-11-17): tick it once for every workspace (PixAI+Haruka finds more characters).
  if (!st.harukaOn) { st.tagModels = [...new Set([...(st.tagModels || []), "haruka"])]; st.harukaOn = true; }
  for (const e of Object.keys(ENGINE_DEFAULTS)) st.eng[e] = Object.assign({}, ENGINE_DEFAULTS[e], st.eng[e] || {});
  return st;
}
const S = loadWorkspace(mode);
// Adult and Story both allow 18+ content (a Story picks its own level); General never does.
const adultMode = () => mode !== "general";
const save = () => store.set("state." + mode, S);
const E = () => S.eng[S.engine];

let lists = { checkpoints: [], diffusion_models: [], text_encoders: [], vae: [], loras: [], samplers: [], schedulers: [],
  unet_gguf: [], unet: [], clip_gguf: [], upscale: [], bgRemoval: [], ipadapter: [], clipVision: [], controlnet: [], modelPatches: [], sdpose: [], asaMesh: false, faceFix: false };
let loraInfo = {};   // name -> {family, pony, tags[]}
let ckptFamily = {}; // checkpoint name -> "sdxl" | "sd15" | "other", read from the file header by the server
let batches = store.get("batches." + mode, []);   // persisted results of this workspace
const jobs = new Map(); // prompt_id -> {batchId, idx}
let runningId = null;

function rand() { return Math.floor(Math.random() * 2 ** 32); }
function toast(msg, ok) { const t = $("toast"); t.textContent = msg; t.className = "toast" + (ok ? " ok" : ""); t.style.display = "block"; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = "none", ok ? 2500 : 7000); }
async function api(path, opts) {
  const r = await fetch(path, opts);
  const txt = await r.text();
  let body; try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
  if (!r.ok) { const e = new Error((body && body.error && (body.error.message || body.error)) || r.statusText); e.body = body; throw e; }
  return body;
}
const post = (path, data) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
const joinTags = (parts) => parts.map(p => (p || "").trim().replace(/^,+|,+$/g, "").trim()).filter(Boolean).join(", ");
// Tag layout (from Desktop	ag layout.txt): one line per slot, joined in this order into S.prompt. "quality" is the Quality tags box (buildGraph already puts it first).
const TL_ROWS = [
  ["quality", "Quality", "masterpiece, best quality, score_7"],
  ["rating", "Rating", "safe / sensitive / nsfw / explicit"],
  ["count", "Count", "solo / 1girl / 2girls / 1girl, 1boy"],
  ["artist", "Artist / style", "@artistname"],
  ["-"],
  ["c1", "Character", "name, series (OC: hair colour, hair style, eye colour, body)"],
  ["c1e", "↳ expression", "smile, blush", "sub"],
  ["c1c", "↳ clothes", "office lady, white blouse, black pencil skirt", "sub"],
  ["-"],
  ["c2", "Character 2", "name, series (OC: hair colour, hair style, eye colour, body)"],
  ["c2e", "↳ expression", "serious", "sub"],
  ["c2c", "↳ clothes", "black jacket, white shirt", "sub"],
  ["-"],
  ["pose", "Pose", "standing, looking at viewer"],
  ["acts", "Acts", "holding hands, walking"],
  ["camera", "Camera", "cowboy shot, from side"],
  ["scene", "Scene / background", "outdoors, city street, night, rain"],
  ["light", "Lighting / mood", "neon lights, rim light, depth of field"],
];
function renderTagLayout() {
  const box = $("tlBox"), grid = $("tlGrid");
  box.style.display = isPhotoEngine(S.engine) ? "none" : "";
  if (!grid.children.length) {
    grid.innerHTML = TL_ROWS.map(([k, label, ph, cls]) => k === "-" ? '<div class="tlsep"></div>'
      : `<label class="${cls || ""}" for="tl_${k}">${label}</label>` + (k === "quality"
        ? `<div class="inline"><input type="text" id="tl_${k}" data-k="${k}" placeholder="${ph}" style="flex:1;min-width:0"><button class="btn sm" id="qualityReset" title="Reset to model default">↺</button></div>`
        : `<input type="text" id="tl_${k}" data-k="${k}" placeholder="${ph}">`)).join("");
    grid.addEventListener("input", (ev) => {
      const k = ev.target.dataset.k; if (!k) return;
      if (k === "quality") { E().quality = ev.target.value; save(); return; }
      S.tl = { ...(S.tl || {}), [k]: ev.target.value };
      S.prompt = $("prompt").value = joinTags(TL_ROWS.filter(r => r[0] !== "-" && r[0] !== "quality").map(r => S.tl[r[0]]));
      save(); updateSummary();
    });
    $("qualityReset").onclick = () => { E().quality = QUALITY[qualityKey(S.engine, E().model)].q; save(); renderSettings(); };
    $("tlClear").onclick = () => { S.tl = {}; S.prompt = $("prompt").value = ""; save(); renderTagLayout(); updateSummary(); };
    box.addEventListener("toggle", () => { S.tlOpen = box.open; save(); });
  }
  box.open = S.tlOpen === true;   // starts folded; remembers when you open it
  for (const r of TL_ROWS) if (r[0] !== "-") $("tl_" + r[0]).value = r[0] === "quality" ? (E().quality || "") : ((S.tl || {})[r[0]] || "");
}
// Typing in the prompt sorts its tags into the Tag layout lines (keyword guesses; anything unrecognised lands on Character).
// Quality tags are skipped: they live in their own box and buildGraph adds them.
const OUTFIT_RE = /(dress|shirt|skirt|jacket|coat|glove|boot|shoe|hat\b|ribbon|bow\b|bowtie|uniform|kimono|sock|thighhighs|pantyhose|leotard|bikini|swimsuit|sleeve|collar|necktie|scarf|cape|armor|apron|hood|vest|pants|shorts|belt|earring|necklace|choker|glasses|eyewear|hairband|hair ornament|hairclip|hair flower|hair ribbon|hair bow|bra\b|panties|lingerie|sweater|hoodie|sandal|heels|tiara|crown|mask|obi|sash|bodysuit)/;
const TL_SORT = [
  ["artist", /^@/],
  ["rating", /^(safe|sensitive|nsfw|explicit|questionable|general)$/],
  ["count", /^(solo|\d+\+?(girl|boy|other)s?|multiple (girls|boys)|no humans)$/],
  ["camera", /(\bshot$|^from (above|below|behind|side|front)|^pov|close-up|upper body|full body|lower body|portrait|dutch angle|fisheye|wide angle|out of frame)/],
  ["light", /(light|lighting|shadow|glow|bloom|depth of field|blurry|bokeh|backlit|sunset|film grain|chromatic)/],
  ["scene", /(outdoors|indoors|background|^night$|^day$|rain|snow|city|street|\broom\b|\bsky\b|forest|beach|field|garden|school|classroom|bedroom|bathroom|kitchen|building|\bsea\b|ocean|mountain|cloud|window|\bbed\b|\bpark\b|cafe|temple)/],
  ["acts", /^(holding|walking|running|eating|drinking|reading|playing|dancing|fighting|hug|kiss|jumping|sleeping|smoking|singing|waving|pointing|carrying|riding|swimming|cooking)/],
  ["pose", /(standing|sitting|lying|kneeling|squatting|crouching|leaning|looking|^arms |^hands? |^legs |spread|on back|on side|on stomach|all fours|bent over)/],
  ["c1e", /(smile|smiling|blush|frown|angry|sad\b|crying|tears|open mouth|closed mouth|laughing|serious|expression|embarrassed|surprised|grin|pout|wink|nervous|annoyed|happy)/],
  ["c1c", OUTFIT_RE],
];
const TL_QUALITY_RE = /^(masterpiece|best quality|high quality|good quality|normal quality|low quality|worst quality|score \d.*|newest|recent|absurdres|highres|very aesthetic|amazing quality)$/;
function fillLayoutFromPrompt() {
  if (isPhotoEngine(S.engine)) return;
  const lines = {};
  for (const tag of splitTags($("prompt").value)) {
    const n = normTag(tag);
    if (TL_QUALITY_RE.test(n)) continue;
    const key = (TL_SORT.find(([, re]) => re.test(n)) || ["c1"])[0];
    (lines[key] ||= []).push(tag);
  }
  S.tl = Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, v.join(", ")]));
  for (const r of TL_ROWS) if (r[0] !== "-" && r[0] !== "quality") $("tl_" + r[0]).value = S.tl[r[0]] || "";
}
const stem = (n) => (n || "").replace(/\.[^.]+$/, "").split(/[\\/]/).pop();
const safe = (n) => stem(n).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "x";
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else if (v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c);
  return n;
}
function fillSelect(sel, items, value, labelFn) {
  sel.innerHTML = "";
  for (const it of items) sel.append(el("option", { value: it, text: labelFn ? labelFn(it) : it }));
  if (value != null && items.includes(value)) sel.value = value;
  else if (items.length) sel.value = items[0];
}

// ---------- loading lists ----------
async function loadModels() {
  const get = (f) => api("/models/" + f).catch(() => []);
  // Older nodes list choices as [[...]], newer ones as ["COMBO", { options: [...] }].
  const info = (node, input) => api("/object_info/" + node).then(d => {
    const spec = d[node].input.required[input];
    return Array.isArray(spec[0]) ? spec[0] : ((spec[1] || {}).options || []);
  }).catch(() => []);
  const [ck, dm, te, vae, ks, ug, un, cg] = await Promise.all([get("checkpoints"), get("diffusion_models"), get("text_encoders"), get("vae"),
    api("/object_info/KSampler").catch(() => null),
    info("UnetLoaderGGUF", "unet_name"), info("UNETLoader", "unet_name"), info("CLIPLoaderGGUF", "clip_name"),
    info("UpscaleModelLoader", "model_name").then(v => lists.upscale = v), info("LoadBackgroundRemovalModel", "bg_removal_name").then(v => lists.bgRemoval = v),
    info("IPAdapterModelLoader", "ipadapter_file").then(v => lists.ipadapter = v), info("CLIPVisionLoader", "clip_name").then(v => lists.clipVision = v),
    info("AnimaRefAdapter", "lora_name").then(v => lists.snapref = v.filter(n => /snapref/i.test(n)).sort()),
    info("ControlNetLoader", "control_net_name").then(v => lists.controlnet = v), info("ModelPatchLoader", "name").then(v => lists.modelPatches = v),
    api("/object_info/ASALabTextureFromViews").then(d => lists.asaMesh = !!d.ASALabTextureFromViews).catch(() => lists.asaMesh = false),
    api("/object_info/ASALabFaceCrop").then(d => lists.faceFix = !!d.ASALabFaceCrop).catch(() => lists.faceFix = false),
    api("/object_info/UltimateSDUpscale").then(d => lists.usdu = !!d.UltimateSDUpscale).catch(() => lists.usdu = false),
    api("/object_info/DetailDaemonSamplerNode").then(d => lists.detailDaemon = !!d.DetailDaemonSamplerNode).catch(() => lists.detailDaemon = false),
    api("/object_info/AnimaTeaCache").then(d => lists.teaCache = !!d.AnimaTeaCache).catch(() => lists.teaCache = false),
    api("/object_info/PathchSageAttentionKJ").then(d => lists.sage = !!d.PathchSageAttentionKJ).catch(() => lists.sage = false),
    api("/object_info/AnimaNormalizedAttentionGuidance").then(d => lists.nag = !!d.AnimaNormalizedAttentionGuidance).catch(() => lists.nag = false),
    api("/object_info/DiTSpectrumPatch").then(d => lists.spectrum = !!d.DiTSpectrumPatch).catch(() => lists.spectrum = false),
    api("/object_info/PCTextEncode").then(d => lists.couple = !!d.PCTextEncode).catch(() => lists.couple = false),
    api("/object_info/PCAnimaAttnCouplePatch").then(d => lists.coupleAnima = !!d.PCAnimaAttnCouplePatch).catch(() => lists.coupleAnima = false),
    api("/lora-lab/likeness/status").then(d => lists.likeness = !!d.ready).catch(() => lists.likeness = false),
    api("/lora-lab/checkpoint-families").then(r => ckptFamily = (r && r.families) || {}).catch(() => ckptFamily = {})]);
  // SDPose is a pose detector for the sketch, not a model to draw with.
  lists.sdpose = ck.filter(n => /sdpose/i.test(n)); lists.checkpoints = ck.filter(n => !/sdpose/i.test(n));
  lists.diffusion_models = dm; lists.text_encoders = te; lists.vae = vae;
  lists.unet_gguf = ug; lists.unet = un; lists.clip_gguf = cg;
  if (ks) { const req = ks.KSampler.input.required; lists.samplers = req.sampler_name[0]; lists.schedulers = req.scheduler[0]; }
}

// Klein 9B pairs with its Qwen3-8B encoder, Klein 4B with Qwen3-4B.
function kleinTE(model) {
  const want = /4b/i.test(model || "") ? /qwen_3_4b|klein-4b/i : /klein-9b|qwen_3_8b|qwen3-8b/i;
  return lists.clip_gguf.find(n => want.test(n)) || lists.clip_gguf[0];
}

function classify(name, m) {
  const s = m ? [m.ss_base_model_version, m["modelspec.architecture"], m.ss_network_module].join(" ").toLowerCase() : "";
  let family = "other";
  if (s.includes("anima") || (!m && /anima/i.test(name))) family = "anima";
  else if (s.includes("sdxl") || s.includes("stable-diffusion-xl")) family = "sdxl";
  else if (s.includes("sd_v1") || s.includes("stable-diffusion-v1")) family = "sd15";
  else if (/flux2|flux\.2|flux-2|klein/.test(s) || (!m && /klein|flux2|flux-2/i.test(name))) family = "klein";
  else if (/z[-_ ]?image|lumina2/.test(s)) family = "zimage";
  else if (s.includes("flux")) family = "flux";
  // No usable training info in the file: fall back to the file name.
  if (family === "other") {
    if (/klein|flux[-_.]?2/i.test(name)) family = "klein";
    else if (/z[-_]?image|\bzit\b/i.test(name)) family = "zimage";
    else if (/anima/i.test(name)) family = "anima";
    else if (/sd[-_ ]?1[._-]?5|sd15/i.test(name)) family = "sd15";   // e.g. LoRAs from the Train LoRA workflow: sd15_*.safetensors
    else if (/xl|pdxl|pony|illu/i.test(name)) family = "sdxl";
  }
  const base = ((m && m.ss_sd_model_name) || "").toLowerCase();
  const pony = family === "sdxl" && (base.includes("pony") || base.includes("290640") || /pdxl|pony/i.test(name));
  let tags = [], explicitShare = 0, childShare = 0, animalShare = 0;
  try {
    const freq = typeof m.ss_tag_frequency === "string" ? JSON.parse(m.ss_tag_frequency) : m.ss_tag_frequency;
    const tot = {};
    for (const ds of Object.values(freq || {})) for (const [t, c] of Object.entries(ds)) { const k = t.trim(); if (k) tot[k] = (tot[k] || 0) + c; }
    tags = Object.entries(tot).sort((a, b) => b[1] - a[1]).slice(0, 10).map(x => x[0]);
    const images = Number(m.ss_num_train_images) || Math.max(1, ...Object.values(tot));
    const share = (set) => Math.max(0, ...Object.entries(tot).filter(([t]) => set.has(normTag(t))).map(([, c]) => c)) / images;
    explicitShare = share(EXPLICIT_TRAIN_TAGS);
    childShare = share(CHILD_TRAIN_TAGS);
    animalShare = share(ANIMAL_TRAIN_TAGS);
  } catch {}
  const adult = explicitShare >= 0.03 || ADULT_NAME_RE.test(name);
  // Blocked: a known child character, or trained on a real share of child-related images.
  const blocked = BLOCKED_LORAS.has(name) || childShare >= 0.05;   // same 5% as loramerge.CHILD_SHARE
  const animal = ANIMAL_LORA_RE.test(name) || ANIMAL_LORA_RE.test(String((m && m.merge_sources) || "")) || animalShare >= 0.05;
  // The trigger word the file says it was trained with (Kōbō's own LoRAs, or "trigger word: x" in a kohya training comment).
  const trigger = ((m && m.lora_lab_trigger) || (String((m && m.ss_training_comment) || "").match(/trigger(?: word)?s?\s*:\s*([^,;\n]+)/i) || [])[1] || "").trim();
  return { family, pony, tags, adult, blocked, animal, trigger };
}
const ANIMAL_LORA_RE = /canine|horse|equine|horsecock|zoophil|bestial|feral|knot(ted)?[_ -]?(penis|cock)|animal[_ -]?(penis|genital)/i;
const ANIMAL_TRAIN_TAGS = new Set(["zoophilia", "bestiality", "animal penis", "canine penis", "horse penis", "equine penis", "knot", "knotted penis", "feral"]);
const EXPLICIT_TRAIN_TAGS = new Set(["nude", "completely nude", "naked", "nipples", "areolae", "areola", "pussy", "penis", "sex", "cum", "nsfw",
  "explicit", "breasts out", "topless", "bottomless", "vaginal", "anal", "fellatio", "paizuri", "masturbation", "pubic hair", "uncensored",
  "censored", "erection", "testicles", "ahegao", "rating explicit", "rating questionable"]);
const CHILD_TRAIN_TAGS = new Set([]);
const ADULT_NAME_RE = /(nsfw|hentai|nude|naked|lewd|nipple|niple|areola|panties|penis|pussy|cock|bulge|ass[_ -]?ripple|\bsex|cum\b|ahegao|porn|thicc|expressive_h|(^|[_ -])h([_ -]|\.|$))/i;
// Sarada Uchiha (Boruto) is a child character; this LoRA was trained on explicit images of her.
const BLOCKED_LORAS = new Set(["Dart-sarada.safetensors"]);
let loraFlags = {}, loraWords = {}, loraStrengths = {}, blockedLoras = [];
const isAdultLora = (n) => loraFlags[n] ? loraFlags[n] === "adult" : !!(loraInfo[n] || {}).adult;
// The word that switches a LoRA on: the one you typed for it, else the one its file was trained with.
const loraWord = (n) => loraWords[n] || (loraInfo[n] || {}).trigger || "";
async function loadLoraFlags() {
  try { const j = await api("/lora-lab/lora-flags"); loraFlags = j.flags || {}; loraWords = j.words || {}; loraStrengths = j.strengths || {}; } catch { loraFlags = {}; loraWords = {}; loraStrengths = {}; }
}
const loraWordTimers = {};
function setLoraWord(n, word) {
  loraWords[n] = word.trim();
  if (!loraWords[n]) delete loraWords[n];
  updateSummary();
  clearTimeout(loraWordTimers[n]);
  loraWordTimers[n] = setTimeout(async () => {
    try { const j = await post("/lora-lab/lora-flags", { name: n, word: loraWords[n] || "" }); if (j.words) loraWords = j.words; }
    catch (err) { toast(ROUTE_MISSING.test(err.message) ? "Restart Kōbō once so this is saved for all devices." : "Couldn't save: " + err.message); }
  }, 600);
}
// Always saved, even when it matches the automatic guess, so "Moved to … by you" can bring the LoRA back.
async function setLoraFlag(n, flag) {
  loraFlags[n] = flag;
  renderLoras();
  try { loraFlags = (await post("/lora-lab/lora-flags", { name: n, flag })).flags || {}; }
  catch (err) { toast(ROUTE_MISSING.test(err.message) ? "Restart Kōbō once so this is saved for all devices." : "Couldn't save: " + err.message); }
}

async function loadLoras() {
  const all = await api("/models/loras").catch(() => []);
  const missing = all.filter(n => !loraInfo[n]);
  await Promise.all([loadLoraFlags(), ...missing.map(async n => {
    let m = null;
    try { m = await api("/view_metadata/loras?filename=" + encodeURIComponent(n)); } catch {}
    loraInfo[n] = classify(n, m);
  })]);
  blockedLoras = all.filter(n => loraInfo[n].blocked);
  lists.loras = all.filter(n => !loraInfo[n].blocked);
}

// ---------- settings UI ----------
// Anima models in diffusion_models: "anima" in the name, or one of the user's own merges named without it.
const ANIMA_MERGES = /(?!)/;   // Anima merges whose file name doesn't say "anima"
const isAnimaModel = (n) => /anima/i.test(n) || ANIMA_MERGES.test(n);
const MAIN_ANIMA = /(?!)/;   // no main Anima model: the list keeps its order
function modelList() {
  if (mode === "story" && S.engine === "sdxl") return lists.checkpoints.filter(n => STORY_SDXL.test(n) && ckptFamily[n] !== "sd15");
  if (S.engine === "anima") return [...lists.diffusion_models, ...lists.unet_gguf].filter(isAnimaModel).sort((a, b) => MAIN_ANIMA.test(b) - MAIN_ANIMA.test(a));
  if (S.engine === "klein") return [...new Set([...lists.unet_gguf, ...lists.unet])].filter(n => /klein/i.test(n))
    .sort((a, b) => /9b/i.test(b) - /9b/i.test(a));
  if (S.engine === "zimage") return [...new Set([...lists.diffusion_models, ...lists.unet_gguf])].filter(n => /z[-_]?image/i.test(n));
  const ckpts = lists.checkpoints.filter(n => !is3dCheckpoint(n));
  if (S.engine === "sd15") return ckpts.filter(n => ckptFamily[n] === "sd15");
  return ckpts.filter(n => ckptFamily[n] !== "sd15");
}

function renderSettings() {
  if (mode === "story" && !STORY_ENGINES.includes(S.engine)) S.engine = "anima";
  if (S.engine === "anima") loadAcTags();   // animaArtists needs the artist names
  for (const b of $("engineSeg").children) {
    b.classList.toggle("on", b.dataset.e === S.engine);
    b.style.display = mode !== "story" || STORY_ENGINES.includes(b.dataset.e) ? "" : "none";
  }
  renderEngineThumbs(); renderPose(); renderSeq(); renderExtras();
  $("engineHint").textContent = {
    sdxl: "Anime & illustration. Prompt with tags (1girl, long hair, …). Most LoRAs are for this.",
    sd15: "Older Stable Diffusion 1.5 models (e.g. NovelAI Anime V2). Prompt with tags; uses SD1.5 LoRAs only. Most SD1.5 models want 512 × 768; NAI V2 handles up to ~1 MP.",
    anima: "Anime. Prompt with tags. Uses Anima LoRAs.",
    klein: "Photoreal. Write sentences. Best for editing photos and combining 2–3 reference images.",
    zimage: "Photoreal ads & posters. Write sentences; text in \"quotes\" is rendered. Commercial-use license.",
  }[S.engine] || "";
  const e = E();
  const models = modelList();
  fillSelect($("model"), models, e.model);
  if (!models.length) $("model").append(el("option", { value: "", text: { sdxl: "No checkpoints found", sd15: "No SD1.5 checkpoint (.safetensors) in checkpoints", anima: "No Anima model in diffusion_models", klein: "No Klein model in diffusion_models", zimage: "No Z-Image model in diffusion_models" }[S.engine] }));
  if (models.length) setModel(e, $("model").value);
  renderSpecs();
  $("sdxlExtra").style.display = isCkptEngine(S.engine) ? "" : "none";
  $("unetExtra").style.display = isCkptEngine(S.engine) ? "none" : "";
  $("schedWrap").style.display = S.engine === "klein" ? "none" : "";
  fillSelect($("vae"), ["(from checkpoint)", ...lists.vae], e.vae || "(from checkpoint)");
  $("clipSkip").value = e.clipSkip || "2";
  if (S.engine === "klein") {
    fillSelect($("te"), lists.clip_gguf, e.te || kleinTE(e.model));
    fillSelect($("avae"), lists.vae, e.avae || lists.vae.find(n => /flux2/i.test(n)));
  } else if (S.engine === "zimage") {
    fillSelect($("te"), lists.text_encoders, e.te || lists.text_encoders.find(n => /qwen_3_4b/i.test(n)));
    fillSelect($("avae"), lists.vae, e.avae || lists.vae.find(n => /^ae\./i.test(n)));
  } else {
    fillSelect($("te"), lists.text_encoders, e.te || lists.text_encoders.find(n => /qwen_3_06b/i.test(n)));
    fillSelect($("avae"), lists.vae, e.avae || lists.vae.find(n => /qwen_image/i.test(n)));
  }
  if (!isCkptEngine(S.engine)) { e.te = $("te").value; e.avae = $("avae").value; }
  $("lockNote").textContent = isPhotoEngine(S.engine)
    ? "An adults-only sentence is added to the prompt and child-related terms to the negative prompt, as in your Klein workflow."
    : "Child-related terms are always added to the negative prompt.";
  $("prompt").placeholder = S.engine === "zimage"
    ? 'Studio product shot of a white sneaker on a pastel podium, soft shadows, bold headline text "RUN LIGHTER"…'
    : S.engine === "klein" ? "A woman in a red evening dress on a balcony at night, city lights, cinematic photo…" : "1girl, solo, long silver hair, ...";
  const qk = qualityKey(S.engine, e.model);
  if (e.quality == null) e.quality = QUALITY[qk].q;
  if (e.negative == null) e.negative = QUALITY[qk].n;
  $("negativeQuick").value = e.negative;
  $("prompt").value = S.prompt;
  renderTagLayout();
  $("size").value = S.size; $("customSize").style.display = S.size === "custom" ? "" : "none";
  $("w").value = S.w; $("h").value = S.h;
  $("steps").value = $("stepsR").value = e.steps; $("cfg").value = $("cfgR").value = e.cfg; $("count").value = S.count;
  fillSelect($("sampler"), lists.samplers.length ? lists.samplers : [e.sampler], e.sampler);
  fillSelect($("scheduler"), lists.schedulers.length ? lists.schedulers : [e.scheduler], e.scheduler);
  $("seed").value = S.seed; $("autoSeed").checked = S.autoSeed;
  $("baseline").checked = S.baseline; $("loraMix").checked = S.loraMix; $("showAll").checked = S.showAll;
  $("thumb").value = S.thumb; document.documentElement.style.setProperty("--thumb", S.thumb + "px");
  renderLoras();
  renderCharActive();
  renderLibrary();
}

const specText = (s) => `${s.steps} steps · CFG ${s.cfg} · ${S.engine === "klein" ? s.sampler : s.sampler + "/" + s.scheduler}`;
const alsoModels = () => { const e = E(), ms = modelList(); return (e.also || []).filter(m => m !== e.model && ms.includes(m)); };
function renderSpecs() {
  const e = E(), own = !!e.specs[e.model], h = $("specHint");
  h.innerHTML = "";
  if (e.model) h.append(`⚙ ${specText(e)} · ${own ? "your settings for this model" : "recommended for this model"}`);
  if (e.model && own) h.append(el("button", { class: "btn sm", text: "↺ Recommended", style: "margin-left:6px", title: "Go back to this model's recommended steps, CFG, sampler and scheduler",
    onclick: () => { delete e.specs[e.model]; Object.assign(e, recSpecs(S.engine, e.model)); save(); renderSettings(); } }));
  const others = modelList().filter(m => m !== e.model), box = $("alsoModels");
  $("alsoWrap").style.display = others.length ? "" : "none";
  box.innerHTML = "";
  for (const m of others) {
    const cb = el("input", { type: "checkbox", onchange: (ev) => {
      e.also = [...alsoModels().filter(x => x !== m), ...(ev.target.checked ? [m] : [])]; save(); renderSpecs(); updateSummary(); } });
    cb.checked = alsoModels().includes(m);
    box.append(el("label", { class: "check", style: "margin:0", title: m }, cb, ` ${stem(m)} `,
      el("span", { class: "hint", style: "display:inline", text: specText(specsFor(e, m)) })));
  }
}

function loraState(n) {
  if (!S.loras[n]) S.loras[n] = { on: false, strength: null, triggers: DEFAULT_TRIGGERS[n] || "" };
  return S.loras[n];
}
// Your strength for this LoRA, else its saved default (lora-flags "strengths"), else the engine's.
const loraStrength = (n) => loraState(n).strength ?? loraStrengths[n] ?? ENGINE_DEFAULTS[S.engine].strength;
const compatible = (n) => (loraInfo[n] || {}).family === S.engine;

function renderLoras() {
  const box = $("loraList"); box.innerHTML = "";
  const nb = $("noLoraBtn"); nb.style.display = mainLora() ? "" : "none"; nb.classList.toggle("on", noLora()); nb.setAttribute("aria-pressed", noLora());
  nb.title = `Draw with ${ENGINE_LABEL[S.engine]} alone: no main LoRA, ticked LoRAs, character LoRAs or activation words. Click again to bring them back.`;
  const f = $("loraFilter").value.trim().toLowerCase();
  const main = mainLora();
  const names = lists.loras.filter(n => loraVisible(n) && n !== main && (!f || n.toLowerCase().includes(f)));
  if (main) names.unshift(main);
  const comp = names.filter(compatible), other = names.filter(n => !compatible(n));
  const shown = S.showAll ? [...comp, ...other] : comp;
  const ticked = selectedLoras().length;
  $("loraCount").textContent = `(${lists.loras.filter(n => compatible(n) && loraVisible(n)).length} for ${ENGINE_LABEL[S.engine]}${ticked ? ` · ${ticked} ticked` : ""})`;
  $("showGenLoras").checked = !!S.showGenLoras;
  const picked = selectedLoras();
  $("loraPick").textContent = noLora() ? "No LoRA" : picked.length
    ? picked.slice(0, 2).map(stem).join(", ") + (picked.length > 2 ? ` +${picked.length - 2} more` : "") : "No LoRAs ticked";
  $("loraDrop").open = !!S.loraOpen;
  // Blocked LoRAs are named only outside General; the General workspace just counts them.
  const nBlocked = blockedLoras.length;
  $("loraTabNote").textContent = !nBlocked ? "" : `${nBlocked} LoRA${nBlocked > 1 ? "s" : ""} blocked (child-related training data)`
    + (mode === "general" ? "" : `: ${blockedLoras.map(stem).join(", ")}`);
  $("loraTabNote").style.display = nBlocked ? "" : "none";
  // LoRAs you moved out of this workspace with the 18+ button, so they can be brought back.
  const away = mode === "adult" ? "general" : "adult";
  const moved = mode === "story" ? [] : lists.loras.filter(n => loraFlags[n] === away && compatible(n));
  $("loraHidden").style.display = nBlocked + moved.length ? "" : "none";
  $("loraHiddenSum").textContent = `Hidden LoRAs (${nBlocked + moved.length})`;
  const mv = $("loraMoved"); mv.innerHTML = ""; mv.style.display = moved.length ? "" : "none";
  if (moved.length) mv.append(`Moved to ${away === "adult" ? "Adult 18+" : "General"} by you: `,
    ...moved.map(n => el("button", { class: "btn sm", text: "↺ " + stem(n), title: "Bring this LoRA back to this workspace", onclick: () => setLoraFlag(n, mode) })),
    moved.length > 1 ? el("button", { class: "btn sm", text: "↺ All", title: "Bring all of these back", onclick: async () => { for (const n of moved) await setLoraFlag(n, mode); } }) : null);
  if (!shown.length) box.append(el("div", { class: "hint", text: lists.loras.length ? "No LoRAs here for this model type." : "No LoRAs found in models/loras." }));
  for (const n of shown) {
    const info = loraInfo[n] || { family: "other", tags: [] };
    const st = loraState(n), ok = compatible(n);
    const locked = n === main, sel = ok && !noLora() && (locked || st.on);
    const strength = loraStrength(n);
    const badges = [el("span", { class: "badge " + info.family, text: { sdxl: "SDXL", anima: "Anima", klein: "Klein", sd15: "SD1.5", flux: "Flux.1" }[info.family] || "other" })];
    if (info.pony) badges.push(el("span", { class: "badge pony", text: "Pony", title: "Trained on Pony V6 — works best with Pony-based checkpoints" }));
    const trig = el("input", { type: "text", placeholder: "Trigger words for this LoRA (added to prompt)", value: st.triggers || "",
      oninput: (ev) => { st.triggers = ev.target.value; save(); } });
    const word = el("input", { type: "text", class: "actword", value: loraWords[n] || "",
      placeholder: info.trigger ? `Activation word: ${info.trigger} (from the file)` : "Activation word (switches it on when it's in your prompt)",
      title: "When this word is in your prompt, this LoRA is used even if it isn't ticked. Saved for every workspace and device.",
      oninput: (ev) => setLoraWord(n, ev.target.value) });
    const card = el("div", { class: "lora" + (sel ? " sel" : "") + (ok ? "" : " off") + (loraWord(n) ? " hasword" : "") + (locked ? " mainlora" : ""), title: ok ? n : `${n}\nMade for ${info.family}, not ${S.engine} — can't be used here.` },
      el("div", { class: "top" },
        el("input", Object.assign({ type: "checkbox", onchange: (ev) => { st.on = ev.target.checked; E().noLora = false; save(); renderLoras(); updateSummary(); } },
          ok && !locked ? {} : { disabled: "" }, sel ? { checked: "" } : {})),
        el("span", { class: "name", text: stem(n) }),
        ...badges,
        locked ? el("span", { class: "mainbadge", text: "Main", title: "Your main LoRA: locked on for every image with this model type" }) : null,
        locked ? null : el("button", { class: "keybtn", text: "🔑", title: loraWord(n) ? `Switched on by the word "${loraWord(n)}" in your prompt` : "Set an activation word",
          onclick: () => { card.classList.toggle("showword"); word.focus(); } }),
        locked ? null : el("button", { class: "r18" + (isAdultLora(n) ? " on" : ""), text: "18+",
          title: (isAdultLora(n) ? "Adult LoRA — click to move it to the General workspace" : "General LoRA — click to move it to the Adult 18+ workspace")
            + (loraFlags[n] ? " (set by you)" : " (detected from its training tags/name)"),
          onclick: () => setLoraFlag(n, isAdultLora(n) ? "general" : "adult") }),
        el("input", { type: "number", class: "str", min: "-2", max: "3", step: "0.05", value: strength, title: "Strength",
          oninput: (ev) => { st.strength = parseFloat(ev.target.value); save(); } })),
      word,
      el("div", { class: "more" }, trig,
        info.tags.length ? el("div", { class: "tags" }, el("span", { class: "hint", text: "Trained tags:" }),
          info.tags.map(t => el("span", { class: "tag", text: t, title: "Add to trigger words",
            onclick: () => { const cur = trig.value.split(",").map(s => s.trim()).filter(Boolean); if (!cur.includes(t)) cur.push(t); trig.value = cur.join(", "); st.triggers = trig.value; save(); } }))) : null));
    box.append(card);
  }
  updateSummary();
}

// The main LoRA goes into every image of its model type: pinned first, can't be unticked. Not in General, where adult LoRAs never run.
const MAIN_LORAS = {};   // none: every LoRA is ticked by hand
const mainLora = () => { const n = MAIN_LORAS[S.engine]; return mode !== "general" && n && lists.loras.includes(n) && compatible(n) && loraVisible(n) ? n : null; };
// No LoRA: this model type draws with nothing added, until it is switched back. Kept per model type and workspace.
const noLora = () => !!mainLora() && !!E().noLora;
function selectedLoras() {
  if (noLora()) return [];
  const main = mainLora();
  return [...(main ? [main] : []), ...lists.loras.filter(n => n !== main && compatible(n) && loraVisible(n) && loraState(n).on)];
}
// General never lists or runs adult LoRAs; Adult lists adult LoRAs (plus General ones if asked).
// Story: every Anima and SDXL LoRA (a character's own LoRAs still apply); LoRAs made for
// animal sex never.
const STORY_ANIMA_LORA = /./;
const loraAllowed = (n) => mode === "story" ? !(loraInfo[n] || {}).animal : mode === "adult" || !isAdultLora(n);
const loraVisible = (n) => mode === "story" ? !(loraInfo[n] || {}).animal && (S.engine !== "anima" || STORY_ANIMA_LORA.test(n))
  : mode === "adult" ? (isAdultLora(n) || !!S.showGenLoras) : !isAdultLora(n);
// Together: one column led by the first ticked LoRA, the others ride along as its `mix`. Apart: one column per LoRA.
function runs() {
  if (noLora()) return [null];
  const sel = selectedLoras(), main = mainLora();
  if (!main) return [...(S.baseline ? [null] : []), ...(S.loraMix ? sel.slice(0, 1) : sel)];
  const rest = sel.filter(n => n !== main);
  return S.loraMix || !rest.length ? [main] : [...(S.baseline ? [main] : []), ...rest];
}
const loraMixFor = (lead) => lead ? selectedLoras().filter(n => n !== lead && (S.loraMix || n === mainLora()))
  .map(n => ({ name: n, strength: loraStrength(n) })) : [];
function updateSummary() {
  if (tab === "workflow") renderWfModels();
  const main = mainLora();
  $("baselineWrap").style.display = noLora() || (main && S.loraMix) ? "none" : "";
  $("baselineText").textContent = main ? `Include an image with only ${stem(main)} for comparison` : 'Include a "No LoRA" image for comparison';
  const seq = seqActive(), r = seq ? seqBeats().length : runs().length, c = Math.max(1, S.count | 0), nm = 1 + alsoModels().length;
  const models = nm > 1 ? ` × ${nm} models` : "";
  const head = seq ? `🎞 ${r} frames${c > 1 ? ` × ${c}` : ""}${models}${noLora() ? " · No LoRA" : selectedLoras()[0] ? " · " + stem(selectedLoras()[0]) : ""}${seqCarry() ? " · look of frame 1 kept" : ""}`
    : `${r} column${r > 1 ? "s" : ""} × ${c} image${c > 1 ? "s" : ""}${models} = ${r * c * nm} image${r * c * nm > 1 ? "s" : ""}`
      + (S.loraMix && selectedLoras().length > 1 ? ` · ${selectedLoras().length} LoRAs together` : "") + (noLora() ? " · No LoRA" : "");
  const byWord = noLora() ? [] : triggeredLoras(joinTags([S.prompt, ...charPromptParts(newLookOn(), S.prompt)])).filter(n => !selectedLoras().includes(n));
  $("summary").textContent = r ? `${head}${byWord.length ? ` · 🔑 ${byWord.map(stem).join(", ")} (from trigger word)` : ""}${activeChar() ? " · 👤 " + activeChar().name : ""}${newLookOn() ? " · 🎲 new outfit & pose" : ""}${refActive() ? (extraRefsActive().length ? ` · ${1 + extraRefsActive().length} reference images` : " · from reference image") : ""}${ipaActive() ? " · Image 2 via IP-Adapter" : ""}${snapActive() ? " · Image 2 via SnapRef" : ""}${faceLockActive() ? " · face kept" : ""}${poseActive() ? " · pose from sketch" : S.poseUpload && S.poseOn && !plainGraph ? " · sketch not used (see Pose sketch)" : ""}${clashingTags(S.prompt).length ? ` · skipping ${clashingTags(S.prompt).join(", ")} (clashes with ${activeChar().name})` : ""}` : "Tick at least one LoRA, or \"Include a No LoRA image\"";
  $("generate").disabled = $("generate2").disabled = $("variations").disabled = !r;
}

function bindSettings() {
  $("engineSeg").addEventListener("click", (ev) => { const e = (ev.target.closest("[data-e]") || {}).dataset?.e; if (e && e !== S.engine) { if (queuing) return toast("Wait until the current batch is sent, then switch."); S.engine = e; save(); renderSettings(); } });
  $("model").addEventListener("change", () => {
    const e = E(), oldK = qualityKey(S.engine, e.model), newK = qualityKey(S.engine, $("model").value);
    if (oldK !== newK) {   // swap quality/negative defaults only if the user hasn't customised them
      if (e.quality === QUALITY[oldK].q) e.quality = QUALITY[newK].q;
      if (e.negative === QUALITY[oldK].n) e.negative = QUALITY[newK].n;
    }
    setModel(e, $("model").value);
    if (S.engine === "klein") e.te = kleinTE(e.model);
    save(); renderSettings();
  });
  const bindE = (id, key, conv = (v) => v) => $(id).addEventListener("change", () => {
    const e = E(); e[key] = conv($(id).value);
    if (SPEC_KEYS.includes(key) && e.model) { e.specs[e.model] = Object.fromEntries(SPEC_KEYS.filter(k => e[k] != null).map(k => [k, e[k]])); renderSpecs(); }
    save();
  });
  bindE("vae", "vae"); bindE("clipSkip", "clipSkip"); bindE("te", "te"); bindE("avae", "avae");
  bindE("steps", "steps", Number); bindE("cfg", "cfg", Number); bindE("sampler", "sampler"); bindE("scheduler", "scheduler");
  // Sliders mirror the number boxes; letting go of a slider saves like typing a number.
  for (const id of ["steps", "cfg"]) {
    $(id + "R").addEventListener("input", () => { $(id).value = $(id + "R").value; });
    $(id + "R").addEventListener("change", () => $(id).dispatchEvent(new Event("change")));
    $(id).addEventListener("input", () => { $(id + "R").value = $(id).value; });
  }
  $("histBtn").onclick = () => document.body.classList.toggle("histopen");
  $("negativeQuick").addEventListener("input", () => { E().negative = $("negativeQuick").value; save(); });
  $("detail").addEventListener("change", () => { S.detail = Number($("detail").value); save(); });
  $("teaCache").addEventListener("change", () => { S.teaCache = $("teaCache").value; save(); });
  $("sageOn").addEventListener("change", () => { S.sage = $("sageOn").checked; save(); });
  $("nagOn").addEventListener("change", () => { S.nag = $("nagOn").checked; save(); });
  $("specOn").addEventListener("change", () => { S.spectrum = $("specOn").checked; save(); renderExtras(); });
  $("coupleOn").addEventListener("change", () => { S.couple = { ...S.couple, on: $("coupleOn").checked }; save(); renderExtras(); });
  for (const side of ["left", "right"]) {
    const box = $("couple" + side[0].toUpperCase() + side.slice(1));
    box.addEventListener("input", () => { S.couple = { ...S.couple, [side]: box.value }; save(); });
  }
  $("negQuickReset").onclick = () => { E().negative = QUALITY[qualityKey(S.engine, E().model)].n; save(); renderSettings(); };
  $("prompt").addEventListener("input", () => { S.prompt = $("prompt").value; fillLayoutFromPrompt(); save(); updateSummary(); });
  $("size").addEventListener("change", () => {
    S.size = $("size").value;
    if (S.size !== "custom") { const [w, h] = S.size.split("x").map(Number); S.w = w; S.h = h; }
    save(); renderSettings();
  });
  $("w").addEventListener("change", () => { S.w = Number($("w").value); save(); });
  $("h").addEventListener("change", () => { S.h = Number($("h").value); save(); });
  $("count").addEventListener("input", () => { S.count = Math.min(16, Math.max(1, Number($("count").value) || 1)); save(); updateSummary(); });
  $("seed").addEventListener("change", () => { S.seed = Math.max(0, Number($("seed").value) || 0); save(); });
  $("dice").onclick = () => { S.seed = rand(); $("seed").value = S.seed; save(); };
  $("autoSeed").onchange = () => { S.autoSeed = $("autoSeed").checked; save(); };
  $("baseline").onchange = () => { S.baseline = $("baseline").checked; save(); updateSummary(); };
  $("loraMix").onchange = () => { S.loraMix = $("loraMix").checked; save(); updateSummary(); };
  $("showAll").onchange = () => { S.showAll = $("showAll").checked; save(); renderLoras(); };
  $("loraFilter").addEventListener("input", renderLoras);
  $("selAll").onclick = () => { for (const n of lists.loras) if (compatible(n) && loraVisible(n)) loraState(n).on = true; E().noLora = false; save(); renderLoras(); };
  $("noLoraBtn").onclick = () => { E().noLora = !E().noLora; save(); renderLoras(); };
  $("selNone").onclick = () => { for (const n of lists.loras) if (compatible(n) && loraVisible(n)) loraState(n).on = false; save(); renderLoras(); };
  $("showGenLoras").onchange = () => { S.showGenLoras = $("showGenLoras").checked; save(); renderLoras(); };
  $("loraDrop").addEventListener("toggle", () => { if (S.loraOpen !== $("loraDrop").open) { S.loraOpen = $("loraDrop").open; save(); } });
  $("reloadLoras").onclick = async () => { await Promise.all([loadModels(), loadLoras()]); renderSettings(); toast("Model lists refreshed", true); };
  // The main LoRA is left out: it's added to every image anyway, so merging it in would apply it twice.
  const mergeSources = () => selectedLoras().filter(n => n !== mainLora());
  $("mergeLoras").onclick = () => {
    if (mergeSources().length < 2) return toast("Tick 2 or more LoRAs (besides the main one) to merge them.");
    const row = $("mergeRow"), open = row.style.display === "none";
    row.style.display = open ? "flex" : "none";
    if (open) { $("mergeName").value ||= mergeSources().map(stem).join("+").slice(0, 60); $("mergeName").focus(); }
  };
  $("mergeName").onkeydown = (ev) => { if (ev.key === "Enter") $("mergeGo").click(); };
  $("mergeGo").onclick = async () => {
    const srcs = mergeSources();
    if (srcs.length < 2) return toast("Tick 2 or more LoRAs (besides the main one) to merge them.");
    const btn = $("mergeGo"); btn.disabled = true; btn.textContent = "Merging…";
    try {
      const { name } = await post("/lora-lab/loras/merge", { name: $("mergeName").value,
        loras: srcs.map(n => ({ name: n, weight: loraStrength(n) })) });
      // Ready to use: the merge alone replaces its sources, and keeps their words and their 18+ sorting.
      const words = [...new Set(srcs.flatMap(n => [loraWord(n), loraState(n).triggers]).flatMap(t => (t || "").split(",")).map(t => t.trim()).filter(Boolean))];
      await Promise.all([loadModels(), loadLoras()]);
      if (srcs.some(isAdultLora)) await setLoraFlag(name, "adult");
      for (const n of srcs) loraState(n).on = false;
      Object.assign(loraState(name), { on: true, strength: 1, triggers: words.join(", ") });
      $("mergeRow").style.display = "none"; $("mergeName").value = "";
      save(); renderSettings();
      toast(`Saved ${name}: ticked in place of the ${srcs.length} LoRAs it merges.`, true);
    } catch (err) {
      toast(ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to turn on merging." : "Couldn't merge: " + err.message);
    } finally { btn.disabled = false; btn.textContent = "Save merge"; }
  };
  $("thumb").addEventListener("input", () => { S.thumb = Number($("thumb").value); document.documentElement.style.setProperty("--thumb", S.thumb + "px"); save(); });
}

// ---------- workflow ----------
// Adds LoadImage -> resize -> VAEEncode for the reference image and returns the latent link.
// toOutputSize: crop/scale to the chosen output size (img2img); otherwise ~1 MP at its own shape (Klein reference).
// base: first node id to use, so several reference images can share one graph.
function refLatent(g, vae, toOutputSize, r, base = 20) {
  const [load, scale, enc] = [base, base + 1, base + 2].map(String);
  g[load] = { class_type: "LoadImage", inputs: { image: r.subfolder ? `${r.subfolder}/${r.name}` : r.name } };
  g[scale] = toOutputSize
    ? { class_type: "ImageScale", inputs: { image: [load, 0], upscale_method: "lanczos", width: S.w, height: S.h, crop: "center" } }
    : { class_type: "ImageScaleToTotalPixels", inputs: { image: [load, 0], upscale_method: "lanczos", megapixels: 1.0, resolution_steps: 16 } };
  g[enc] = { class_type: "VAEEncode", inputs: { pixels: [scale, 0], vae } };
  return [enc, 0];
}
// IP-Adapter (optional ComfyUI_IPAdapter_plus node pack): SDXL uses Image 2 as a "look like this" reference.
const ipaAvailable = () => lists.ipadapter.length > 0 && lists.clipVision.length > 0;
const ipaActive = () => !plainGraph && S.engine === "sdxl" && ipaAvailable() && !!(S.extraRefs || [])[0];
function ipaFiles() {
  const face = S.ipaMode === "face";
  const model = lists.ipadapter.find(n => /sdxl/i.test(n) && /face/i.test(n) === face) || lists.ipadapter.find(n => /sdxl/i.test(n)) || lists.ipadapter[0];
  const vision = lists.clipVision.find(n => /vit[-_]?h|clip_vision_h|laion2b/i.test(n)) || lists.clipVision[0];
  return { model, vision };
}
// SnapRef (Anima Ref Adapter node + snapref_*.safetensors in loras): Anima draws the character in Image 2 in a new scene.
const snapAvailable = () => (lists.snapref || []).length > 0;
const snapActive = () => !plainGraph && S.engine === "anima" && snapAvailable() && !!(S.extraRefs || [])[0];
// Extra Klein reference images (e.g. the top and bottom garment for virtual try-on), in slot order.
const extraRefsActive = () => S.engine === "klein" && S.kleinRefMode === "reference" && !!activeRef()
  ? (S.extraRefs || []).filter(Boolean) : [];
// Story scenes are built with only the character (and Keep face): never the panel's reference, pose or IP-Adapter,
// or 100 different scenes would all copy one picture.
let plainGraph = false;
// The active character's reference image wins over the Reference image panel.
function activeRef() {
  if (plainGraph) return null;
  if (charRefOn()) return activeChar().ref;
  return S.useRef && S.refUpload ? S.refUpload : null;
}
const refActive = () => !!activeRef();

// LoRAs whose trained trigger word is a word of the text: they are used even when not ticked.
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const triggeredLoras = (text) => !text ? [] : lists.loras.filter(n => {
  // Several words can be given, separated by commas; any one of them switches the LoRA on.
  const words = loraWord(n).split(",").map(w => w.trim()).filter(Boolean);
  return words.length > 0 && compatible(n) && loraAllowed(n) && words.some(t => new RegExp(`(^|[^\\w@])${escRe(t)}(?![\\w])`, "i").test(text));
});
// Character LoRAs (when enabled and made for this model type), a story co-star's LoRAs, the column's LoRA, then
// LoRAs switched on by their trigger word in the prompt.
function loraChain(lora, extra, text) {
  if (noLora()) return [];
  const ch = activeChar(), out = [];
  const usable = (l) => compatible(l.name) && loraAllowed(l.name) && !(loraInfo[l.name] || {}).blocked && !out.some(x => x.name === l.name);
  if (ch && S.charUse.loras) for (const l of ch.loras) if (usable(l)) out.push({ name: l.name, strength: l.strength });
  for (const l of extra || []) if (usable(l)) out.push({ name: l.name, strength: l.strength });
  if (lora && !out.some(l => l.name === lora)) out.push({ name: lora, strength: loraStrength(lora) });
  for (const n of triggeredLoras(text)) if (usable({ name: n })) out.push({ name: n, strength: loraStrength(n) });
  return out;
}
// Nude: when a prompt or a character's Extra 18+ tags say nude, every clothing tag that Kōbō adds on its own
// (the saved outfit, an AI or Tag-library new look) is dropped, except underwear, stockings, thighhighs, heels and
// sex toys. Accessories (jewelry, glasses, hair ornaments) stay. Tags you type yourself are never removed.
const NUDE_TAG = /^(nude|naked|completely nude|fully nude|full nudity|nudity|total nudity)$/;
const NUDE_KEEP_RE = new RegExp("\\b(" + ["bras?", "brassiere", "panties", "panty(?!hose)", "pantyshot", "underwear", "undergarments?",
  "lingerie", "bikinis?", "thongs?", "g-strings?", "garters?", "pasties", "fundoshi", "sarashi",
  "stockings?", "thighhighs", "heels", "sex toys?", "dildos?", "vibrators?", "strap-on", "cock ring", "butt plug", "anal beads",
  "egg vibrator", "magic wand", "lube"].join("|") + ")\\b");
const GARMENT_RE = new RegExp("\\b(" + ["dress", "gown", "kimono", "yukata", "hakama", "japanese clothes", "chinese clothes", "qipao",
  "cheongsam", "hoodie", "jacket", "coat", "suit", "tuxedo", "blazer", "armor", "swimsuit", "leotard", "bodysuit", "shirt", "t-shirt",
  "blouse", "(?:crop|tank|tube|halter|strapless) top", "camisole", "sweater", "cardigan", "turtleneck", "halterneck", "vest", "skirt",
  "miniskirt", "pants", "jeans", "shorts", "leggings", "tights", "pantyhose", "thighhighs", "kneehighs", "stockings", "fishnets",
  "socks?", "sleeves?", "sleeveless", "gloves?", "shoes?", "boots?", "sandals", "heels", "sneakers", "loafers", "slippers",
  "cape", "capelet", "cloak", "robe", "shawl", "scarf", "apron", "hood", "necktie", "bowtie", "neckerchief", "ascot", "collared",
  "uniform", "serafuku", "sailor collar", "maid", "nightgown", "negligee", "babydoll", "pajamas", "overalls", "jumpsuit", "corset",
  "latex", "playboy bunny", "obi", "sash", "belt", "suspenders", "buttons", "zipper", "pocket", "frills", "fur trim",
  "clothes", "clothing", "clothed", "outfit", "costume", "cosplay", "lifting skirt"].join("|") + ")\\b");
const isNudeTag = (t) => NUDE_TAG.test(normTag(t));
const hasNude = (text) => splitTags(text).some(isNudeTag);
const isGarment = (t) => { t = normTag(t); return GARMENT_RE.test(t) && !NUDE_KEEP_RE.test(t); };
const dropGarments = (text) => splitTags(text).filter(t => !isGarment(t)).join(", ");

const dropCountTags = (text) => splitTags(text).filter(t => !COUNT_TAG.test(normTag(t))).join(", ");
function charPromptParts(newLook, prompt) {
  const ch = activeChar();
  if (!ch) return [];
  const outfit = S.charUse.outfit && !newLook ? (hasNude(prompt) ? dropGarments(ch.outfit) : ch.outfit) : "";
  return [ch.triggers, S.charUse.appearance ? ch.appearance : "", outfit];
}

// Keep face: the active character's reference image pins their face, whatever the prompt or seed.
// SDXL copies it with IP-Adapter's face model, Klein reads it as a native reference; Anima can't read images, so it
// draws the new picture next to the reference (inpainting the right half of a wider canvas) and only that half is kept.
// The Anima panel needs the plain text-to-image path: the Reference image starts from its own latent, and the sketch
// pose's LLLite control must match the output size.
const faceRef = () => { const ch = activeChar(); return ch && ch.ref && S.charUse.face !== false ? ch.ref : null; };
const ipaFaceModel = () => lists.ipadapter.find(n => /sdxl/i.test(n) && /face/i.test(n) && !/faceid/i.test(n));
const faceLockSupport = () => S.engine === "klein" ? "klein" : S.engine === "sdxl" && ipaAvailable() && ipaFaceModel() ? "ipa"
  : S.engine === "anima" && !activeRef() && !poseActive() ? "panel" : null;
const faceLockActive = () => !!faceRef() && !!faceLockSupport();
// Where the head usually is: near the top centre of a full-body image, the upper middle of a portrait.
function faceBox(size) {
  if (!size) return null;
  const { w, h } = size, tall = h > w * 1.15;
  const side = Math.round(tall ? w * 0.45 : Math.min(w, h) * 0.6);
  return { width: side, height: side, x: Math.round((w - side) / 2), y: Math.round(h * (tall ? 0.03 : 0.08)) };
}
const KLEIN_FACE_HINT ="Keep the character's face exactly the same as in the reference image.";
// Anima face panel: the gap and the "multiple views" tag make it draw the same character again instead of
// continuing the reference's scene across the seam (tested: both clearly helped).
const FACE_PANEL_GAP = 64, FACE_PANEL_TAG = "multiple views";

// Prompt tags that would change the character's face (hair colour, hair length, hairstyle, eye colour)
// are dropped when the character's appearance already sets them, e.g. "black hair" for a brown-haired character.
const ID_COLORS = /\b(black|brown|blonde?|red|orange|pink|purple|violet|blue|aqua|green|white|grey|gray|silver|platinum|multicolou?red|two-tone|gradient|streaked)\b/;
function identityCat(tag) {
  const t = normTag(tag);
  if (/ hair$/.test(t) && ID_COLORS.test(t)) return "hairColor";
  if (/ eyes$/.test(t) && ID_COLORS.test(t)) return "eyeColor";
  if (/^(very short|short|medium|long|very long|absurdly long) hair$/.test(t)) return "hairLength";
  if (/(braid|twintails|ponytail|hair bun|double bun|bob cut|pixie cut|hime cut|drill hair|ringlets)/.test(t)) return "hairStyle";
  return null;
}
function clashingTags(prompt) {
  const ch = activeChar();
  if (!ch || !S.charUse.appearance || isPhotoEngine(S.engine)) return [];
  const own = new Set(), cats = new Set();
  for (const t of splitTags(ch.appearance)) { const c = identityCat(t); if (c) { cats.add(c); own.add(normTag(t)); } }
  return splitTags(prompt).filter(t => { const c = identityCat(t); return c && cats.has(c) && !own.has(normTag(t)); });
}
function charSafePrompt(prompt) {
  const drop = new Set(clashingTags(prompt));
  return drop.size ? splitTags(prompt).filter(t => !drop.has(t)).join(", ") : prompt;
}
// "portrait" / "landscape" typed in the prompt or the idea box pick the image shape; the word itself isn't sent to the model.
const ORIENT_RE = /(^|[\s,(])(?:in\s+)?(portrait|landscape)(?:\s+(?:mode|orientation|format))?(?!\s*\()(?=$|[\s,).])/gi;
function orientationIn(text) {
  let o = null;
  for (const m of (text || "").matchAll(ORIENT_RE)) o = m[2].toLowerCase();
  return o;
}
function dropOrientation(text) {
  return (text || "").replace(ORIENT_RE, "$1").replace(/,(\s*,)+/g, ",").replace(/ {2,}/g, " ").replace(/^[\s,]+|[\s,]+$/g, "");
}
// The size turned to portrait or landscape (a square size first becomes 2:3).
function orientedSize(w, h, o) {
  if (w === h) [w, h] = w <= 512 ? [512, 768] : [832, 1216];
  return (h > w) !== (o === "portrait") ? [h, w] : [w, h];
}
function applyOrientation(o) {
  if (!o) return;
  const [w, h] = orientedSize(S.w, S.h, o);
  if (w === S.w && h === S.h) return;
  S.w = w; S.h = h;
  S.size = [...$("size").options].some(opt => opt.value === `${w}x${h}`) ? `${w}x${h}` : "custom";
  $("size").value = S.size; $("customSize").style.display = S.size === "custom" ? "" : "none";
  $("w").value = w; $("h").value = h;
  save();
  toast(`Size set to ${o}: ${w} × ${h}`, true);
}

// Extra detail (Detail Daemon nodes): the model is told the noise is a little lower than it is in the middle steps, so it
// adds finer detail. It wraps the sampler, so these pictures are drawn with SamplerCustom instead of KSampler.
const detailAmount = () => lists.detailDaemon && S.engine !== "klein" ? Number(S.detail) || 0 : 0;
// Anima TeaCache presets from ComfyUI-Anima-TeaCache's README, per sampler: [threshold, start, end]. Other samplers: off.
const TEACACHE = { er_sde: { safe: [0.15, 0, 1], fast: [0.2, 0, 1] }, euler: { safe: [0.05, 0, 1], fast: [0.075, 0.3, 1] },
  euler_ancestral: { safe: [0.75, 0, 0.75], fast: [0.85, 0, 0.75] } };
const teaCachePreset = (e) => lists.teaCache && S.engine === "anima" ? (TEACACHE[e.sampler] || {})[S.teaCache ?? "fast"] || null : null;
// Two people (Prompt Control's Attention Couple): the scene acts on the whole picture, each person's tags only on their
// half, so looks don't swap or mix. Illustrious / Pony / SD 1.5, and Anima through Prompt Control's experimental patch.
const PC_WORDS = /\b(AND|BREAK|COUPLE|FILL|MASK|MASKW|MASK_SIZE|IMASK|AREA|FEATHER|STYLE|SDXL|TE|TE_WEIGHT|CLIP_L|SUB|SEG|DEF|NODE|FILTER|COMBINE|AVG|CAT|NOISE)\b/g;
const pcText = (t) => (t || "").replace(PC_WORDS, w => w.toLowerCase());   // Prompt Control syntax words only from here
const coupleEngine = () => !!lists.couple && (isCkptEngine(S.engine) || (S.engine === "anima" && !!lists.coupleAnima));
// [left, right] tags, or null: the co-star of a story / manga panel, else the two boxes in Settings (main Generate only).
function coupleHalves(opts, lead) {
  if (!S.couple.on || !coupleEngine()) return null;
  if (opts.cast) {
    const mine = joinTags(lead), other = joinTags(opts.cast);
    return mine && other && (opts.castPeople ?? 1) === 1 ? [mine, other] : null;
  }
  const l = (S.couple.left || "").trim(), r = (S.couple.right || "").trim();
  return opts.duo && l && r ? [charSafePrompt(l), charSafePrompt(r)] : null;
}
function renderExtras() {
  const detail = !!lists.detailDaemon && S.engine !== "klein", couple = coupleEngine();
  const tea = !!lists.teaCache && S.engine === "anima", sage = !!lists.sage;
  const anima = S.engine === "anima", spec = spectrumOn();
  $("teaWrap").style.display = tea && !spec ? "" : "none";   // Spectrum takes over from TeaCache while it's on
  $("teaCache").value = S.teaCache ?? "fast";
  $("sageWrap").style.display = sage ? "" : "none";
  $("sageOn").checked = S.sage !== false;
  $("nagWrap").style.display = !!lists.nag && anima ? "" : "none";
  $("nagOn").checked = S.nag !== false;
  $("specWrap").style.display = !!lists.spectrum && anima ? "" : "none";
  $("specOn").checked = S.spectrum === true;
  $("detailWrap").style.display = detail ? "" : "none";
  $("detail").value = String(S.detail || 0);
  $("coupleBox").style.display = couple ? "" : "none";
  $("coupleOn").checked = !!S.couple.on;
  $("coupleWrap").style.display = S.couple.on ? "" : "none";
  $("coupleLeft").value = S.couple.left || ""; $("coupleRight").value = S.couple.right || "";
  $("extraSection").style.display = detail || couple || tea || sage || (anima && (lists.nag || lists.spectrum)) ? "" : "none";
}
const spectrumOn = () => S.engine === "anima" && !!lists.spectrum && S.spectrum === true;
// SageAttention (KJNodes' node, its name misspelt upstream): on by default.
function sageModel(g, model) {
  if (!lists.sage || S.sage === false) return model;
  g["sa"] = { class_type: "PathchSageAttentionKJ", inputs: { model, sage_attention: "auto" } };
  return ["sa", 0];
}
// Anima's attention patches, right after the LoRAs. Order matters: NAG wraps the attention override that is already
// there, so SageAttention has to come first.
function animaPatches(g, model, e) {
  model = sageModel(g, model);
  if (S.engine === "anima" && lists.nag && S.nag !== false && Number(e.cfg) <= 1.5) {
    g["nag"] = { class_type: "AnimaNormalizedAttentionGuidance", inputs: { model, scale: 2, tau: 2.5, alpha: 0.5,
      start_percent: 0, end_percent: 0.5, only_anima: true, optimize_outside_range: true } };
    model = ["nag", 0];
  }
  return model;
}

function buildGraph(lora, seed, prefix, opts = {}) {
  const e = opts.eng || E();
  const ref = activeRef();
  const klein = S.engine === "klein", zimage = S.engine === "zimage", photo = isPhotoEngine(S.engine);
  const face = faceLockActive() ? faceRef() : null;
  const panel = face && faceLockSupport() === "panel";
  const pose = poseActive() ? S.poseUpload : null;
  const prompt = charSafePrompt(opts.prompt ?? dropOrientation(S.prompt));
  // Story with a co-star: both characters' tags, without their own "1girl"/"solo" (the scene's people count wins).
  const leadParts = opts.cast ? charPromptParts(opts.newLook, prompt).map(dropCountTags) : charPromptParts(opts.newLook, prompt);
  const charParts = opts.cast ? [...leadParts, ...opts.cast] : leadParts;
  const halves = panel || photo ? null : coupleHalves(opts, leadParts);
  const chain = loraChain(lora, opts.extraLoras, joinTags([prompt, ...charParts]));
  const triggers = chain.map(l => loraState(l.name).triggers);
  // Sequence: the finished first frame, loaded straight from the output folder.
  const prev = opts.prev ? { name: `${opts.prev.filename} [output]`, subfolder: opts.prev.subfolder || "" } : null;
  const pos = photo
    ? [joinTags([e.quality, ...triggers, ...charParts, prompt]).replace(/([^.!?])$/, "$1."), klein && face ? KLEIN_FACE_HINT : "", klein && pose ? KLEIN_POSE_HINT : "", klein && prev ? KLEIN_CARRY_HINT : "", KLEIN_POS_GUARD].filter(Boolean).join(" ")
    // With the two people kept apart, each one's look goes in their own half (below), not in the whole-picture prompt.
    : animaArtists(joinTags([e.quality, ...triggers, ...(halves && opts.cast ? [] : charParts), prompt, panel ? FACE_PANEL_TAG : "", POS_GUARD]));
  const ch = activeChar();
  // "multiple views" also invites back views, which hide the face, unless the prompt asks for one.
  const neg = joinTags([e.negative, ch && ch.negative, opts.neg, panel && !/\bfrom behind\b/i.test(prompt) ? "from behind" : "", photo ? KLEIN_NEG_GUARD : NEG_GUARD]);
  const g = {};
  let model, clip, vae;
  // Chains LoRA loaders; SDXL LoRAs also patch the text encoder.
  const addLoras = (withClip) => chain.forEach((l, i) => {
    const id = String(30 + i);
    g[id] = withClip
      ? { class_type: "LoraLoader", inputs: { model, clip, lora_name: l.name, strength_model: l.strength, strength_clip: l.strength } }
      : { class_type: "LoraLoaderModelOnly", inputs: { model, lora_name: l.name, strength_model: l.strength } };
    model = [id, 0];
    if (withClip) clip = [id, 1];
  });
  if (klein) {
    g["1"] = /\.gguf$/i.test(e.model)
      ? { class_type: "UnetLoaderGGUF", inputs: { unet_name: e.model } }
      : { class_type: "UNETLoader", inputs: { unet_name: e.model, weight_dtype: "default" } };
    g["3"] = { class_type: "CLIPLoaderGGUF", inputs: { clip_name: e.te, type: "flux2" } };
    g["4"] = { class_type: "VAELoader", inputs: { vae_name: e.avae } };
    model = ["1", 0]; clip = ["3", 0]; vae = ["4", 0];
    addLoras(false);
    g["5"] = { class_type: "CLIPTextEncode", inputs: { text: pos, clip } };
    g["6"] = { class_type: "CLIPTextEncode", inputs: { text: neg, clip } };
    let positive = ["5", 0], negative = ["6", 0], latent, sigmas;
    let steps = Number(e.steps);
    const img2img = ref && S.kleinRefMode === "img2img";
    // Native references condition the prompt instead of being the starting latent; Keep face adds the character's image.
    const condRefs = ref && !img2img ? [ref, ...extraRefsActive()] : [];
    if (face && !condRefs.some(r => r.name === face.name && (r.subfolder || "") === (face.subfolder || ""))) condRefs.push(face);
    if (pose) condRefs.push(pose);
    if (prev) condRefs.push(prev);
    condRefs.forEach((r, i) => {
      const refLat = refLatent(g, vae, false, r, 50 + i * 5);
      const p = String(53 + i * 5), n = String(54 + i * 5);
      g[p] = { class_type: "ReferenceLatent", inputs: { conditioning: positive, latent: refLat } };
      g[n] = { class_type: "ReferenceLatent", inputs: { conditioning: negative, latent: refLat } };
      positive = [p, 0]; negative = [n, 0];
    });
    if (img2img) {
      // Keep the number of steps actually run close to the setting after the denoise split.
      steps = Math.max(steps, Math.round(steps / S.denoise));
      latent = refLatent(g, vae, true, ref);
      g["25"] = { class_type: "SplitSigmasDenoise", inputs: { sigmas: ["11", 0], denoise: S.denoise } };
      sigmas = ["25", 1];
    } else {
      g["7"] = { class_type: "EmptyFlux2LatentImage", inputs: { width: S.w, height: S.h, batch_size: 1 } };
      latent = ["7", 0]; sigmas = ["11", 0];
    }
    g["11"] = { class_type: "Flux2Scheduler", inputs: { steps, width: S.w, height: S.h } };
    model = sageModel(g, model);
    g["12"] = { class_type: "CFGGuider", inputs: { model, positive, negative, cfg: Number(e.cfg) } };
    g["13"] = { class_type: "KSamplerSelect", inputs: { sampler_name: e.sampler } };
    g["14"] = { class_type: "RandomNoise", inputs: { noise_seed: seed } };
    g["8"] = { class_type: "SamplerCustomAdvanced", inputs: { noise: ["14", 0], guider: ["12", 0], sampler: ["13", 0], sigmas, latent_image: latent } };
    g["9"] = { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae } };
    g["10"] = { class_type: "SaveImage", inputs: { filename_prefix: prefix, images: ["9", 0] } };
    return { graph: g };
  }
  if (isCkptEngine(S.engine)) {
    g["1"] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: e.model } };
    model = ["1", 0]; clip = ["1", 1]; vae = ["1", 2];
    addLoras(true);
    if (ipaActive()) {
      const r = S.extraRefs[0], f = ipaFiles();
      g["70"] = { class_type: "LoadImage", inputs: { image: r.subfolder ? `${r.subfolder}/${r.name}` : r.name } };
      g["71"] = { class_type: "IPAdapterModelLoader", inputs: { ipadapter_file: f.model } };
      g["72"] = { class_type: "CLIPVisionLoader", inputs: { clip_name: f.vision } };
      g["73"] = { class_type: "IPAdapterAdvanced", inputs: { model, ipadapter: ["71", 0], image: ["70", 0], clip_vision: ["72", 0],
        weight: Number(S.ipaWeight), weight_type: "linear", combine_embeds: "concat", start_at: 0, end_at: 1, embeds_scaling: "V only" } };
      model = ["73", 0];
    }
    if (face) {   // Keep face: IP-Adapter's face model on a crop around the head of the character's reference
      g["74"] = { class_type: "LoadImage", inputs: { image: face.subfolder ? `${face.subfolder}/${face.name}` : face.name } };
      let img = ["74", 0];
      const box = faceBox(activeChar().refSize);
      if (box) { g["79"] = { class_type: "ImageCrop", inputs: { image: img, ...box } }; img = ["79", 0]; }
      g["75"] = { class_type: "PrepImageForClipVision", inputs: { image: img, interpolation: "LANCZOS", crop_position: "center", sharpening: 0 } };
      g["76"] = { class_type: "IPAdapterModelLoader", inputs: { ipadapter_file: ipaFaceModel() } };
      g["77"] = { class_type: "CLIPVisionLoader", inputs: { clip_name: ipaFiles().vision } };
      // Easing off halfway keeps anime models clean: the face model was trained on photos and washes out the style if left on.
      g["78"] = { class_type: "IPAdapterAdvanced", inputs: { model, ipadapter: ["76", 0], image: ["75", 0], clip_vision: ["77", 0],
        weight: Number(S.faceWeight), weight_type: "linear", combine_embeds: "concat", start_at: 0, end_at: 0.5, embeds_scaling: "V only" } };
      model = ["78", 0];
    }
    g["3"] = { class_type: "CLIPSetLastLayer", inputs: { clip, stop_at_clip_layer: -Number(e.clipSkip || 2) } };
    clip = ["3", 0];
    if (e.vae && e.vae !== "(from checkpoint)") { g["4"] = { class_type: "VAELoader", inputs: { vae_name: e.vae } }; vae = ["4", 0]; }
  } else {   // Anima and Z-Image: separate diffusion model, text encoder and VAE
    g["1"] = /\.gguf$/i.test(e.model)
      ? { class_type: "UnetLoaderGGUF", inputs: { unet_name: e.model } }
      : { class_type: "UNETLoader", inputs: { unet_name: e.model, weight_dtype: "default" } };
    g["3"] = { class_type: "CLIPLoader", inputs: { clip_name: e.te, type: zimage ? "lumina2" : "stable_diffusion", device: "default" } };
    g["4"] = { class_type: "VAELoader", inputs: { vae_name: e.avae } };
    model = ["1", 0]; clip = ["3", 0]; vae = ["4", 0];
    addLoras(false);
    model = animaPatches(g, model, e);
    if (pose && S.engine === "anima") {   // Anima ControlNet-LLLite: trained on dark line art / scribbles
      g["96"] = { class_type: "ModelPatchLoader", inputs: { name: animaPatch() } };
      g["97"] = { class_type: "AnimaLLLiteApply", inputs: { model, model_patch: ["96", 0], image: poseImage(g, true), strength: poseStrength(),
        start_percent: 0, end_percent: S.poseKind === "rough" ? 0.5 : 0.85 } };
      model = ["97", 0];
    }
    if (snapActive()) {   // after the other LoRAs, as the adapter's README asks; snapref_guidance off = the trained behaviour
      const r = S.extraRefs[0];
      g["sr0"] = { class_type: "LoadImage", inputs: { image: r.subfolder ? `${r.subfolder}/${r.name}` : r.name } };
      // ref_megapixels 0.6: the adapter's guide says 0.5–0.7 saves VRAM; its 1.0 default wants ~1 GB more than 6 GB cards have spare.
      g["sr1"] = { class_type: "AnimaRefAdapter", inputs: { model, vae, clip, image: ["sr0", 0], lora_name: lists.snapref[lists.snapref.length - 1],
        ref_guidance: 4.5, correction: "apg", strength: 1, ref_end: 1, ref_megapixels: 0.6,
        snapref_mode: S.snapMode || "cs", ref_caption: "", snapref_guidance: false, ref_weight: Number(S.snapWeight ?? 1) } };
      model = ["sr1", 0];
    }
    if (zimage) { g["15"] = { class_type: "ModelSamplingAuraFlow", inputs: { model, shift: 3 } }; model = ["15", 0]; }
    const tc = spectrumOn() ? null : teaCachePreset(e);   // after the LoRAs, as TeaCache's README asks; Spectrum skips the same steps
    if (tc) {
      g["16"] = { class_type: "AnimaTeaCache", inputs: { model, rel_l1_thresh: tc[0], start_percent: tc[1], end_percent: tc[2], cache_device: "cuda" } };
      model = ["16", 0];
    }
    if (spectrumOn()) {   // the author's Anima defaults; steps must equal the sampler's steps (set below)
      g["spec"] = { class_type: "DiTSpectrumPatch", inputs: { model, steps: Number(e.steps), window_size: 2.0, flex_window: 0.25,
        warmup_steps: 6, tail_actual_steps: 3, blend_w: 0.3, cheby_degree: 3, ridge_lambda: 0.1, history_size: 100,
        enabled: true, one_sampler_only: false, verbose: false } };
      model = ["spec", 0];
    }
  }
  g["5"] = { class_type: "CLIPTextEncode", inputs: { text: pos, clip } };
  g["6"] = { class_type: "CLIPTextEncode", inputs: { text: neg, clip } };
  if (halves) {
    const [l, r] = halves.map(h => animaArtists(pcText(h)));
    g["5"] = { class_type: "PCTextEncode", inputs: { clip, text: `${pcText(pos)} COUPLE(0 0.5) ${l} COUPLE(0.5 1) ${r}` } };
    if (S.engine === "anima") { g["5a"] = { class_type: "PCAnimaAttnCouplePatch", inputs: { model } }; model = ["5a", 0]; }
    // Prompts with hooks make ComfyUI 0.38 load SDXL the old way, which then mixes fp16 inputs with bf16 weights unless
    // the compute type is set (tested 2026-11-05). That way is also slower: about twice the time per picture.
    else { g["5d"] = { class_type: "ModelComputeDtype", inputs: { model, dtype: "fp16" } }; model = ["5d", 0]; }
  }
  if (isCkptEngine(S.engine)) model = sageModel(g, model);   // Anima's patches were applied after its LoRAs
  let positive = ["5", 0], negative = ["6", 0];
  if (pose && S.engine === "sdxl") {   // SDXL ControlNets want light lines on a dark background
    const net = poseNet();
    g["93"] = { class_type: "ControlNetLoader", inputs: { control_net_name: net.name } };
    let cn = ["93", 0];
    if (net.type) { g["94"] = { class_type: "SetUnionControlNetType", inputs: { control_net: cn, type: net.type } }; cn = ["94", 0]; }
    g["95"] = { class_type: "ControlNetApplyAdvanced", inputs: { positive, negative, control_net: cn, image: poseImage(g, false),
      strength: poseStrength(), start_percent: 0, end_percent: S.poseKind === "rough" ? 0.6 : 0.8, vae } };
    positive = ["95", 0]; negative = ["95", 1];
  }
  let latent = ["7", 0], out = ["9", 0];
  if (ref) latent = refLatent(g, vae, true, ref);
  else if (panel) {   // Keep face on Anima: reference | gap | new picture, only the new picture is denoised and saved
    const full = 2 * S.w + FACE_PANEL_GAP;
    g["80"] = { class_type: "LoadImage", inputs: { image: face.subfolder ? `${face.subfolder}/${face.name}` : face.name } };
    g["81"] = { class_type: "ImageScale", inputs: { image: ["80", 0], upscale_method: "lanczos", width: S.w, height: S.h, crop: "center" } };
    g["82"] = { class_type: "EmptyImage", inputs: { width: S.w, height: S.h, batch_size: 1, color: 0x808080 } };
    g["83"] = { class_type: "ImageStitch", inputs: { image1: ["81", 0], image2: ["82", 0], direction: "right", match_image_size: false,
      spacing_width: FACE_PANEL_GAP, spacing_color: "white" } };
    g["84"] = { class_type: "VAEEncode", inputs: { pixels: ["83", 0], vae } };
    g["85"] = { class_type: "SolidMask", inputs: { value: 1, width: full, height: S.h } };
    g["86"] = { class_type: "SolidMask", inputs: { value: 0, width: S.w + FACE_PANEL_GAP, height: S.h } };
    g["87"] = { class_type: "MaskComposite", inputs: { destination: ["85", 0], source: ["86", 0], x: 0, y: 0, operation: "multiply" } };
    g["7"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["84", 0], mask: ["87", 0] } };
    g["88"] = { class_type: "ImageCrop", inputs: { image: ["9", 0], width: S.w, height: S.h, x: S.w + FACE_PANEL_GAP, y: 0 } };
    out = ["88", 0];
  } else g["7"] = { class_type: zimage ? "EmptySD3LatentImage" : "EmptyLatentImage", inputs: { width: S.w, height: S.h, batch_size: 1 } };
  const detail = detailAmount(), denoise = ref ? S.denoise : 1;
  if (detail) {
    g["d0"] = { class_type: "BasicScheduler", inputs: { model, scheduler: e.scheduler, steps: Number(e.steps), denoise } };
    g["d1"] = { class_type: "KSamplerSelect", inputs: { sampler_name: e.sampler } };
    g["d2"] = { class_type: "DetailDaemonSamplerNode", inputs: { sampler: ["d1", 0], detail_amount: detail, start: 0.2, end: 0.8, bias: 0.5,
      exponent: 1, start_offset: 0, end_offset: 0, fade: 0, smooth: true, cfg_scale_override: 0 } };
    g["8"] = { class_type: "SamplerCustom", inputs: { model, add_noise: true, noise_seed: seed, cfg: Number(e.cfg), positive, negative,
      sampler: ["d2", 0], sigmas: ["d0", 0], latent_image: latent } };
  } else g["8"] = { class_type: "KSampler", inputs: { model, positive, negative, latent_image: latent,
    seed, steps: Number(e.steps), cfg: Number(e.cfg), sampler_name: e.sampler, scheduler: e.scheduler, denoise } };
  g["9"] = { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae } };
  g["10"] = { class_type: "SaveImage", inputs: { filename_prefix: prefix, images: out } };
  return { graph: g };
}

function nodeErrorText(body) {
  if (!body) return "Unknown error";
  const parts = [];
  if (body.error) parts.push(body.error.message + (body.error.details ? ": " + body.error.details : ""));
  for (const ne of Object.values(body.node_errors || {})) for (const er of ne.errors || []) parts.push(`${ne.class_type}: ${er.message}${er.details ? " — " + er.details : ""}`);
  return parts.join("\n") || JSON.stringify(body).slice(0, 300);
}

// opts is the click event when bound as onclick; only { variations } changes anything.
let queuing = false;   // true while generate() is building and sending a batch
async function generate(opts) {
  if (queuing) return toast("Still sending the last batch to ComfyUI…");
  queuing = true;
  try { await generateNow(opts); } finally { queuing = false; }
}
async function generateNow(opts) {
  const variations = opts?.variations | 0;
  applyOrientation(orientationIn(S.prompt));
  const seq = seqActive() ? seqBeats() : null;
  const r = seq ? [selectedLoras()[0] || null] : runs();
  if (!r.length) return;
  const e = E();
  if (!e.model) return toast("No model selected.");
  // The character may have a new reference image from another window or device since this page last loaded it.
  if (S.charId && !Object.keys(charSaveTimers).length) await loadChars();
  let newLook = null;
  if (newLookOn()) {
    $("generate").disabled = $("generate2").disabled = true;
    newLook = await newLookPrompt();
    if (newLook == null) return updateSummary();
  }
  if (S.autoSeed || variations) { S.seed = rand(); $("seed").value = S.seed; save(); }
  const count = variations || Math.max(1, S.count | 0), seed0 = S.seed;
  const day = new Date().toISOString().slice(0, 10);
  // One batch per model (the picked one plus "Also generate with"), each with that model's own settings.
  const list = [e, ...alsoModels().map(engFor)].map((eng, n) => [eng, newBatch(eng, Date.now() + n, r, seq, newLook, count, seed0)]);
  rememberForChar();
  batches.unshift(...list.map(([, b]) => b));
  if (batches.length > 30) batches.length = 30;
  renderResults();
  $("generate").disabled = true;
  try {
    for (const [eng, batch] of list) await queueBatch(eng, batch, day);
  } finally {
    saveBatches(); updateSummary();
  }
}
function newBatch(e, id, r, seq, newLook, count, seed0) {
  const batch = {
    id, engine: S.engine, model: e.model, prompt: newLook ?? S.prompt, newLook: !!newLook, w: S.w, h: S.h, steps: e.steps, cfg: e.cfg,
    sampler: e.sampler, scheduler: e.scheduler, seed: seed0, count,
    ref: refActive() ? { upload: activeRef(), denoise: S.denoise, mode: S.engine === "klein" ? S.kleinRefMode : "img2img", fromChar: charRefOn(),
      extra: extraRefsActive().length } : null,
    ipa: ipaActive() ? { mode: S.ipaMode, weight: S.ipaWeight } : null,
    snap: snapActive() ? { mode: S.snapMode, weight: S.snapWeight } : null,
    face: faceLockActive() ? (faceLockSupport() === "ipa" ? S.faceWeight : true) : null,
    pose: poseActive() ? { kind: S.poseKind, strength: S.poseStrength } : null,
    charId: activeChar() ? activeChar().id : null, charName: activeChar() ? activeChar().name : null,
    charUse: activeChar() ? Object.assign({}, S.charUse) : null, charLoras: loraChain(null).length, mode,
    cols: r.map(l => ({ lora: l, strength: l ? (loraStrength(l)) : null, mix: loraMixFor(l) })),
    cells: [],
  };
  if (seq) {   // one column per frame, all with the same LoRA
    batch.seq = { carry: seqCarry(), sameSeed: !!S.seq.sameSeed, story: S.seq.story || "" };
    batch.cols = seq.map((beat, k) => Object.assign({}, batch.cols[0], { frame: k + 1, beat }));
  }
  for (let i = 0; i < count; i++) batch.cols.forEach((c, k) => batch.cells.push({ lora: c.lora, mix: c.mix, status: "queued",
    seed: (seed0 + (seq && !S.seq.sameSeed ? i * batch.cols.length + k : i)) % 2 ** 32, frame: c.frame, prompt: c.beat ? framePrompt(c.beat) : newLook ?? undefined,
    size: c.beat && orientationIn(c.beat) ? orientedSize(S.w, S.h, orientationIn(c.beat)) : null }));   // a shot can ask for its own shape
  return batch;
}
async function queueBatch(eng, batch, day) {
  for (let idx = 0; idx < batch.cells.length; idx++) {
    const cell = batch.cells[idx];
    const prefix = `LoRA-Lab/${batch.charName ? `characters/${safe(batch.charName)}/` : `${day.slice(0, 7)}/`}${day}/${S.engine}_${cell.lora ? safe(cell.lora) + (cell.mix && cell.mix.length ? `+${cell.mix.length}` : "") : "no-lora"}`;
    let prev = null;
    if (batch.seq && batch.seq.carry && cell.frame > 1) {   // wait for frame 1 of this row
      prev = await waitForImage(batch, idx - (cell.frame - 1));
      if (!prev) { cell.status = "error"; cell.error = "Skipped: frame 1 didn't finish"; updateCell(batch, idx); continue; }
    }
    const keepSize = [S.w, S.h];
    if (cell.size) [S.w, S.h] = cell.size;   // this shot's own portrait / landscape size, for this one picture only
    let graph;
    try { ({ graph } = buildGraph(cell.lora, cell.seed, prefix, { prompt: cell.prompt, prev, newLook: batch.newLook, eng, extraLoras: cell.mix, duo: true })); }
    finally { [S.w, S.h] = keepSize; }
    try {
      const res = await post("/prompt", { prompt: graph, client_id: clientId });
      cell.pid = res.prompt_id;
      jobs.set(res.prompt_id, { batchId: batch.id, idx });
    } catch (err) {
      cell.status = "error"; cell.error = nodeErrorText(err.body) || err.message;
      updateCell(batch, idx);
      if (idx === 0) { toast(`ComfyUI rejected the job (${stem(batch.model)}):\n` + cell.error); for (let j = 1; j < batch.cells.length; j++) { batch.cells[j].status = "error"; batch.cells[j].error = "Skipped"; updateCell(batch, j); } break; }
    }
  }
}

// ---------- results ----------
function saveBatches() {
  store.set("batches." + mode, batches.map(b => Object.assign({}, b, {
    cells: b.cells.map(c => ({ lora: c.lora, seed: c.seed, image: c.image, error: c.error, frame: c.frame, prompt: c.prompt, story: c.story, game: c.game, chat: c.chat, manga: c.manga,
      status: c.image ? "done" : (c.status === "error" ? "error" : (c.pid ? c.status : "error")), pid: c.pid })) })));
}
const imgUrl = (im) => `/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || "")}&type=${im.type || "output"}`;
// Small WebP copy for grids and previews (full-size PNGs are 1-2 MB each, slow on phones); imgUrl stays for viewing/downloading.
const thumbUrl = (im, w = 384) => `/lora-lab/thumb?filename=${encodeURIComponent(im.filename || im.name)}&subfolder=${encodeURIComponent(im.subfolder || "")}&type=${im.type || "output"}&w=${Math.round(w * Math.min(2, window.devicePixelRatio || 1))}`;
// Server without the thumbnail route yet (not restarted since the update): show the original instead.
document.addEventListener("error", (ev) => {
  const t = ev.target;
  if (t.tagName === "IMG" && t.src.includes("/lora-lab/thumb?")) t.src = t.src.replace("/lora-lab/thumb?", "/view?");
}, true);
const colLoras = (c) => c.lora ? [{ name: c.lora, strength: c.strength }, ...(c.mix || [])] : [];
const colLabel = (c, b) => c.frame ? `Frame ${c.frame}: ${c.beat}` : c.lora ? colLoras(c).map(l => `${stem(l.name)} @ ${l.strength}`).join(" + ")
  : (b && b.charLoras ? "No extra LoRA" : "No LoRA");

// Finished images of a character batch also go into that character's gallery.
function imageDone(b, c) {
  if (c.image) post("/lora-lab/images/mark", { image: c.image, mode: b.mode || mode }).catch(() => {});   // Images tab keeps workspaces apart
  if (b.story) return storyImageDone(b, c);
  if (b.game) return gameImageDone(b, c);
  if (b.chat) return chatStoryImageDone(b, c);
  if (b.manga) return mangaImageDone(b, c);
  if (!b.charId || c.charPosted || !c.image) return;
  c.charPosted = true;
  post("/lora-lab/characters/image", { id: b.charId, image: c.image, seed: c.seed, lora: c.lora, model: b.model, engine: b.engine, mode: b.mode || "adult" })
    .then((entry) => {
      const ch = chars.find(x => x.id === b.charId);
      if (ch) { ch.images = (ch.images || []).concat(entry); if (ch.id === editId) renderCharGallery(); renderCharList(); }
    })
    .catch(() => { c.charPosted = false; });
}

function renderResults() {
  const box = $("results"); box.innerHTML = "";
  $("empty").style.display = batches.length ? "none" : "";
  document.body.classList.toggle("hasresults", batches.length > 0);
  $("resultsBar").style.display = batches.length ? "" : "none";
  for (const b of batches) {
    const n = b.cols.length;
    const grid = el("div", { class: "grid", style: `grid-template-columns: repeat(${n}, minmax(min(var(--thumb), 120px), var(--thumb))); --ar: ${b.w}/${b.h}` });
    if (!b.story && !b.game && !b.chat && !b.manga) for (const c of b.cols) grid.append(c.frame
      ? el("div", { class: "colh", title: c.beat }, el("b", { text: c.frame === 1 ? "1 · Start" : c.frame === n ? `${c.frame} · End` : String(c.frame) }), el("span", { class: "beat", text: c.beat }))
      : el("div", { class: "colh", title: colLabel(c, b) }, el("b", { text: c.lora ? colLoras(c).map(l => stem(l.name)).join(" + ") : colLabel(c, b) }),
        c.lora && !(c.mix && c.mix.length) ? ` @ ${c.strength}` : ""));
    b.cells.forEach((c, idx) => { const d = el("div", { class: "cell", id: `c-${b.id}-${idx}` }); grid.append(d); fillCell(d, b, idx); });
    box.append(el("div", { class: "batch", id: "b-" + b.id },
      el("div", { class: "bh" },
        el("b", { text: new Date(b.id).toLocaleString() }),
        el("span", { class: "meta", text: `${ENGINE_LABEL[b.engine] || b.engine} · ${stem(b.model)} · ${b.w}×${b.h} · ${b.steps} steps · CFG ${b.cfg} · ${b.engine === "klein" ? b.sampler : b.sampler + "/" + b.scheduler} · seed ${b.seed}${refLabel(b.ref)}${b.ipa ? ` · IP-Adapter ${b.ipa.mode} ${b.ipa.weight}` : ""}${b.snap ? ` · SnapRef ${b.snap.mode} ${b.snap.weight}` : ""}${b.face ? ` · face kept${b.face === true ? "" : " " + b.face}` : ""}${b.pose ? ` · pose from sketch ${b.pose.strength}` : ""}${b.seq ? ` · 🎞 sequence${b.seq.carry ? ", look of frame 1 kept" : ""}${b.cols[0].lora ? " · " + stem(b.cols[0].lora) : ""}` : ""}${b.charName ? " · 👤 " + b.charName : ""}` }),
        ...(b.story || b.game || b.chat || b.manga ? [] : [el("span", { class: "shsum", text: `${n} column${n > 1 ? "s" : ""} × ${b.cells.length / n} seed${b.cells.length / n > 1 ? "s" : ""} = ${b.cells.length} image${b.cells.length > 1 ? "s" : ""}` })]),
        ...batchButtons(b),
        el("span", { class: "p", text: b.prompt, title: b.prompt })),
      el("div", { class: "gridwrap" }, grid)));
  }
  updateProgress();
  renderHistory(); renderEngineThumbs(); renderStage();
}

function batchButtons(b) {
  return [
    b.story ? el("button", { class: "btn sm", text: "Open story", onclick: () => { showTab("story"); openStory(b.story.id); } })
      : b.game ? el("button", { class: "btn sm", text: "Open game", onclick: () => { showTab("game"); openGame(b.game.id); } })
      : b.chat ? el("button", { class: "btn sm", text: "Open chat", onclick: () => { showTab("chat"); openChatChar(b.chat.id, b.chat.chat, "story"); } })
      : b.manga ? el("button", { class: "btn sm", text: "Open manga", onclick: () => { showTab("manga"); openManga(b.manga.id); } })
      : el("button", { class: "btn sm", text: "Reuse settings", onclick: () => reuse(b) }),
    el("button", { class: "btn sm danger", text: "Remove", onclick: () => { batches = batches.filter(x => x !== b); saveBatches(); renderResults(); } }),
  ];
}

// Single view: one picture fills the stage and the rest of its batch sits beside it. Contact sheet is the full #results list.
let resultView = store.get("resultView", "single") === "sheet" ? "sheet" : "single";
let stageBatch = null, stageCell = null, stageNewest = null;   // null = follow the newest batch and its latest finished picture
function stageTarget() {
  const b = batches.find(x => x.id === stageBatch) || batches[0];
  let idx = stageCell;
  if (idx == null || !b.cells[idx]) {
    idx = b.cells.map(c => !!c.image).lastIndexOf(true);
    if (idx < 0) idx = Math.max(0, b.cells.findIndex(c => c.status === "running"));
  }
  return { b, idx };
}
const stageShows = (b, idx) => {
  if (resultView !== "single" || !batches.length) return false;
  const t = stageTarget();
  return t.b === b && t.idx === idx;
};
function renderStage() {
  document.body.classList.toggle("viewsheet", resultView === "sheet");
  for (const x of $("viewSeg").children) x.classList.toggle("on", x.dataset.v === resultView);
  const box = $("stage"); box.innerHTML = "";
  if (resultView !== "single" || !batches.length) return;
  if (batches[0].id !== stageNewest) { stageNewest = batches[0].id; stageBatch = stageCell = null; }
  const { b, idx } = stageTarget(), c = b.cells[idx], pos = batches.indexOf(b);
  const main = el("div", { class: "stmain" });
  if (c.image) main.append(el("img", { src: thumbUrl(c.image, 1024), alt: colLabel(b.cols[idx % b.cols.length], b), title: "Open: upscale, remove background, make 3D, image info", onclick: () => openLb(b, idx) }), favBtn(c.image));
  else if (c.status === "error") main.append(el("div", { class: "st err", text: c.error || "Failed", title: c.error || "" }));
  else {
    if (c.preview) main.append(el("img", { class: "preview", id: "stagePreview", src: c.preview, alt: "" }));
    main.append(el("div", { class: "st", text: c.status === "running" ? "Generating…" : c.status === "cancelled" ? "Cancelled" : "Queued" }));
    const bar = el("div", { class: "bar", id: "stageProg" }); bar.style.width = (c.progress || 0) * 100 + "%"; main.append(bar);
  }
  const strip = el("div", { class: "strip" });
  b.cells.forEach((x, i) => strip.append(el("button", { class: "stthumb" + (i === idx ? " on" : ""), title: x.seed != null ? `seed ${x.seed}` : "", "aria-label": `Show image ${i + 1} of ${b.cells.length}`,
    onclick: () => { stageBatch = b.id; stageCell = i; renderStage(); } }, x.image ? el("img", { src: thumbUrl(x.image, 256), alt: "", loading: "lazy" }) : el("span", { text: x.status === "error" ? "Failed" : "…" }))));
  const go = (d) => { stageBatch = batches[pos + d].id; stageCell = null; renderStage(); };
  box.style.setProperty("--ar", `${b.w}/${b.h}`);
  box.append(el("div", { class: "stview" }, main, strip), el("div", { class: "stbar" },
    el("span", { class: "meta", text: `${stem(b.model)} · ${b.w}×${b.h} · ${b.steps} steps · CFG ${b.cfg} · seed ${c.seed}`, title: b.prompt }),
    el("span", { class: "bpos" },
      el("button", { class: "iconbtn", text: "‹", "aria-label": "Newer batch", title: "Newer batch", disabled: pos === 0 ? "" : null, onclick: () => go(-1) }),
      `Batch ${pos + 1} of ${batches.length}`,
      el("button", { class: "iconbtn", text: "›", "aria-label": "Older batch", title: "Older batch", disabled: pos === batches.length - 1 ? "" : null, onclick: () => go(1) })),
    ...batchButtons(b)));
}

function fillCell(d, b, idx) {
  const c = b.cells[idx];
  d.innerHTML = "";
  if (c.image) {
    d.append(el("img", { src: thumbUrl(c.image, S.thumb), loading: "lazy", alt: colLabel(b.cols[idx % b.cols.length], b),
      onclick: () => openLb(b, idx) }), el("span", { class: "seed", text: c.seed }), favBtn(c.image));
  } else if (c.status === "error") {
    d.append(el("div", { class: "st err", text: c.error || "Failed", title: c.error || "" }));
  } else {
    if (c.preview) d.append(el("img", { class: "preview", src: c.preview, alt: "" }));
    d.append(el("div", { class: "st", text: c.status === "running" ? "Generating…" : c.status === "cancelled" ? "Cancelled" : "Queued" }));
    const bar = el("div", { class: "bar" }); bar.style.width = (c.progress || 0) * 100 + "%"; d.append(bar);
    if (c.preview) d.querySelector(".st").style.display = "none";
  }
}
function updateCell(b, idx) {
  const d = document.getElementById(`c-${b.id}-${idx}`); if (d) fillCell(d, b, idx); updateProgress(); renderStage();
  const c = b.cells[idx]; if (c.image || c.status === "error") { renderHistory(); renderEngineThumbs(); }
}

function updateProgress() {
  let pend = 0, done = 0;
  for (const b of batches) for (const c of b.cells) { if (c.image) done++; else if (c.pid && (c.status === "queued" || c.status === "running")) pend++; }
  $("progressText").textContent = pend ? `${pend} image${pend > 1 ? "s" : ""} in progress…` : (batches.length ? `${done} images` : "");
}

function reuse(b) {
  S.engine = b.engine; const e = E();
  Object.assign(e, { model: b.model, steps: b.steps, cfg: b.cfg, sampler: b.sampler, scheduler: b.scheduler });
  Object.assign(S, { prompt: b.prompt, w: b.w, h: b.h, seed: b.seed, count: b.count, baseline: b.cols.some(c => !c.lora) });
  const ch = b.charId && chars.find(x => x.id === b.charId);
  S.charId = ch ? ch.id : "";
  if (ch && b.charUse) S.charUse = Object.assign({}, b.charUse);
  if (b.ref && !b.ref.fromChar) { Object.assign(S, { useRef: true, refUpload: b.ref.upload, denoise: b.ref.denoise }); if (b.ref.mode !== "img2img") S.kleinRefMode = b.ref.mode; showStoredRef(); }
  else { S.useRef = false; if (b.ref) { S.denoise = b.ref.denoise; if (b.ref.mode !== "img2img") S.kleinRefMode = b.ref.mode; } }
  S.size = [...$("size").options].some(o => o.value === `${b.w}x${b.h}`) ? `${b.w}x${b.h}` : "custom";
  e.noLora = !b.cols.some(c => c.lora);
  for (const n of lists.loras) loraState(n).on = false;
  for (const l of b.cols.flatMap(colLoras)) { const st = loraState(l.name); st.on = true; st.strength = l.strength; }
  if (b.cols.filter(c => c.lora).length > 1 || b.cols.some(c => c.mix && c.mix.length)) S.loraMix = b.cols.some(c => c.mix && c.mix.length);
  if (b.seq) S.seq = Object.assign({}, S.seq, { on: true, count: b.cols.length, beats: b.cols.map(c => c.beat), carry: b.seq.carry, sameSeed: b.seq.sameSeed, story: b.seq.story || S.seq.story });
  renderSeq();
  save(); renderSettings(); toast("Settings loaded from that batch", true);
}

function findJob(pid) {
  const j = jobs.get(pid); if (!j) return null;
  const b = batches.find(x => x.id === j.batchId); if (!b) return null;
  return { b, idx: j.idx, c: b.cells[j.idx] };
}

async function fetchHistory(pid) {
  const f = findJob(pid); if (!f || f.c.image) return;
  try {
    const h = await api("/history/" + encodeURIComponent(pid));
    const entry = h && h[pid]; if (!entry) return;
    for (const out of Object.values(entry.outputs || {})) for (const im of out.images || []) if (im.type === "output") { f.c.image = im; break; }
    if (f.c.image) { f.c.status = "done"; jobs.delete(pid); imageDone(f.b, f.c); }
    else if (entry.status && entry.status.status_str === "error") {
      f.c.status = "error";
      const m = (entry.status.messages || []).find(x => x[0] === "execution_error");
      f.c.error = m ? m[1].exception_message : "Failed"; jobs.delete(pid);
    }
    updateCell(f.b, f.idx); saveBatches();
  } catch {}
}

// ---------- websocket ----------
let ws, wsTries = 0;
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?clientId=${encodeURIComponent(clientId)}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { wsTries = 0; $("dot").classList.add("on"); $("conn").textContent = "Connected to ComfyUI"; for (const pid of [...jobs.keys()]) fetchHistory(pid); };
  ws.onclose = () => { $("dot").classList.remove("on"); $("conn").textContent = "Disconnected — retrying…"; setTimeout(connect, Math.min(10000, 1000 * ++wsTries)); };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return onBinary(ev.data);
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const d = msg.data || {}, f = d.prompt_id ? findJob(d.prompt_id) : null;
    if (m3job && d.prompt_id === m3job.pid) on3dMessage(msg.type, d);
    if (d.prompt_id) onTrainMessage(msg.type, d);
    switch (msg.type) {
      case "status": { const q = d.status && d.status.exec_info ? d.status.exec_info.queue_remaining : null; $("queueInfo").textContent = q ? `Queue: ${q}` : ""; break; }
      case "execution_start": runningId = d.prompt_id; if (f) { f.c.status = "running"; updateCell(f.b, f.idx); } break;
      case "progress": if (f && d.max) { f.c.status = "running"; f.c.progress = d.value / d.max;
        const bar = document.querySelector(`#c-${f.b.id}-${f.idx} .bar`); if (bar) bar.style.width = f.c.progress * 100 + "%"; else updateCell(f.b, f.idx);
        const sp = stageShows(f.b, f.idx) && $("stageProg"); if (sp) sp.style.width = f.c.progress * 100 + "%"; } break;
      case "executed": if (f && d.output && d.output.images) { const im = d.output.images.find(x => x.type === "output"); if (im) { f.c.image = im; f.c.status = "done"; f.c.preview = null; updateCell(f.b, f.idx); saveBatches(); imageDone(f.b, f.c); } } break;
      case "execution_success": if (f) { if (!f.c.image) fetchHistory(d.prompt_id); else jobs.delete(d.prompt_id); } if (runningId === d.prompt_id) runningId = null; break;
      case "executing": if (f && d.node == null) { if (!f.c.image) fetchHistory(d.prompt_id); else jobs.delete(d.prompt_id); } break;
      case "execution_error": if (f) { f.c.status = "error"; f.c.error = (d.exception_type ? d.exception_type + ": " : "") + (d.exception_message || "Failed");
        jobs.delete(d.prompt_id); updateCell(f.b, f.idx); saveBatches(); toast(f.c.error); } break;
      case "execution_interrupted": if (f) { f.c.status = "error"; f.c.error = "Cancelled"; jobs.delete(d.prompt_id); updateCell(f.b, f.idx); saveBatches(); } break;
    }
  };
}
let lastPreviewUrl = null;
function onBinary(buf) {
  try {
    const dv = new DataView(buf), type = dv.getUint32(0);
    let blob, pid = runningId;
    if (type === 1) blob = new Blob([buf.slice(8)], { type: dv.getUint32(4) === 2 ? "image/png" : "image/jpeg" });
    else if (type === 4) {
      const len = dv.getUint32(4), meta = JSON.parse(new TextDecoder().decode(buf.slice(8, 8 + len)));
      pid = meta.prompt_id || pid; blob = new Blob([buf.slice(8 + len)], { type: meta.image_type || "image/jpeg" });
    } else return;
    const f = pid && findJob(pid); if (!f || f.c.image) return;
    if (lastPreviewUrl) URL.revokeObjectURL(lastPreviewUrl);
    f.c.preview = lastPreviewUrl = URL.createObjectURL(blob);
    const d = document.getElementById(`c-${f.b.id}-${f.idx}`);
    const img = d && d.querySelector("img.preview");
    if (img) img.src = f.c.preview; else updateCell(f.b, f.idx);
    if (stageShows(f.b, f.idx)) { const sp = $("stagePreview"); if (sp) sp.src = f.c.preview; else renderStage(); }
  } catch {}
}
// Fallback in case a websocket message is missed.
setInterval(() => { for (const pid of jobs.keys()) { const f = findJob(pid); if (f && !f.c.image) fetchHistory(pid); } }, 8000);

// ---------- lightbox ----------
// Items: { image, label, seed }
let lbList = [], lbPos = 0;
function openLbItems(items, pos) {
  if (!items.length) return;
  lbList = items; lbPos = Math.max(0, Math.min(pos, items.length - 1));
  showLb(); $("lb").classList.add("on");
}
function openLb(b, idx) {
  const done = b.cells.filter(c => c.image);
  openLbItems(done.map(c => ({ image: c.image, label: colLabel(b.cols[b.cells.indexOf(c) % b.cols.length], b), seed: c.seed })), done.indexOf(b.cells[idx]));
}
function showLb() {
  const it = lbList[lbPos];
  $("lbCap").innerHTML = "";
  if (it.src) {   // TagFinder example from a booru site: { src, page, site, label }
    $("lbImg").src = it.src;
    $("lbCap").append(el("b", { text: it.label, style: "color:var(--text)" }), el("span", { text: `${lbPos + 1} / ${lbList.length}` }),
      el("a", { href: it.page, target: "_blank", text: it.site ? `Open on ${it.site}` : "Open full size" }));
    return;
  }
  $("lbImg").src = imgUrl(it.image);
  $("lbCap").append(el("b", { text: it.label, style: "color:var(--text)" }), it.seed != null ? el("span", { text: `seed ${it.seed}` }) : null,
    el("span", { text: `${lbPos + 1} / ${lbList.length}` }),
    el("a", { href: imgUrl(it.image), target: "_blank", text: "Open full size" }),
    el("a", { href: imgUrl(it.image), download: it.image.filename, text: "Download" }),
    el("div", { class: "tools" },
      it.image.type === "input" ? null : favBtn(it.image, true),
      lists.faceFix && lists.sdpose.length ? el("button", { class: "btn sm", text: "Fix face", title: "Redraw the face at full size with this picture's own model, LoRAs and prompt, then paste it back (about a minute)", onclick: (ev) => fixFace(ev.currentTarget) }) : null,
      el("button", { class: "btn sm", text: "⤢ Upscale 4×", title: "Real-ESRGAN 4× upscale (about a minute)", onclick: (ev) => runImageTool("upscale", ev.currentTarget) }),
      lists.usdu && lists.upscale.length ? el("button", { class: "btn sm", text: "Upscale + redraw", title: "2× bigger, then redrawn in tiles with this picture's own model, LoRAs and prompt for real new detail (a few minutes)", onclick: (ev) => redrawUpscale(ev.currentTarget) }) : null,
      el("button", { class: "btn sm", text: "Remove background", title: "BiRefNet cut-out with a transparent background", onclick: (ev) => runImageTool("cutout", ev.currentTarget) }),
      el("button", { class: "btn sm", text: "Make 3D", title: "Open this image in the 3D tab", onclick: () => { $("lb").classList.remove("on"); set3dSource({ name: it.image.filename, subfolder: it.image.subfolder || "", type: it.image.type || "output" }); showTab("3d"); } }),
      el("button", { class: "btn sm", text: "Info", title: "How this image was made: model, LoRAs, prompt and settings", onclick: () => { $("lb").classList.remove("on"); showTab("info"); loadInfo({ filename: it.image.filename, subfolder: it.image.subfolder || "", type: it.image.type || "output" }); } })));
}

// Real-ESRGAN 4× on node "1" (a LoadImage), saved in output/LoRA-Lab/upscaled. False when no upscale model is installed.
function upscaleGraph(g, im) {
  const m = lists.upscale.find(n => /esrgan/i.test(n)) || lists.upscale[0];
  if (!m) return false;
  g["2"] = { class_type: "UpscaleModelLoader", inputs: { model_name: m } };
  g["3"] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["2", 0], image: ["1", 0] } };
  g["9"] = { class_type: "SaveImage", inputs: { filename_prefix: "LoRA-Lab/upscaled/" + safe(im.filename), images: ["3", 0] } };
  return true;
}
// One-off post-processing on the image shown in the lightbox; the result is inserted right after it.
async function runImageTool(kind, btn) {
  const it = lbList[lbPos]; if (!it) return;
  const im = it.image;
  const src = `${im.subfolder ? im.subfolder + "/" : ""}${im.filename} [${im.type === "input" ? "input" : "output"}]`;
  const g = { "1": { class_type: "LoadImage", inputs: { image: src } } };
  let label;
  if (kind === "upscale") {
    if (!upscaleGraph(g, im)) return toast("No upscale model found in models/upscale_models.");
    label = "4× upscaled";
  } else {
    const m = lists.bgRemoval.find(n => /birefnet/i.test(n)) || lists.bgRemoval[0];
    if (!m) return toast("No background removal model found in models/background_removal.");
    g["2"] = { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: m } };
    g["3"] = { class_type: "RemoveBackground", inputs: { bg_removal_model: ["2", 0], image: ["1", 0] } };
    // JoinImageWithAlpha inverts its mask (LoadImage convention), so invert the foreground mask first.
    g["4"] = { class_type: "InvertMask", inputs: { mask: ["3", 0] } };
    g["5"] = { class_type: "JoinImageWithAlpha", inputs: { image: ["1", 0], alpha: ["4", 0] } };
    g["9"] = { class_type: "SaveImage", inputs: { filename_prefix: "LoRA-Lab/cutouts/" + safe(im.filename), images: ["5", 0] } };
    label = "background removed";
  }
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "Working…";
  try {
    const res = await post("/prompt", { prompt: g, client_id: clientId });
    const image = await waitForJob(res.prompt_id);
    lbList.splice(lbPos + 1, 0, { image, label: `${it.label} · ${label}`, seed: it.seed });
    lbMove(1);
    toast(kind === "upscale" ? "Upscaled — saved in output/LoRA-Lab/upscaled" : "Cut-out saved in output/LoRA-Lab/cutouts (transparent PNG)", true);
  } catch (err) {
    toast((kind === "upscale" ? "Upscale failed: " : "Background removal failed: ") + (nodeErrorText(err.body) || err.message));
  } finally { btn.disabled = false; btn.textContent = old; }
}
// Fix face: SDPose finds the largest face, the picture's own model, LoRAs and prompts redraw it at full size, and it is
// pasted back with soft edges. 0.45 tested best on NoobAI (2026-11-03): it cleans up the eyes and keeps the design.
const FACE_FIX_DENOISE = 0.45, FACE_FIX_SIZE = 1024, FACE_FIX_TAGS = "portrait, close-up, face focus";
// The sampler settings of a picture made here, whichever way it was drawn: KSampler, or SamplerCustom with Extra detail
// (then the redraw goes without it: it only touches up what is already there).
function savedSampler(saved) {
  const nodes = Object.values(saved);
  const ks = nodes.find(n => n.class_type === "KSampler");
  if (ks) return ks.inputs;
  const sc = nodes.find(n => n.class_type === "SamplerCustom");
  const sched = sc && Array.isArray(sc.inputs.sigmas) && saved[sc.inputs.sigmas[0]];
  let pick = sc && Array.isArray(sc.inputs.sampler) && saved[sc.inputs.sampler[0]];
  while (pick && pick.class_type !== "KSamplerSelect" && Array.isArray(pick.inputs.sampler)) pick = saved[pick.inputs.sampler[0]];
  if (!sched || sched.class_type !== "BasicScheduler" || !pick || pick.class_type !== "KSamplerSelect") return null;
  const i = sc.inputs;
  return { model: i.model, positive: i.positive, negative: i.negative, latent_image: i.latent_image, seed: i.noise_seed, cfg: i.cfg,
    steps: sched.inputs.steps, scheduler: sched.inputs.scheduler, denoise: sched.inputs.denoise, sampler_name: pick.inputs.sampler_name };
}
// Two-people prompts read as one plain prompt (for a close-up or a redraw, the halves no longer line up).
const flatCouple = (t) => t.replace(/\s*\bCOUPLE(?:\([^)]*\))?\s*/g, ", ").replace(/,(\s*,)+/g, ",");
// What a redraw of a picture made here needs: its model (without pose guides, the two-people patch or SnapRef), prompts, VAE,
// and the nodes that make them, copied into a new graph.
function savedParts(saved) {
  const ks = savedSampler(saved), dec = Object.values(saved).find(n => n.class_type === "VAEDecode");
  if (!ks || !dec) return null;
  const through = (ref, key) => { while (/^(ControlNetApplyAdvanced|AnimaLLLiteApply|AnimaRefAdapter|PCAnimaAttnCouplePatch|ModelComputeDtype)$/.test(saved[ref[0]].class_type)) ref = saved[ref[0]].inputs[key]; return ref; };
  const model = through(ks.model, "model"), positive = through(ks.positive, "positive"), negative = through(ks.negative, "negative");
  const pos = saved[positive[0]];
  if (!/^(CLIPTextEncode|PCTextEncode)$/.test(pos.class_type) || typeof pos.inputs.text !== "string") return null;
  const g = {}, vae = dec.inputs.vae;
  const copy = (ref) => { if (Array.isArray(ref) && saved[ref[0]] && !g[ref[0]]) { g[ref[0]] = saved[ref[0]]; Object.values(saved[ref[0]].inputs).forEach(copy); } };
  [model, negative, pos.inputs.clip, vae].forEach(copy);
  return { g, ks, model, negative, vae, clip: pos.inputs.clip, text: flatCouple(pos.inputs.text).replace(FACE_PANEL_TAG, "") };
}
const loadSaved = (im) => ({ class_type: "LoadImage", inputs: { image: `${im.subfolder ? im.subfolder + "/" : ""}${im.filename} [${im.type === "input" ? "input" : "output"}]` } });
function faceFixGraph(im, saved) {
  const p = savedParts(saved);
  if (!p) return null;
  const { g, ks, model, negative, vae } = p;
  const text = p.text.startsWith(FACE_FIX_TAGS) ? p.text : `${FACE_FIX_TAGS}, ${p.text}`;
  g.f0 = { class_type: "CLIPTextEncode", inputs: { text, clip: p.clip } };
  g.f1 = loadSaved(im);
  g.f2 = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: lists.sdpose[0] } };
  g.f3 = { class_type: "SDPoseKeypointExtractor", inputs: { model: ["f2", 0], vae: ["f2", 2], image: ["f1", 0], batch_size: 1 } };
  g.f4 = { class_type: "SDPoseFaceBBoxes", inputs: { keypoints: ["f3", 0], scale: 1.5, force_square: true } };
  g.f5 = { class_type: "ASALabFaceCrop", inputs: { image: ["f1", 0], bboxes: ["f4", 0], context: 2, size: FACE_FIX_SIZE } };
  g.f6 = { class_type: "VAEEncode", inputs: { pixels: ["f5", 0], vae } };
  g.f7 = { class_type: "KSampler", inputs: { ...ks, model, positive: ["f0", 0], negative, latent_image: ["f6", 0], seed: rand(), denoise: FACE_FIX_DENOISE } };
  g.f8 = { class_type: "VAEDecode", inputs: { samples: ["f7", 0], vae } };
  g.f9 = { class_type: "ASALabFacePaste", inputs: { image: ["f1", 0], face: ["f8", 0], region: ["f5", 1], feather: 0.15 } };
  g.f10 = { class_type: "SaveImage", inputs: { filename_prefix: "LoRA-Lab/fixed/" + safe(im.filename), images: ["f9", 0] } };
  return g;
}
async function fixFace(btn) {
  const it = lbList[lbPos]; if (!it) return;
  const im = it.image, old = btn.textContent;
  btn.disabled = true; btn.textContent = "Working…";
  try {
    const fd = new FormData();
    fd.append("filename", im.filename); fd.append("subfolder", im.subfolder || ""); fd.append("type", im.type || "output");
    const { graph } = await api("/lora-lab/imageinfo", { method: "POST", body: fd });
    const g = graph && faceFixGraph(im, graph);
    if (!g) throw new Error("this picture has no usable settings saved in it. It only works on pictures made here with Illustrious / Pony, SD 1.5, Anima or Z-Image.");
    const res = await post("/prompt", { prompt: g, client_id: clientId });
    const image = await waitForJob(res.prompt_id);
    post("/lora-lab/images/mark", { image, mode }).catch(() => {});
    lbList.splice(lbPos + 1, 0, { image, label: `${it.label} · face fixed`, seed: it.seed });
    lbMove(1);
    toast("Face fixed. Saved in output/LoRA-Lab/fixed. Press it again for another try.", true);
  } catch (err) {
    toast("Fix face failed: " + (nodeErrorText(err.body) || err.message));
  } finally { btn.disabled = false; btn.textContent = old; }
}
// Upscale + redraw (Ultimate SD Upscale nodes): 2× with the upscale model, then every 1024 px tile is redrawn lightly with
// the picture's own model, LoRAs and prompt, so it gets real new detail instead of a smoothed blow-up.
const REDRAW_SCALE = 2, REDRAW_DENOISE = 0.3, REDRAW_TILE = 1024;
function redrawGraph(im, saved) {
  const p = savedParts(saved);
  if (!p) return null;
  const { g, ks } = p;
  const photo = Object.values(saved).some(n => n.inputs && n.inputs.type === "lumina2" || /real|photo/i.test(String((n.inputs || {}).ckpt_name || "")));
  g.u0 = { class_type: "CLIPTextEncode", inputs: { text: p.text, clip: p.clip } };
  g.u1 = loadSaved(im);
  g.u2 = { class_type: "UpscaleModelLoader", inputs: { model_name: lists.upscale.find(n => /anime/i.test(n) !== photo) || lists.upscale[0] } };
  g.u3 = { class_type: "UltimateSDUpscale", inputs: { image: ["u1", 0], model: p.model, positive: ["u0", 0], negative: p.negative, vae: p.vae,
    upscale_by: REDRAW_SCALE, seed: rand(), steps: ks.steps, cfg: ks.cfg, sampler_name: ks.sampler_name, scheduler: ks.scheduler,
    denoise: REDRAW_DENOISE, upscale_model: ["u2", 0], mode_type: "Chess", tile_width: REDRAW_TILE, tile_height: REDRAW_TILE,
    mask_blur: 16, tile_padding: 64, seam_fix_mode: "None", seam_fix_denoise: 0.3, seam_fix_width: 64, seam_fix_mask_blur: 8,
    seam_fix_padding: 16, force_uniform_tiles: true, tiled_decode: false, batch_size: 1 } };
  g.u9 = { class_type: "SaveImage", inputs: { filename_prefix: "LoRA-Lab/upscaled/redrawn_" + safe(im.filename), images: ["u3", 0] } };
  return g;
}
async function redrawUpscale(btn) {
  const it = lbList[lbPos]; if (!it) return;
  const im = it.image, old = btn.textContent;
  btn.disabled = true; btn.textContent = "Working…";
  try {
    const fd = new FormData();
    fd.append("filename", im.filename); fd.append("subfolder", im.subfolder || ""); fd.append("type", im.type || "output");
    const { graph } = await api("/lora-lab/imageinfo", { method: "POST", body: fd });
    const g = graph && redrawGraph(im, graph);
    if (!g) throw new Error("this picture has no usable settings saved in it. It works on pictures made here with Illustrious / Pony, SD 1.5, Anima or Z-Image; use ⤢ Upscale 4× for others.");
    const res = await post("/prompt", { prompt: g, client_id: clientId });
    const image = await waitForJob(res.prompt_id, 900);
    post("/lora-lab/images/mark", { image, mode }).catch(() => {});
    lbList.splice(lbPos + 1, 0, { image, label: `${it.label} · upscaled + redrawn`, seed: it.seed });
    lbMove(1);
    toast("Upscaled and redrawn: saved in output/LoRA-Lab/upscaled", true);
  } catch (err) {
    toast("Upscale + redraw failed: " + (nodeErrorText(err.body) || err.message));
  } finally { btn.disabled = false; btn.textContent = old; }
}
async function waitForJob(pid, tries = 300) {   // checks every 2 s
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const h = await api("/history/" + encodeURIComponent(pid)).catch(() => null);
    const entry = h && h[pid]; if (!entry) continue;
    for (const out of Object.values(entry.outputs || {})) for (const img of out.images || []) if (img.type === "output") return img;
    const m = ((entry.status || {}).messages || []).find(x => x[0] === "execution_error");
    throw new Error(m ? m[1].exception_message : "No image was produced");
  }
  throw new Error("Timed out");
}
const lbMove = (d) => { if (lbList.length) { lbPos = (lbPos + d + lbList.length) % lbList.length; showLb(); } };
$("lbPrev").onclick = () => lbMove(-1); $("lbNext").onclick = () => lbMove(1);
$("lbX").onclick = () => $("lb").classList.remove("on");
$("lb").addEventListener("click", (ev) => { if (ev.target.id === "lb") $("lb").classList.remove("on"); });
document.addEventListener("keydown", (ev) => {
  if (!$("lb").classList.contains("on")) { if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") { if (tab === "3d") make3d(); else if (!(ev.target.matches?.("input, textarea") && !ev.target.closest("#tabResults"))) generate(); } return; }   // not while typing in chat, novel, ...
  if (ev.key === "Escape") $("lb").classList.remove("on"); else if (ev.key === "ArrowLeft") lbMove(-1); else if (ev.key === "ArrowRight") lbMove(1);
});

// ---------- reference image -> prompt ----------
const REF_BLOCK = new Set(["loli", "shota", "child", "female child", "male child", "kid", "toddler", "baby", "aged down", "underage",
  "young child", "kindergartener", "elementary school student", "middle school student", "childlike body", "randoseru"]);
const RATING = {
  illustrious: { general: "general", sensitive: "sensitive", questionable: "nsfw", explicit: "explicit" },
  pony: { general: "rating_safe", sensitive: "rating_questionable", questionable: "rating_questionable", explicit: "rating_explicit" },
  anima: { general: "safe", sensitive: "sensitive", questionable: "nsfw", explicit: "explicit" },
  sd15: { general: "", sensitive: "", questionable: "nsfw", explicit: "nsfw" },
};
const REF_TARGETS = [
  { key: "illustrious", label: "Illustrious", engine: "sdxl", pick: [/illustrious/i, /wai|noob/i], qk: "sdxl", extra: [] },
  { key: "pony", label: "Pony", engine: "sdxl", pick: [/pony/i], qk: "pony", extra: ["source_anime"] },
  { key: "anima", label: "Anima", engine: "anima", pick: [/anima/i], qk: "anima", extra: [] },
  { key: "sd15", label: "SD 1.5", engine: "sd15", pick: [/nai/i, /./], qk: "sd15", extra: [] },
  { key: "klein", label: "Klein / Z-Image", engine: "klein", pick: [/9b/i, /klein/i], qk: "klein", extra: [] },
];
const TAG_GROUP_ORDER = ["look", "clothing", "action", "setting", "camera"];   // tagger.tag_groups' names
const COUNT_TAG = /^(\d\+?(girl|boy|other)s?|multiple (girls|boys|others)|solo|solo focus|no humans)$/;
const DROP_TEXT = "Drop an image, paste (Ctrl+V), or click to choose";
let refData = null, refDesc = {}, refDescBusy = {}, refFocus = {};
const REF_SENTENCES = { anima: "4", klein: "5" };   // Anima: 3–4 sentences, mixed in among the tags (mixDescription)

// Sentences for one prompt box (JoyCaption looks at the picture; the server falls back to the prompt writer).
// A result that arrives after a new picture was dropped is thrown away.
async function describeRef(key) {
  const data = refData;
  if (!data || refDescBusy[key]) return;
  refDescBusy[key] = true; renderRef();
  try {
    const fd = new FormData();
    if (lastRefFile) fd.append("image", lastRefFile, lastRefFile.name || "image.png");
    fd.append("tags", joinTags([RATING.anima[refRating()], refBody("klein")]));
    fd.append("sfw", mode === "general" ? "1" : ""); fd.append("model", $("llmModel").value);
    fd.append("sentences", REF_SENTENCES[key]);
    fd.append("focus", (refFocus[key] || "").trim());
    let text;
    try { text = (await api("/lora-lab/describe", { method: "POST", body: fd })).text; }
    catch (err) {   // Kōbō not restarted yet: the old tags-only writer
      if (!ROUTE_MISSING.test(err.message)) throw err;
      text = await askDolphin(`Write a prompt for this image. Content rating: ${refRating()}. Danbooru tags describing it: ${refBody("klein")}`, "klein");
    }
    // JoyCaption often writes more sentences than asked (7 for 4 in a test); Anima keeps only the first ones.
    if (key === "anima") text = String(text).split(/(?<=[.!?])\s+/).slice(0, +REF_SENTENCES.anima).join(" ");
    if (refData === data) refDesc[key] = text;
  } catch (err) { if (refData === data) toast(dolphinError(err)); }
  finally { if (refData === data) { refDescBusy[key] = false; renderRef(); } }
}

function refRating() {
  if (mode === "general") return "general";   // the General workspace always uses safe ratings
  const r = refData.ratings; return Object.keys(r).sort((a, b) => r[b] - r[a])[0] || "general";
}
function adultTagSet() {
  const set = new Set(EXPLICIT_TRAIN_TAGS);
  if (lib) for (const c of lib.categories) if (c.adult) for (const t of c.tags) set.add(normTag(t));
  return set;
}
// Artists picked in the "Artist style" row (PixAI's guesses), written the way each model family reads them.
function refArtistTags(engine) {
  if (!refData.pick || engine === "klein") return [];
  return [...refData.pick].map(a => engine === "anima" ? "@" + a : a);
}
// Danbooru tags only one of these per picture; the taggers often say two (large + huge breasts): keep the stronger.
const REF_EXCLUSIVE = [
  ["flat chest", "small breasts", "medium breasts", "large breasts", "huge breasts", "gigantic breasts"],
  ["very short hair", "short hair", "medium hair", "long hair", "very long hair", "absurdly long hair"],
];
// "Most specific tags only": drop a tag another kept tag already implies (bikini when o-ring bikini is there).
// refData.parents comes from the server (Danbooru's implications); an older server sends none and nothing is dropped.
function simplifyTags(tags, score) {
  const keep = new Set(tags);
  for (const group of REF_EXCLUSIVE) {
    const hits = group.filter(t => keep.has(t));
    const best = hits.reduce((a, b) => (score[b] > score[a] ? b : a), hits[0]);
    for (const t of hits) if (t !== best) keep.delete(t);
  }
  for (const t of [...keep]) for (const p of (refData.parents || {})[t] || []) keep.delete(p);
  return tags.filter(t => keep.has(t));
}
// Words that tie a sentence to a tag group even when it shares no word with the tags themselves.
const REF_GROUP_WORDS = {
  look: "hair eyes eye face skin body breasts figure expression smile smiling blush freckles ears tail lips ponytail braid bangs",
  clothing: "wearing wears dressed dress outfit shirt skirt jacket coat uniform clothes clothing shoes boots socks gloves hat bikini swimsuit lingerie naked nude",
  action: "standing sitting lying kneeling holding looking leaning walking running posing pose hand hands arm arms legs leg raised crossed",
  setting: "background room street outdoors indoors sky city beach forest bed window wall floor night day garden water",
  camera: "light lighting lit shadow shadows sunlight glow view angle close-up shot framed perspective focus blurred bokeh",
};
const refWords = (s) => String(s).toLowerCase().match(/[a-z][a-z-]+/g)?.map(w => w.replace(/(?<=[a-z]{3})s$/, "")) || [];
// Anima: each sentence of the description goes after the tags it is about (hair after the look tags, the outfit after
// the clothing…), the way the prompt itself is laid out, instead of all of them at the end. The first sentence is
// JoyCaption's overview ("A woman stands…") and goes after the count/character tags; one that matches nothing, at the end.
function mixDescription(head, tags, desc) {
  const groups = refData.groups || {};
  const groupOf = (t) => TAG_GROUP_ORDER.includes(groups[t]) ? groups[t] : null;
  const vocab = Object.fromEntries(TAG_GROUP_ORDER.map(g => [g, new Set([...refWords(REF_GROUP_WORDS[g]),
    ...tags.filter(t => groupOf(t) === g).flatMap(refWords)])]));
  const after = new Map();   // tag index → sentences placed after it (-1: right after the head tags)
  const put = (i, s) => after.set(i, [...(after.get(i) || []), s]);
  const lastOf = (g) => tags.findLastIndex(t => groupOf(t) === g);
  const leadEnd = tags.findIndex(t => groupOf(t) && !COUNT_TAG.test(t)) - 1;   // count tags (4girls…) are lead even if grouped
  String(desc).split(/(?<=[.!?])\s+/).filter(s => s.trim()).forEach((s, n) => {
    const words = refWords(s);
    const [best, score] = TAG_GROUP_ORDER.map(g => [g, words.filter(w => vocab[g].has(w)).length]).sort((a, b) => b[1] - a[1])[0];
    const at = n === 0 ? (leadEnd < -1 ? tags.length - 1 : leadEnd) : score && lastOf(best) >= 0 ? lastOf(best) : tags.length - 1;
    put(at, s.trim());
  });
  let out = head;
  const add = (piece, sentence) => {   // tags join with ", "; a sentence starts after ". " and ends the tag run before it
    if (!out) { out = piece; return; }
    const ended = /[.!?]$/.test(out);
    out += (ended ? " " : sentence ? ". " : ", ") + piece;
  };
  for (const s of after.get(-1) || []) add(s, true);
  tags.forEach((t, i) => { add(t, false); for (const s of after.get(i) || []) add(s, true); });
  return out;
}
const refBody = (engine) => refBodyTags(engine).join(", ");
function refBodyTags(engine) {
  const banned = mode === "general" ? adultTagSet() : new Set();
  // Series names come separately (refData.copyright) and share the name threshold with characters; an older server
  // leaves them in general, where they keep the tag threshold as before.
  const series = new Set((refData.copyright || []).map(x => x[0]));
  let general = refData.general.filter(([t, p]) => p >= S.refThr && !series.has(t) && !REF_BLOCK.has(t) && !banned.has(normTag(t))).map(x => x[0]);
  if (S.refSimple) general = simplifyTags(general, Object.fromEntries(refData.general));
  const names = S.refChars ? [...refData.character, ...(refData.copyright || [])]
    .filter(([t, p]) => p >= S.refNameThr && !REF_BLOCK.has(t)).map(x => x[0]) : [];
  // Then appearance, clothing, pose/action/sex, setting, camera & light, and the rest (each group in score order).
  const groups = refData.groups || {}, rank = (t) => { const i = TAG_GROUP_ORDER.indexOf(groups[t]); return i < 0 ? TAG_GROUP_ORDER.length : i; };
  const rest = general.filter(t => !COUNT_TAG.test(t)).sort((a, b) => rank(a) - rank(b));
  return [...general.filter(t => COUNT_TAG.test(t)), ...names, ...refArtistTags(engine), ...rest];
}
function renderRef() {
  $("refThr").value = S.refThr; $("refThrV").textContent = S.refThr.toFixed(2); $("refChars").checked = S.refChars;
  $("refNameThr").value = S.refNameThr; $("refNameThrV").textContent = S.refNameThr.toFixed(2);
  $("refNameRow").style.display = S.refChars ? "" : "none"; $("refSimple").checked = S.refSimple;
  renderTagModels();
  const out = $("refOut"); out.innerHTML = "";
  if (!refData) return;
  refData.pick = refData.pick || new Set();
  out.append(el("div", { class: "rh" }, el("b", { text: "Artist style" }),
    el("span", { text: "PixAI's guess · click to add to the prompts" })));
  const artists = refData.artist || [];
  if (artists.length) {
    out.append(el("div", { class: "artists" }, ...artists.map(([a, p]) => el("span", {
      class: "tftag artist" + (refData.pick.has(a) ? " on" : ""), title: refData.pick.has(a) ? "In the prompts — click to remove" : "Add this artist's style to the prompts",
      onclick: () => { refData.pick.has(a) ? refData.pick.delete(a) : refData.pick.add(a); renderRef(); } },
      el("span", { class: "n", text: a }), el("small", { text: Math.round(p * 100) + "%" })))));
  } else {
    out.append(el("div", { class: "hint", text: (refData.models || []).includes("pixai")
      ? "No artist style recognised. PixAI only knows about 4,900 well-known artists; mixed styles and LoRA styles rarely match."
      : "Turn Advanced off (the Kōbō tagger includes PixAI), or tick PixAI, to get artist guesses (WD has no artist tags)." }));
  }
  if (refData.text && refData.text.length) {
    const words = refData.text.join("\n");
    out.append(el("div", { class: "rh" }, el("b", { text: "Text in the picture" }),
      el("button", { class: "btn sm", text: "Copy", onclick: async () => (await copyText(words)) ? toast("Copied", true) : toast("Couldn't copy") })),
      el("div", { class: "iitext", text: words }));
  }
  for (const t of REF_TARGETS) {
    const ta = el("textarea", { rows: "4" });
    const extraBtns = [];
    // Klein wants sentences rather than tags; Anima reads its tags with the description's sentences mixed in among them.
    const head = t.key === "klein" ? "" : joinTags([QUALITY[t.qk].q, ...t.extra, RATING[t.key][refRating()]]);   // Klein has no rating tags
    const tags = t.key === "klein" ? "" : joinTags([head, refBody(t.engine)]);
    const fill = () => { const d = refDesc[t.key]; ta.value = !d ? tags : t.key === "klein" ? d : mixDescription(head, refBodyTags(t.engine), d); };
    fill();
    if (t.key === "klein") ta.placeholder = "Klein needs sentences, not tags — press ✨ Describe to have the AI write them.";
    if (t.key === "klein" || t.key === "anima") {
      const focus = el("input", { type: "text", maxlength: "120", placeholder: "Focus on… (optional)", title: "A small thing the description should pay attention to, e.g. the necklace or her expression",
        value: refFocus[t.key] || "", oninput: (ev) => { refFocus[t.key] = ev.currentTarget.value; },
        style: "flex:0 1 170px;min-width:0;font-size:12px;padding:3px 6px" });
      const busy = !!refDescBusy[t.key];
      extraBtns.push(focus, el("button", { class: "btn sm", text: busy ? "Looking… (about half a minute)" : refDesc[t.key] ? "Describe again" : "Describe",
        disabled: busy ? "" : null, title: t.key === "anima"
          ? "Sentences mixed in among the tags they describe (written automatically for each new picture): JoyCaption looks at the picture, with the tags as hints"
          : "Write a natural-language prompt: JoyCaption looks at the picture (with these tags as hints); without JoyCaption the prompt writer rewrites the tags",
        onclick: () => describeRef(t.key) }));
    }
    out.append(el("div", { class: "rh" }, el("b", { text: t.label }), ...extraBtns,
      el("button", { class: "btn sm", text: "Copy", onclick: async () => {
        try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand("copy"); }
        toast("Copied", true); } }),
      el("button", { class: "btn sm", text: "Use", title: `Switch to a ${t.label} model and put this in the prompt`, onclick: () => useRef(t, ta.value) })), ta);
  }
  out.append(el("div", { class: "hint", text: `Detected rating: ${refRating()}. Child-related tags are never included.` }));
}

// Quality tags live in their own field, so strip them off before filling the prompt.
function useRef(t, text) {
  const q = QUALITY[t.qk].q;
  let p = text.trim();
  if (p.startsWith(q)) p = p.slice(q.length).replace(/^[\s,]+/, "");
  S.engine = t.engine;
  const e = E(), oldK = qualityKey(S.engine, e.model);
  const models = modelList();
  const m = t.pick.map(re => models.find(n => re.test(n))).find(Boolean);
  if (m) setModel(e, m);
  if (S.engine === "klein") e.te = kleinTE(e.model);
  if (e.negative === QUALITY[oldK].n) e.negative = QUALITY[qualityKey(S.engine, e.model)].n;
  e.quality = q;
  S.prompt = p;
  save(); renderSettings();
  toast(m ? `Prompt set · model: ${stem(m)}` : `Prompt set, but no ${t.label} model was found — pick one manually.`, !!m);
}

async function analyzeRef(file, { upload = true, quiet = false } = {}) {
  if (!file || !/^image\//.test(file.type)) return toast("That isn't an image.");
  const img = $("refImg");
  if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(file); $("drop").classList.add("has"); $("refClear").style.display = "";
  $("dropText").textContent = "Analyzing… (the first image takes a bit longer while the tagger loads)";
  refData = null; refDesc = {}; refDescBusy = {}; renderRef();
  if (upload) uploadRef(file);
  lastRefFile = file;
  const fd = new FormData(); fd.append("image", file, file.name || "image.png");
  fd.append("models", tagModelsParam()); fd.append("rule34", mode === "adult" ? "1" : ""); fd.append("text", "1");
  if (tagModelsParam().includes("joycaption")) $("dropText").textContent = "Analyzing with JoyCaption too… (about half a minute)";
  try {
    refData = await api("/lora-lab/tag", { method: "POST", body: fd });
    $("refControls").style.display = "";
    renderRef();
    describeRef("anima");   // Anima's box gets its sentences without a click
  } catch (err) {
    const downloading = /downloading the image tagger \(/i.test(err.message);
    if (!quiet) toast(ROUTE_MISSING.test(err.message) ? "The tagger isn't loaded — restart ComfyUI once."
      : downloading ? err.message : "Tagging failed: " + err.message, downloading);
  } finally {
    $("dropText").textContent = "Drop or paste another image to replace";
  }
}

// ---------- reference image as a starting point ----------
// The image goes into ComfyUI's input/lora-lab folder so LoadImage can read it.
async function uploadRef(file) {
  const ext = ((/\.(png|jpe?g|webp|bmp|gif)$/i.exec(file.name || "") || [".png"])[0]).toLowerCase();
  const fd = new FormData();
  fd.append("image", file, `ref_${Date.now()}${ext}`);
  fd.append("type", "input"); fd.append("subfolder", "lora-lab"); fd.append("overwrite", "true");
  try {
    const r = await api("/upload/image", { method: "POST", body: fd });
    S.refUpload = { name: r.name, subfolder: r.subfolder || "" };
    S.refSize = await imageSize(file);
    save(); matchRefShape(); renderRefGen(); updateSummary();
  } catch (err) { toast("Couldn't upload the reference image: " + err.message); }
}
function imageSize(blob) {
  return new Promise((res) => {
    const i = new Image(), u = URL.createObjectURL(blob);
    i.onload = () => { res({ w: i.naturalWidth, h: i.naturalHeight }); URL.revokeObjectURL(u); };
    i.onerror = () => { res(null); URL.revokeObjectURL(u); };
    i.src = u;
  });
}
// Same pixel count as 832×1216, at the reference's aspect ratio, in multiples of 64.
function refShape() {
  const size = charRefOn() ? activeChar().refSize : S.refSize;
  if (!size) return null;
  const a = size.w / size.h, area = 832 * 1216;
  const r64 = (v) => Math.max(512, Math.round(v / 64) * 64);
  return { w: r64(Math.sqrt(area * a)), h: r64(Math.sqrt(area / a)) };
}
const refLabel = (ref) => !ref ? "" : ref.mode === "reference" ? ` · reference edit${ref.extra ? ` (+${ref.extra} images)` : ""}` : ` · from image (change ${ref.denoise})`;
function renderRefGen() {
  renderExtraRefs(); syncComposerRef(); renderPose();
  const charRef = charRefOn(), has = !!S.refUpload || charRef;
  $("refGen").style.display = has ? "" : "none";
  if (!has) return;
  const klein = S.engine === "klein";
  $("useRef").checked = S.useRef;
  $("useRefRow").style.display = charRef ? "none" : "";
  $("refCharNote").style.display = charRef ? "" : "none";
  $("refCharNote").textContent = charRef ? `Using ${activeChar().name}'s reference image (set in the Character section).` : "";
  $("refGenOpts").style.display = S.useRef || charRef ? "" : "none";
  $("kleinModeWrap").style.display = klein ? "" : "none";
  $("kleinRefMode").value = S.kleinRefMode;
  $("denoiseWrap").style.display = klein && S.kleinRefMode === "reference" ? "none" : "";
  $("denoise").value = S.denoise; $("denoiseV").textContent = S.denoise.toFixed(2);
  const shape = refShape(), b = $("refShape");
  b.style.display = shape && (shape.w !== S.w || shape.h !== S.h) ? "" : "none";
  if (shape) b.textContent = `Match the image's shape (${shape.w} × ${shape.h})`;
}
// After a reload, bring back the last reference image from ComfyUI's input folder.
async function showStoredRef() {
  const r = S.refUpload;
  if (!r) return;
  try {
    const res = await fetch(`/view?filename=${encodeURIComponent(r.name)}&subfolder=${encodeURIComponent(r.subfolder)}&type=input`);
    const blob = await res.blob();
    if (!res.ok || !/^image\//.test(blob.type)) throw new Error("missing");
    analyzeRef(new File([blob], r.name, { type: blob.type }), { upload: false, quiet: true });
  } catch { S.refUpload = null; S.useRef = false; save(); renderRefGen(); updateSummary(); }
}
$("useRef").onchange = () => { S.useRef = $("useRef").checked; save(); renderRefGen(); updateSummary(); };
$("denoise").addEventListener("input", () => { S.denoise = Number($("denoise").value); $("denoiseV").textContent = S.denoise.toFixed(2); save(); });
$("kleinRefMode").onchange = () => { S.kleinRefMode = $("kleinRefMode").value; save(); renderRefGen(); };

// Extra Klein reference slots (uploaded to ComfyUI's input/lora-lab like the main reference).
let extraSlot = 0;
function renderExtraRefs() {
  const box = $("extraRefs"); box.innerHTML = "";
  if (!Array.isArray(S.extraRefs)) S.extraRefs = [null, null];
  const klein = S.engine === "klein";
  const animaSnap = S.engine === "anima" && snapAvailable();
  // SnapRef needs only Image 2, so on Anima the slot shows without an Image 1.
  $("extraRefsWrap").style.display = animaSnap || S.refUpload || charRefOn() || S.extraRefs.some(Boolean) ? "" : "none";
  const hint = $("extraRefsHint"); hint.innerHTML = ""; hint.className = "hint";
  const sdxlIpa = S.engine === "sdxl" && ipaAvailable();
  $("ipaWrap").style.display = sdxlIpa && S.extraRefs[0] ? "" : "none";
  $("ipaMode").value = S.ipaMode; $("ipaWeight").value = S.ipaWeight; $("ipaWeightV").textContent = Number(S.ipaWeight).toFixed(2);
  $("snapWrap").style.display = animaSnap && S.extraRefs[0] ? "" : "none";
  $("snapMode").value = S.snapMode || "cs"; $("snapWeight").value = S.snapWeight ?? 1; $("snapWeightV").textContent = Number(S.snapWeight ?? 1).toFixed(2);
  const needsKlein = S.extraRefs.some(Boolean) && !sdxlIpa && !animaSnap && (!klein || S.kleinRefMode !== "reference" || !S.useRef);
  if (needsKlein) {
    hint.className = "refwarn";
    hint.append(el("span", { text: !klein
      ? `Image 2 only works with Klein — ${ENGINE_LABEL[S.engine]} would ignore it.`
      : "Image 2 is only used in Klein's \"Reference edit\" with the references switched on." }),
      el("button", { class: "btn sm", text: klein ? "Turn it on" : "Switch to Klein", onclick: useTwoRefs }));
  } else {
    hint.textContent = klein
      ? "Klein combines Image 1 + Image 2 (+ Image 3). Virtual try-on: Image 1 = person, 2 = top, 3 = bottom."
      : sdxlIpa
        ? "Illustrious / Pony use Image 2 as a look reference (IP-Adapter). It's slower, especially on 6 GB GPUs."
        : animaSnap
          ? "Anima draws the character in Image 2 in your scene (SnapRef). Image 1 stays optional: the starting picture."
          : "Add Image 2 to combine two images — that switches you to Klein, the model that can use both.";
  }
  ["Image 2", "Image 3"].forEach((label, i) => {
    if (i === 1 && !klein) return;
    const r = S.extraRefs[i];
    const slot = el("div", { class: "xref", title: r ? "Click to replace" : "Click, or drop an image here", tabindex: "0",
      onclick: () => { extraSlot = i; $("extraRefFile").click(); } },
      r ? el("img", { src: inputUrl(r), alt: "" }) : el("span", { text: "+ " + label }),
      r ? el("button", { class: "x", text: "×", title: "Remove", onclick: (ev) => { ev.stopPropagation(); S.extraRefs[i] = null; save(); renderExtraRefs(); updateSummary(); } }) : null);
    for (const t of ["dragenter", "dragover"]) slot.addEventListener(t, (ev) => { ev.preventDefault(); slot.classList.add("over"); });
    for (const t of ["dragleave", "drop"]) slot.addEventListener(t, (ev) => { ev.preventDefault(); slot.classList.remove("over"); });
    slot.addEventListener("drop", async (ev) => {
      let f = ev.dataTransfer.files[0];
      if (!f) {
        const url = ev.dataTransfer.getData("text/uri-list") || ev.dataTransfer.getData("text/plain");
        if (url) try { const b = await (await fetch(url)).blob(); f = new File([b], "reference.png", { type: b.type }); } catch {}
      }
      if (f) setExtraRef(i, f);
    });
    box.append(slot);
  });
}
// Two (or three) reference images need Klein's reference edit with the references switched on.
function useTwoRefs() {
  if (S.engine !== "klein") S.engine = "klein";
  S.kleinRefMode = "reference"; S.useRef = true;
  save(); renderSettings();
  toast("Klein · Reference edit · using all reference images", true);
}
async function setExtraRef(i, file) {
  if (!file || !/^image\//.test(file.type)) return toast("That isn't an image.");
  const ext = ((/\.(png|jpe?g|webp|bmp|gif)$/i.exec(file.name || "") || [".png"])[0]).toLowerCase();
  const fd = new FormData();
  fd.append("image", file, `ref_extra${i + 2}_${Date.now()}${ext}`);
  fd.append("type", "input"); fd.append("subfolder", "lora-lab"); fd.append("overwrite", "true");
  try {
    const r = await api("/upload/image", { method: "POST", body: fd });
    S.extraRefs[i] = { name: r.name, subfolder: r.subfolder || "" };
    if (S.engine === "klein") { S.kleinRefMode = "reference"; S.useRef = true; }   // adding Image 2 means "use them"
    save(); renderRefGen(); updateSummary();
  } catch (err) { toast("Couldn't upload the image: " + err.message); }
}
$("ipaMode").onchange = () => { S.ipaMode = $("ipaMode").value; save(); updateSummary(); };
$("ipaWeight").addEventListener("input", () => { S.ipaWeight = Number($("ipaWeight").value); $("ipaWeightV").textContent = S.ipaWeight.toFixed(2); save(); });
$("snapMode").onchange = () => { S.snapMode = $("snapMode").value; save(); updateSummary(); };
$("snapWeight").addEventListener("input", () => { S.snapWeight = Number($("snapWeight").value); $("snapWeightV").textContent = S.snapWeight.toFixed(2); save(); });
$("extraRefFile").onchange = () => { setExtraRef(extraSlot, $("extraRefFile").files[0]); $("extraRefFile").value = ""; };
function matchRefShape() {
  const s = refShape(); if (!s || (s.w === S.w && s.h === S.h)) return;
  S.w = s.w; S.h = s.h;
  S.size = [...$("size").options].some(o => o.value === `${s.w}x${s.h}`) ? `${s.w}x${s.h}` : "custom";
  save(); renderSettings();
  toast(`Size set to the reference's shape: ${s.w} × ${s.h}`, true);
}
$("refShape").onclick = matchRefShape;

// ---------- AI prompt writer (Ollama) ----------
// A missing server route shows up as 404 or 405 depending on which static route catches it.
const ROUTE_MISSING = /not found|method not allowed/i;
const dolphinError = (err) => ROUTE_MISSING.test(err.message)
  ? "The prompt writer isn't loaded — restart ComfyUI once." : "Prompt writer: " + err.message;
const dolphinTarget = () => S.engine === "sdxl" ? (qualityKey("sdxl", E().model) === "pony" ? "pony" : "illustrious") : S.engine;
async function askDolphin(idea, target, newLook, nude, notes = "") {
  const ch = activeChar();
  const r = await post("/lora-lab/llm", { idea, target, model: $("llmModel").value, sfw: mode === "general", rule34: mode === "adult", new_look: !!newLook, nude: !!nude, notes,
    character: ch ? { name: ch.name, memory: ch.memory || "" } : null });
  if (!r || !r.text) throw new Error("The prompt writer returned an empty prompt");
  return r.text;
}
let undoPrompt = null;
async function writeWithDolphin() {
  const typed = $("idea").value.trim(), orient = orientationIn(typed), idea = dropOrientation(typed);
  applyOrientation(orient);
  if (!idea) return orient ? null : toast("Type an idea first.");
  const btn = $("dolphinBtn"), st = $("dolphinStatus"), t0 = Date.now();
  let written = false;
  btn.disabled = true;
  st.textContent = "Writing the prompt… on slower PCs this can take a minute or two.";
  try {
    // The writer sometimes adds "portrait" as a framing tag; only the user's own words pick the shape.
    const text = dropOrientation(await askDolphin(idea, dolphinTarget()));
    undoPrompt = S.prompt; S.prompt = text; $("prompt").value = text; save(); renderLibrary();
    written = true;
    st.textContent = `Written in ${Math.round((Date.now() - t0) / 1000)} s · `;
    st.append(el("a", { href: "#", text: "Undo", style: "color:var(--accent)", onclick: (ev) => {
      ev.preventDefault();
      if (undoPrompt != null) { S.prompt = undoPrompt; $("prompt").value = undoPrompt; undoPrompt = null; save(); renderLibrary(); }
      st.textContent = "";
    } }));
  } catch (err) {
    st.textContent = ""; toast(dolphinError(err));
  } finally { btn.disabled = false; }
  return written;
}
$("dolphinBtn").onclick = writeWithDolphin;

// ---------- Workflow tab ----------
// Idea -> prompt (AI writer) -> review (a second AI pass) -> test (one picture) -> your check -> generate (the full batch).
// "Make a set": like the themed sets AI artists post on Patreon. After the review the AI plans a shot list (same character,
// outfit, place and lighting; only pose, camera and expression change), the test is the hero shot, and the set is drawn
// with the Sequence machinery: one picture per shot, the same seed, later shots drawn from shot 1 where the model can.
// Uses the model, LoRAs and settings on the right. The folder (workflow.py) gives ideas (.txt, one per line), notes the
// AI follows (.md) and reference pictures, and gets a copy of every approved picture in its approved/ folder.
let wf = { folder: "", ideas: [], images: [], notes: "" }, wfLoaded = false, flowIdea = "", wfIdeaIdx = -1;
const wfImgUrl = (name) => `/lora-lab/workflow/image?name=${encodeURIComponent(name)}`;
const wfSetOn = () => $("wfSet").checked;
const flowSteps = () => wfSetOn() ? ["Idea", "Prompt", "Review", "Shot list", "Hero test", "Your check", "Make the set"] : ["Idea", "Prompt", "Review", "Test", "Your check", "Generate"];
// A pasted set block may carry its "## name" heading and a "SHARED:" line (the tags every shot shares): neither is a shot.
const parseShots = (text) => text.split("\n").map(s => s.trim()).filter(s => !/^(#|shared:|\/\/|```)/i.test(s))
  .map(s => s.replace(/^(shot\s*)?\d+(\s*[.):-]\s*|\s+)/i, "")).filter(Boolean);   // "1. full body" / "1  full body" → "full body"
const MAX_SHOTS = 35;   // llm.SET_MAX and kobo_cli.MAX_SHOTS match it
const wfShotList = () => parseShots($("wfShotList").value).slice(0, MAX_SHOTS);
const wfSharedLine = () => ((/^\s*shared:(.*)$/im.exec($("wfShotList").value) || [])[1] || "").trim();
function renderFlow(stepIdx, msg, buttons = []) {
  $("flowBox").replaceChildren(
    el("div", { class: "flowsteps" }, flowSteps().map((s, i) => el("span", { class: i < stepIdx ? "done" : i === stepIdx ? "on" : "", text: (i < stepIdx ? "✓ " : "") + s }))),
    el("div", { class: "hint", text: msg }),
    ...(buttons.length ? [el("div", { class: "inline" }, buttons)] : []));   // replaceChildren(null) would show "null"
  $("flowBox").style.display = "";
}
const step = (name) => flowSteps().findIndex(s => s === name || (name === "test" && /test/i.test(s)) || (name === "final" && s === flowSteps().at(-1)));
const flowBtn = (text, onclick, cls = "btn sm") => el("button", { class: cls, text, onclick });
function flowDone(msg, extra = []) {
  $("wfStart").disabled = false;
  const next = wfIdeaIdx >= 0 && wfIdeaIdx + 1 < wf.ideas.length;
  renderFlow(flowSteps().length, msg, [...extra, ...(next ? [flowBtn("Next idea from the folder", () => { useWfIdea(wfIdeaIdx + 1); runFlow(); }, "btn sm primary")] : [])]);
}
function setWfPrompt(text) { S.prompt = text; $("prompt").value = text; $("wfPrompt").value = text; save(); renderLibrary(); }
$("wfPrompt").addEventListener("input", () => { S.prompt = $("wfPrompt").value; $("prompt").value = S.prompt; save(); });
function wfShot(img, label) { $("wfShots").append(el("a", { href: imgUrl(img), target: "_blank", title: label }, el("img", { src: imgUrl(img), alt: label }), el("span", { text: label }))); }
function renderWfSet() { $("wfSetBox").style.display = wfSetOn() ? "" : "none"; store.set("wfSet", wfSetOn()); store.set("wfSetShots", $("wfSetShots").value); }
$("wfSet").checked = !!store.get("wfSet", false); $("wfSetShots").value = store.get("wfSetShots", 12);
$("wfSet").onchange = $("wfSetShots").onchange = renderWfSet;
renderWfSet();

async function runFlow() {
  flowIdea = $("wfIdea").value.trim();
  applyOrientation(orientationIn(flowIdea));
  const idea = dropOrientation(flowIdea);
  if (!idea) return flowOwn();
  $("wfStart").disabled = true; $("wfShots").replaceChildren();
  renderFlow(1, "Writing the prompt… on slower PCs this can take a minute or two.");
  try { setWfPrompt(dropOrientation(await askDolphin(idea, dolphinTarget(), false, false, wf.notes))); }
  catch (err) { toast(dolphinError(err)); return flowDone("Stopped: the prompt couldn't be written."); }
  await flowReview();
}
// No idea typed: skip the writer, review and planner and draw what is already in the boxes: the pasted shot list (its
// "SHARED:" line goes to the Prompt box) or, without a set, the Prompt alone.
function flowOwn() {
  const set = wfSetOn(), shared = wfSharedLine();
  if (shared) setWfPrompt(shared);
  if (set ? wfShotList().length < 2 : !S.prompt.trim())
    return toast(set ? "Type an idea, or paste a shot list (2 lines or more) to draw it as it is." : "Type an idea, or write a prompt to draw it as it is.");
  flowIdea = `${activeChar() ? activeChar().name + " " : ""}${set ? "set" : "picture"}`;   // names the approved/ folder
  wfStaged = set ? new Set() : null;   // the pasted shots say what she wears, so her saved outfit stays out of the set
  $("wfStages").textContent = "";
  $("wfStart").disabled = true; $("wfShots").replaceChildren();
  return flowTest(set ? "Drawing your own shot list." : "Drawing your own prompt.");
}
const wfCharBody = () => { const ch = activeChar(); return ch ? { name: ch.name, memory: ch.memory || "" } : null; };
async function flowReview() {
  renderFlow(2, "The AI is checking the prompt against your idea…");
  let r;
  try {
    r = await post("/lora-lab/llm/review", { idea: dropOrientation(flowIdea), prompt: S.prompt, target: dolphinTarget(), model: $("llmModel").value,
      sfw: mode === "general", character: wfCharBody(), notes: wf.notes });
  } catch (err) { toast(dolphinError(err)); return flowDone("Stopped at the review. The written prompt is in the Prompt box."); }
  setWfPrompt(r.prompt);
  await (wfSetOn() ? flowPlanShots("Review: " + r.notes) : flowTest("Review: " + r.notes));
}
// Clothing that changes during the set (found in the idea by the planner): the shots carry what she wears, so while the set
// is drawn the main prompt and the character's saved outfit leave their clothing out. null = one outfit for the whole set.
let wfStaged = null;
function renderWfStages(stages, outfit) {
  wfStaged = stages.length ? new Set(outfit.map(normTag)) : null;
  $("wfStages").textContent = stages.length ? "Clothing: " + [`shot 1: ${outfit.join(", ") || "her outfit"}`, ...stages.map(s => `from shot ${s.shot}: ${s.wearing}`)].join(" · ") : "";
}
async function flowPlanShots(note = "") {
  const n = Math.max(4, Math.min(MAX_SHOTS, $("wfSetShots").value | 0 || 12));
  renderFlow(3, (note ? note + " " : "") + `Planning ${n} shots… this can take a few minutes with a big AI model.`);
  try {
    const r = await post("/lora-lab/llm/set", { idea: dropOrientation(flowIdea), prompt: S.prompt, shots: n, target: dolphinTarget(), model: $("llmModel").value,
      sfw: mode === "general", character: wfCharBody(), notes: wf.notes, outfit: activeChar() && S.charUse.outfit ? activeChar().outfit || "" : "" });
    $("wfShotList").value = r.shots.join("\n");
    renderWfStages(r.stages, r.outfit);
    if (r.base && r.base !== S.prompt) setWfPrompt(r.base);   // the shared look only: framing (and changing clothes) live in the shots
  } catch (err) { toast(ROUTE_MISSING.test(err.message) ? "Sets need a restart of Kōbō once." : dolphinError(err)); return flowDone("Stopped while planning the shots. The prompt is in the Prompt box."); }
  await flowTest(note);
}
async function flowTest(note = "") {
  const set = wfSetOn();
  renderFlow(step("test"), (note ? note + " " : "") + (set ? "Drawing the hero test picture (shot 1)…" : "Drawing one test picture…"));
  const before = batches[0], hero = set && wfShotList()[0], prompt = S.prompt;
  if (hero) S.prompt = framePrompt(hero);   // the hero is shot 1: the main prompt plus its pose, camera and clothing
  try { await generate({ variations: 1 }); }   // one picture, new seed (kept in Seed, so the final pictures can repeat it)
  finally { if (hero) { S.prompt = prompt; save(); } }
  const b = batches[0];
  if (b === before) return flowDone("Stopped: the test picture couldn't start (pick a model on the right?).");
  const img = await waitForImage(b, 0);
  if (!img) return flowDone("Stopped: the test picture failed. See Image Generation for the error.");
  wfShot(img, set ? "Hero test" : "Test");
  const shots = wfShotList().length;
  renderFlow(step("Your check"), (note ? note + " " : "") + (set ? "Check the hero picture. Edit the Prompt or the shot list if you like, then:" : "Check the test picture. Edit the Prompt box if you like, then:"), [
    set ? flowBtn(`Looks good: make the set (${shots} shots)`, () => flowMakeSet(1), "btn sm primary")
        : flowBtn(`Looks good: generate ${Math.max(1, S.count | 0)}`, () => flowGenerate(0), "btn sm primary"),
    set ? flowBtn(`🎲 ×10 seeds (${shots * 10} pictures)`, () => flowMakeSet(10), "btn sm")
        : flowBtn("🎲 ×10 seeds", () => flowGenerate(10), "btn sm"),
    flowBtn("Test again", () => flowTest()),
    flowBtn("Review again", () => flowReview()),
    ...(set ? [flowBtn("New shot list", () => flowPlanShots())] : []),
    flowBtn("Stop", () => flowDone("Stopped. The prompt stays in the Prompt box.")),
  ]);
}
// Waits for every picture of the batches generate() just added, shows them and copies them to the folder.
async function wfCollect(old, group = "", perSet = 0) {
  const made = batches.filter(b => !old.has(b));   // old = the batches before generate(); works with an empty history too
  let n = 0, saved = 0, failed = 0;
  for (const b of made) for (let i = 0; i < b.cells.length; i++) {
    const img = await waitForImage(b, i);
    if (!img) { failed++; continue; }
    n++; wfShot(img, `#${n}`);
    if (!wf.folder) continue;
    const where = perSet ? `${group} seed ${Math.floor(i / perSet) + 1}` : group;   // cells are in set order: shots 1..N of seed 1, then seed 2…
    try { await post("/lora-lab/workflow/save", { image: img, set: where }); saved++; } catch (err) { toast("Couldn't copy to your folder: " + err.message); }
  }
  return { n, saved, failed };
}
const wfDoneText = (r, where) => `Done: ${r.n} picture${r.n === 1 ? "" : "s"}` + (wf.folder ? `, ${r.saved} copied to ${where}` : "") + (r.failed ? `, ${r.failed} failed` : "") + ".";
async function flowGenerate(variations) {
  renderFlow(step("final"), variations ? `Generating ${variations} pictures, each with its own random seed…` : "Generating…");
  const old = new Set(batches);
  await generate(variations ? { variations } : undefined);
  flowDone(wfDoneText(await wfCollect(old),`${wf.folder}\\approved`), variations ? [] : [flowBtn("🎲 ×10 seeds", () => flowGenerate(10), "btn sm")]);
}
const wfGroup = () => `${new Date().toISOString().slice(0, 10)} ${dropOrientation(flowIdea).replace(/[^\w \-]/g, "").replace(/\s+/g, " ").slice(0, 36)}`.trim();   // + " seed 10" stays within the server's 60 characters
// Generate with a shot list: one batch with one picture per shot (the Prompt box + that line), each with its own seed and
// no hero reference, so every shot is a separate picture.
async function flowEachShot(shots) {
  renderFlow(step("final"), `Drawing ${shots.length} shots, one picture each…`);
  const keep = { seq: S.seq, count: S.count, charUse: S.charUse }, old = new Set(batches);
  S.seq = { ...S.seq, on: true, count: shots.length, beats: shots, sameSeed: false, carry: false, story: "" };
  S.count = 1; S.charUse = { ...S.charUse, outfit: false };   // the shots say what she wears
  try { await generate(); }
  finally { Object.assign(S, keep); save(); renderSeq(); updateSummary(); }
  const group = wfGroup();
  flowDone(wfDoneText(await wfCollect(old, group), `${wf.folder}\\approved\\${group}`));
}
// shots defaults to the shot list box; the ×10 button passes the list it drew, since a loaded file restores the box afterwards.
async function flowMakeSet(sets, shots = wfShotList()) {
  if (shots.length < 2) return toast("The shot list needs at least 2 shots (one per line).");
  renderFlow(step("final"), sets > 1 ? `Drawing ${sets} sets of ${shots.length} shots (${sets * shots.length} pictures). Set 1 uses the hero's seed, the others each have their own…`
    : `Drawing the set: ${shots.length} shots, each from the hero's seed…`);
  // The set borrows the Sequence settings for one run: one picture per shot, the same seed inside a set, shot 1 as the look
  // reference. Several sets are one batch with count = sets: set i has seed + i.
  const keep = { seq: S.seq, autoSeed: S.autoSeed, count: S.count, prompt: S.prompt, charUse: S.charUse };
  if (wfStaged && !isPhotoEngine(S.engine)) {
    S.prompt = splitTags(S.prompt).filter(t => !wfStaged.has(normTag(t)) && !OUTFIT_RE.test(normTag(t))).join(", ");
    S.charUse = { ...S.charUse, outfit: false };
  }
  S.seq = { ...S.seq, on: true, count: shots.length, beats: shots, sameSeed: true, carry: true, story: dropOrientation(flowIdea) };
  S.autoSeed = false; S.count = sets;
  const old = new Set(batches);
  try { await generate(); }
  finally { Object.assign(S, keep); save(); renderSeq(); updateSummary(); }
  const group = wfGroup();
  flowDone(wfDoneText(await wfCollect(old, group,sets > 1 ? shots.length : 0), `${wf.folder}\\approved\\${group}${sets > 1 ? " seed 1 to " + sets : ""}`),
    sets > 1 ? [] : [flowBtn(`🎲 ×10 seeds (${shots.length * 10} pictures)`, () => flowMakeSet(10, shots), "btn sm")]);
}
$("wfStart").onclick = runFlow;
// Generate: draw the boxes as they are, like Image Generation's Generate: no AI writer, review or test picture.
// With Make a set on and a shot list, every shot is drawn as its own picture; otherwise the Prompt box (empty with a character = a new look).
$("wfGo").onclick = () => {
  if ($("wfStart").disabled) return toast("Wait for the current run to finish.");
  const shared = wfSharedLine(), shots = wfSetOn() ? wfShotList() : [];
  if (shared) setWfPrompt(shared);
  flowIdea = $("wfIdea").value.trim() || `${activeChar() ? activeChar().name + " " : ""}${shots.length ? "set" : "picture"}`;   // names the approved/ folder
  wfStaged = null; $("wfStages").textContent = "";
  $("wfStart").disabled = true; $("wfShots").replaceChildren();
  return shots.length ? flowEachShot(shots) : flowGenerate(0);
};
// A prompts file (.txt / .md, one prompt per line) skips the writer, review and hero check: it is drawn at once, one picture
// per line, with the active character and the right panel's model and LoRAs. "## name" headings split it into sets drawn one
// after another (text above the first heading is skipped), and a set longer than MAX_SHOTS lines is drawn MAX_SHOTS at a time.
const FILE_MINOR = /\b(loli\w*|shota\w*|child\w*|kids?|toddlers?|bab(y|ies)|minors?|underage|aged down|teens?|teenagers?|preteens?|schoolgirls?|schoolboys?|school uniform|elementary school|middle school|high school)\b/i;
// Animals alone are fine; only a file that pairs animal tags with sex tags is refused.
const FILE_SEX = /\b(sex\w*|nude|naked|nsfw|penis|pussy|vagina|cock|cum|cumshot|fellatio|cunnilingus|penetrat\w*|intercourse|masturbat\w*|genital\w*|erection|zoophilia|bestiality)\b/i;
$("wfLoadFile").onclick = () => $("wfFile").click();
$("wfFile").onchange = async () => {
  const file = $("wfFile").files[0];
  $("wfFile").value = "";
  if (!file || $("wfStart").disabled) return;
  const text = await file.text();
  if (FILE_MINOR.test(text) || (ANIMAL_SEX.test(text) && FILE_SEX.test(text))) return toast("This file has child tags, or animal tags with sex tags, so it won't be drawn.");
  const stem = file.name.replace(/\.(txt|md)$/i, "");
  const blocks = /^## /m.test(text) ? text.split(/^## /m).slice(1).map(b => ({ name: b.split("\n")[0].trim(), body: b.slice(b.split("\n")[0].length) }))
    : [{ name: stem, body: text }];
  const runs = blocks.flatMap(({ name, body }) => {
    const shots = parseShots(body), shared = ((/^\s*shared:(.*)$/im.exec(body) || [])[1] || "").trim(), parts = [];
    for (let i = 0; i < shots.length; i += MAX_SHOTS) parts.push({ name: (name || stem) + (shots.length > MAX_SHOTS ? ` part ${i / MAX_SHOTS + 1}` : ""), shared, shots: shots.slice(i, i + MAX_SHOTS) });
    return parts;
  });
  if (!runs.length) return toast("No prompts found: put one prompt per line.");
  toast(`${file.name}: drawing ${runs.reduce((n, r) => n + r.shots.length, 0)} prompts in ${runs.length} run${runs.length > 1 ? "s" : ""}`, true);
  $("wfIdea").value = "";
  await wfDrawRuns(runs, 1);
};
// sets = 1 draws each run once; 10 draws every run with 10 seeds (the ×10 button offered when a file with several runs is done).
async function wfDrawRuns(runs, sets) {
  const keepShots = $("wfShotList").value;
  for (const r of runs) {
    flowIdea = r.name;   // names the approved/ folder
    wfStaged = null; $("wfStages").textContent = ""; $("wfShots").replaceChildren();
    $("wfStart").disabled = true;
    $("wfShotList").value = r.shots.join("\n");
    if (r.shots.length === 1) {
      $("wfSet").checked = false; renderWfSet();
      setWfPrompt(joinTags([r.shared, r.shots[0]]));
      await flowGenerate(sets > 1 ? sets : 0);
    } else {
      $("wfSet").checked = true; $("wfSetShots").value = r.shots.length; renderWfSet();
      setWfPrompt(r.shared);   // the lines are whole prompts: only a SHARED: line goes in front of each
      await flowMakeSet(sets, r.shots);
    }
  }
  $("wfShotList").value = keepShots;
  const total = runs.reduce((n, r) => n + r.shots.length, 0);
  if (runs.length > 1 && sets === 1)   // one run already offers ×10 for itself; several runs get one button for all of them
    flowDone(`Done: ${runs.length} runs, ${total} prompts.`, [flowBtn(`🎲 ×10 seeds, all runs (${total * 10} pictures)`, () => wfDrawRuns(runs, 10), "btn sm")]);
}

// Models in use: the image model comes from the right panel; the AI writer (Ollama) is the same pick as the Write row's.
function renderWfModels() {
  const e = E(), more = alsoModels().length;
  $("wfImgModel").textContent = e.model ? stem(e.model) : "none picked";
  $("wfImgNote").textContent = `${ENGINE_LABEL[S.engine]}${more ? `, plus ${more} more` : ""} · change it in the right panel`;
}
function syncWfLlm() {
  const src = $("llmModel"), dst = $("wfLlm");
  dst.replaceChildren(...[...src.options].map(o => el("option", { value: o.value, text: o.text })));
  if (!src.options.length) dst.append(el("option", { value: "", text: "Ollama isn't running" }));
  dst.value = src.value;
}
$("wfLlm").onchange = () => { $("llmModel").value = $("wfLlm").value; store.set("llmModel", $("llmModel").value); };

// Chat: "remove the lantern, add rain, make shot 3 a close-up" edits the prompt and the shot list.
let wfUndo = null;
function wfSay(who, text) { $("wfLog").append(el("div", { class: who, text })); $("wfLog").scrollTop = 1e6; }
async function sendWfChat() {
  const text = $("wfChatIn").value.trim();
  if (!text) return;
  const btn = $("wfChatBtn");
  btn.disabled = true; wfSay("me", text); $("wfChatIn").value = "";
  try {
    const r = await post("/lora-lab/llm/edit", { instruction: text, prompt: S.prompt, shots: wfSetOn() ? wfShotList() : [], target: dolphinTarget(),
      model: $("llmModel").value, sfw: mode === "general", character: wfCharBody(), notes: wf.notes });
    if (r.changed) {
      wfUndo = { prompt: S.prompt, shots: $("wfShotList").value };
      setWfPrompt(r.prompt);
      if (wfSetOn() && r.shots.length) $("wfShotList").value = r.shots.join("\n");
      $("wfChatUndo").hidden = false;
    }
    wfSay("ai", r.reply);
  } catch (err) { wfSay("ai", ROUTE_MISSING.test(err.message) ? "The chat isn't loaded: restart Kōbō once." : dolphinError(err)); }
  finally { btn.disabled = false; }
}
$("wfChatBtn").onclick = sendWfChat;
$("wfChatIn").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); if (!$("wfChatBtn").disabled) sendWfChat(); } });
$("wfChatUndo").onclick = () => {
  if (!wfUndo) return;
  setWfPrompt(wfUndo.prompt); $("wfShotList").value = wfUndo.shots; wfUndo = null;
  $("wfChatUndo").hidden = true; wfSay("ai", "Undone.");
};
$("wfIdea").addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !$("wfStart").disabled) { ev.preventDefault(); runFlow(); } });

function useWfIdea(i) {
  wfIdeaIdx = i; $("wfIdea").value = wf.ideas[i].text;
  for (const [k, b] of [...$("wfIdeas").children].entries()) b.classList.toggle("on", k === i);
}
async function useWfRef(name, btn) {
  try {
    const res = await fetch(wfImgUrl(name));
    if (!res.ok) throw new Error(res.statusText);
    await uploadRef(new File([await res.blob()], name));
    S.useRef = true; $("useRef").checked = true; save(); renderRefGen(); updateSummary();
    for (const b of $("wfRefs").children) b.classList.toggle("on", b === btn);
    toast(`${name} is the reference image`, true);
  } catch (err) { toast("Couldn't use that picture: " + err.message); }
}
function renderWfFolder() {
  if (wf.folder) $("wfFolder").value = wf.folder;
  $("wfFolderInfo").textContent = wf.folder
    ? `${wf.ideas.length} idea${wf.ideas.length === 1 ? "" : "s"} · ${wf.images.length} picture${wf.images.length === 1 ? "" : "s"} · ${wf.notes ? "notes found, the AI follows them" : "no .md notes"}`
    : "No folder yet.";
  $("wfIdeas").replaceChildren(...wf.ideas.map((it, i) => el("button", { class: "wfidea" + (i === wfIdeaIdx ? " on" : ""), title: it.file, text: it.text, onclick: () => useWfIdea(i) })));
  $("wfRefs").replaceChildren(...wf.images.map((n) => {
    const b = el("button", { class: "wfref", title: `Use ${n} as the reference image` }, el("img", { src: wfImgUrl(n), alt: n, loading: "lazy" }));
    b.onclick = () => useWfRef(n, b);
    return b;
  }));
}
async function loadWfFolder() {
  wfLoaded = true;
  try { wf = await api("/lora-lab/workflow/folder"); } catch (err) { toast(ROUTE_MISSING.test(err.message) ? "The Workflow folder isn't loaded: restart Kōbō once." : err.message); }
  renderWfFolder();
}
$("wfFolderSet").onclick = async () => {
  try { wf = await post("/lora-lab/workflow/folder", { folder: $("wfFolder").value }); wfIdeaIdx = -1; renderWfFolder(); toast("Folder ready", true); }
  catch (err) { toast(err.message); }
};
$("wfFolderReload").onclick = loadWfFolder;
// The Workflow tab's character is the panel's active character: picking it in either place changes both.
function renderWfChar() {
  const sel = $("wfChar"), ch = activeChar();
  sel.replaceChildren(el("option", { value: "", text: wsChars().length ? "No character" : "No characters yet (make one in the Characters tab)" }),
    ...wsChars().map(c => el("option", { value: c.id, text: c.name })));
  sel.value = ch ? ch.id : "";
  const refNote = ch && ch.ref && S.charUse.ref ? " Their reference picture is used instead of a folder picture." : "";
  $("wfCharNote").textContent = ch ? `Their look${ch.loras.length ? " and LoRAs are" : " is"} added to every picture, and the AI writes the scene around them.${refNote}` : "";
}
$("wfChar").onchange = () => { S.charId = $("wfChar").value; save(); renderCharActive(); renderCharList(); prefetchAssoc(); };
function enterWorkflowTab() { $("wfPrompt").value = S.prompt; renderWfModels(); syncWfLlm(); if (!wfLoaded) loadWfFolder(); }

// Assistant: the local model turns a chat line into a plan (/lora-lab/assistant); the page carries it out with its own
// Write and Generate, so the picked image model, LoRAs and settings are used as they are.
let asstTurns = [];
async function askAssistant() {
  const text = $("asstIn").value.trim();
  if (!text) return;
  const btn = $("asstBtn"), log = $("asstLog");
  btn.disabled = true; log.textContent = "Thinking…";
  try {
    const p = await post("/lora-lab/assistant", { message: text, history: asstTurns, characters: wsChars().map(c => c.name),
      model: $("llmModel").value, sfw: mode === "general" });
    asstTurns = [...asstTurns, { user: text, assistant: p.reply }].slice(-6);
    $("asstIn").value = "";
    log.textContent = p.reply;
    if (p.character) {
      const ch = p.character === "none" ? null : wsChars().find(c => c.name === p.character);
      S.charId = ch ? ch.id : ""; save(); renderCharActive(); renderCharList(); prefetchAssoc();
    }
    if (p.count) { S.count = p.count; $("count").value = p.count; save(); updateSummary(); }
    if (p.orientation !== "keep") applyOrientation(p.orientation);
    if (p.action === "generate" || p.action === "write") {
      $("idea").value = p.idea;
      log.textContent = p.reply + " Writing the prompt…";
      if (!await writeWithDolphin()) return void (log.textContent = p.reply);
      log.textContent = p.reply;
    }
    if (p.action === "generate" || p.action === "again") await generate();
  } catch (err) {
    log.textContent = ""; toast(ROUTE_MISSING.test(err.message) ? "The assistant isn't loaded — restart Kōbō once." : "Assistant: " + err.message);
  } finally { btn.disabled = false; }
}
$("asstBtn").onclick = askAssistant;
$("asstIn").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); askAssistant(); } });

// New look: Generate with a character and an empty prompt gives them a fresh outfit, pose and place every time,
// written by the AI writer or mixed from the Tag library. Their saved outfit is skipped so the clothes don't clash,
// and the last few looks are remembered so the next one is different.
function newLookOn() { return !!activeChar() && !S.prompt.trim() && !seqActive() && (S.newLook || "ai") !== "off"; }
// Random Tag-library tags must make sense together: each pick has to fit the tags already in the look (the Extra 18+
// tags, the character's appearance and the earlier picks). A tag's traits come from LOOK_RULES; LOOK_ONE traits allow
// one tag each (one place, one posture, one framing…) and LOOK_CLASH pairs can't meet (beach and coat, nude and a dress).
const LOOK_RULES = [
  [/^(beach|forest|bedroom|cafe|rooftop|city|ocean|mountain|nature|underwater|pool|classroom|bathroom|kitchen|office|street|park|onsen|shower|bathtub)$|^(?!blurry ).*background$/, "place"],
  [/^(?!blurry ).*background$/, "plain"],
  [/^(outdoors|beach|forest|city|rooftop|ocean|mountain|nature|underwater|wading|rain|snow|cherry blossoms|horizon|scenery|street|park|public nudity)$/, "outdoor"],
  [/^(indoors|bedroom|cafe|classroom|bathroom|kitchen|office|shower|bathtub)$/, "indoor"],
  [/^(rain|snow)$/, "weather"],
  [/^(snow|ice|coat|scarf|sweater|turtleneck|mittens|winter clothes)$/, "cold"],
  [/^(beach|ocean|pool|wading|underwater|onsen|swimsuit|bikini|side-tie bikini bottom)$/, "hot"],
  [/^underwater$/, "submerged"], [/^(fire|steam|rain|snow|smoke)$/, "dry"],
  [/^(day|night|sunset)$/, "time"], [/^(day|sunlight)$/, "day"], [/^(night|starry sky|star \(sky\)|moon|neon lights)$/, "night"], [/^sunset$/, "dusk"],
  [/^(standing|sitting|lying|kneeling|walking|running|squatting|on back|on stomach|on side|all fours|seiza|wariza|flying|floating|standing on one leg|bent over|straddling|upright straddle|top-down bottom-up|standing sex|standing missionary|mating press|prone bone|missionary|missionary position|doggystyle|doggy style|full nelson|spooning|folded|suspended congress|reverse suspended congress|riding|female on top|amazon position)$|position$/, "posture"],
  [/^(standing|walking|running|standing on one leg|bent over|standing sex|standing missionary|full nelson|suspended congress|reverse suspended congress)$/, "upright"],
  [/^(knees up|legs up|knee up|sitting|lying|kneeling|squatting|on back|on stomach|on side|all fours|seiza|wariza)$/, "floor"],
  [/^(close-up|portrait|upper body|cowboy shot|full body|wide shot|cropped torso)$/, "framing"], [/^(close-up|portrait)$/, "close"],
  [/^holding (?!hands$)|^(carrying|pointing|waving|reading|eating|drinking)$/, "busy"],
  [/^(from above|from below|from side|from behind|straight-on)$/, "angle"],
  [/^(looking at viewer|looking away|looking to the side|looking down|looking up|looking at another|eye contact|closed eyes|eyes rolled back)$/, "gaze"],
  [/^(smile|light smile|grin|smirk|serious|frown|expressionless|surprised|embarrassed|happy|:d|:o|:3|;d|ahegao|ahe gao|naughty face|pleasure face|looking pleasured|crying)$/, "mood"],
  [/^(.* )?(dress|gown|kimono|yukata|swimsuit|bikini|leotard|bodysuit|suit|armor|maid|uniform|playboy bunny|chinese clothes|japanese clothes|qipao|robe|nightgown|jumpsuit)$/, "onepiece"],
  [/^(.* )?(shirt|t-shirt|blouse|sweater|hoodie|tank top|crop top|tube top|turtleneck|camisole)$/, "top"],
  [/^(.* )?(skirt|miniskirt|pants|jeans|shorts|bikini bottom)$/, "bottom"],
  [/^(.* )?(thighhighs|pantyhose|kneehighs|socks|stockings|tights|leggings)$/, "legwear"],
  [/^(.* )?(shoes|boots|high heels|sandals|sneakers|loafers|slippers)$|^barefoot$/, "shoes"],
  [/^(.* )?(hat|beret|helmet|mob cap|crown|tiara)$|^hood$/, "headwear"],
  [/^((puffy )?long sleeves|juliet sleeves|sleeves past wrists)$/, "longsl"], [/^(puffy )?short sleeves$/, "shortsl"], [/^sleeveless/, "nosl"],
  [/^(nude|naked|completely nude|fully nude|nude female)$/, "nude"], [/^(completely nude|fully nude)$/, "bare"],
  [/^(lingerie|garter straps|garter belt|pasties|fishnets|bikini|swimsuit)$/, "underwear"],
  [/^(breasts out|shirt lift|open clothes|panties aside|clothed sex|clothed|partially clothed|cumming through clothing|covered nipples|dildo under clothes|torn clothes|wet clothes|see-through clothes|lifting skirt|undressing)$/, "clothed"],
  [/^bottomless$/, "nobottom"], [/^no panties$/, "nopanties"], [/^(?!no )(.* )?(panties|thong|g-string)$|^panties aside$/, "panties"],
  [/^no bra$/, "nobra"], [/^(?!no )(.* )?bra$/, "bra"],
  [/^(flat chest|(small|medium|large|big|huge|gigantic) breasts)$/, "breasts"],
  [/^(solo|masturbation|female masturbation)$/, "solo"],
  [/\b(sex|fellatio|blowjob|deepthroat|handjob|paizuri|irrumatio|cunnilingus|anilingus|buttjob|footjob|penetrat\w*|position|missionary|doggystyle|doggy style|mating press|prone bone|spooning|full nelson|suspended congress|threesome|gangbang|spitroast|face fucking|kissing|groping|breast sucking|creampie|facial|thrusting|male pov|balls deep|penis in pussy|netorare|femdom)\b|^(oral|vaginal|anal|riding|female on top)$/, "partner"],
  [/^(fellatio|oral|oral sex|blowjob|deepthroat|irrumatio|cunnilingus|anilingus|handjob|paizuri|buttjob|face fucking|cum in mouth|cum in throat|oral penetration)$/, "oral"],
  [/position$|^(standing sex|mating press|prone bone|missionary|full nelson|doggystyle|doggy style|suspended congress|reverse suspended congress|upright straddle|standing missionary|spooning|folded|vaginal|anal|vaginal sex|anal sex|vaginal penetration|anal penetration|penis in pussy|sex from behind|riding|female on top|cum in pussy|cum in ass|balls deep|thrusting|deep penetration|double penetration)$/, "penetration"],
];
const LOOK_ONE = new Set(["place", "weather", "time", "posture", "framing", "angle", "gaze", "mood", "onepiece", "top", "bottom", "legwear", "shoes", "headwear", "breasts"]);
const LOOK_CLASH = {};
for (const [a, b] of [["indoor", "outdoor"], ["plain", "indoor"], ["plain", "outdoor"], ["hot", "cold"], ["submerged", "dry"],
  ["day", "night"], ["day", "dusk"], ["night", "dusk"], ["upright", "floor"], ["onepiece", "top"], ["onepiece", "bottom"],
  ["longsl", "shortsl"], ["longsl", "nosl"], ["shortsl", "nosl"], ["nude", "clothed"], ["nude", "garment"],
  ["nobottom", "bottom"], ["nobottom", "onepiece"], ["nobottom", "panties"], ["nopanties", "panties"], ["nobra", "bra"],
  ["bare", "bra"], ["bare", "panties"], ["bare", "underwear"], ["bare", "legwear"], ["bare", "shoes"],
  ["solo", "partner"], ["oral", "penetration"], ["busy", "partner"], ["busy", "solo"],
  ["close", "posture"], ["close", "partner"], ["close", "shoes"], ["close", "legwear"]]) {
  (LOOK_CLASH[a] || (LOOK_CLASH[a] = new Set())).add(b);
  (LOOK_CLASH[b] || (LOOK_CLASH[b] = new Set())).add(a);
}
// Library tags that don't belong in a random look: objects filed under Setting, drawing-style or "no character" tags,
// and tags that change who is in the picture.
const LOOK_SKIP = /^(no humans|animal focus|animal|scenery|multiple views|sketch|outline|polka dot|tree|out of frame|feet out of frame|foot out of frame|faceless|weapon|food|cup|mug|bottle|fruit|strawberry|heart|star \(symbol\)|sparkle|bubble|drinking|male|female|human|1girls|duo|straight|clothing|genitals|anthro|intersex|1futa|futanari|futa .*|futasub|trap|yaoi|male penetrated|male focus)$/;
function lookTraits(t) {
  t = normTag(t);
  const s = new Set(LOOK_RULES.filter(([re]) => re.test(t)).map(([, trait]) => trait));
  if (isGarment(t)) s.add("garment");
  return s;
}
function fitsLook(t, have) {
  const n = normTag(t), mine = [...lookTraits(t)];
  return have.every(h => {
    if (normTag(h) === n) return false;
    const other = lookTraits(h);
    return !mine.some(x => (LOOK_ONE.has(x) && other.has(x)) || [...(LOOK_CLASH[x] || [])].some(y => other.has(y)));
  });
}
// Hair and eye colour belong to the character, so they're never picked.
const fitFirst = (list, have) => list.find(t => !LOOK_SKIP.test(normTag(t)) && !isTrait(normTag(t)) && fitsLook(t, have)) || null;
// With related tags (rel: tag -> score), a category's tags that go with the Extra 18+ tags are tried first, better matches
// more often (weighted shuffle); a category with none that fit falls back to any tag that fits. Categories with only a
// few related tags use them half the time, so the same tag doesn't come up in every look.
function pickFit(pool, have, rel) {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  if (!rel) return fitFirst(shuffled, have);
  const hits = pool.filter(t => rel.has(normTag(t))).map(t => [t, Math.random() ** (1 / rel.get(normTag(t)))])
    .sort((a, b) => b[1] - a[1]).map(([t]) => t);
  return (Math.random() < (hits.length >= 4 ? 0.85 : 0.5) && fitFirst(hits, have)) || fitFirst(shuffled, have);
}
// Booru tags that often appear next to the given tags (TagFinder), summed over the tags; looked up once per tag and
// kept in this browser. Danbooru only: its related-tag API answers in a few seconds, while Safebooru's post sampling
// takes minutes and has almost nothing for 18+ tags. Tags are looked up in parallel.
const assocCache = store.get("tagAssoc", {}), assocLoading = {};
async function relatedTags(tags) {
  const keys = [...new Set(tags.map(normTag))];
  await Promise.all(keys.filter(k => !assocCache[k]).map(k => assocLoading[k] || (assocLoading[k] =
    api("/lora-lab/tagfinder/similar?" + tfQuery({ tag: k, rating: "any", category: "general", limit: 200, sites: "danbooru" }))
      .then(r => { assocCache[k] = r.similar_tags.map(x => [normTag(x.tag), Math.max(x.score, 1e-4)]); store.set("tagAssoc", assocCache); })
      .finally(() => delete assocLoading[k]))));
  const rel = new Map();
  for (const k of keys) for (const [n, score] of assocCache[k]) rel.set(n, (rel.get(n) || 0) + score);
  return rel;
}
const assocOn = (tags) => adultMode() && !!S.newLookAssoc && tags.length > 0;
// Starts the lookups as soon as the tags are typed, so Generate usually finds them ready.
function prefetchAssoc() {
  const ch = activeChar(), tags = ch ? splitTags((S.newLookExtra || {})[ch.id]) : [];
  if (assocOn(tags)) relatedTags(tags).catch(() => {});
}
// The "dog" category, animal-sex tags and child-related tags are never used.
const ANIMAL_SEX = /\b(dogs?|canine|equine|horse|animal genitalia|zoophilia|bestiality|feral|knot\w*)\b/i;
const lookPool = (re, adultOnly) => lib ? lib.categories.filter(c => catVisible(c) && (!adultOnly || c.adult) && re.test(c.name) && !/^dog$/i.test(c.name.trim()))
  .flatMap(c => c.tags).filter(t => !ANIMAL_SEX.test(t) && !REF_BLOCK.has(normTag(t))) : [];
// The place comes first so the outfit can suit it; with 18+ tags on, nudity and the sex act come before clothes and pose.
function randomLook(seed, rel) {
  const look = [], add = (re, n, adultOnly) => {
    const pool = lookPool(re, adultOnly);
    for (let i = 0; i < n; i++) { const t = pickFit(pool, [...seed, ...look], rel); if (!t) break; look.push(t); }
  };
  const adult = adultMode() && S.newLookAdult !== false;
  add(/setting|place|location|background|scene/i, 1);
  if (adult) { add(/nudity/i, 1, true); add(/sex act|position/i, 1, true); }
  add(/cloth|outfit|wear|dress/i, 2);
  if (adult) add(/lingerie|fetish/i, 1, true);
  add(/pose|action/i, 1); add(/face|express|emotion/i, 1); add(/camera|light|shot/i, 1);
  if (adult) add(/rule34/i, 1, true);
  return joinTags(look);
}
async function newLookPrompt() {
  const ch = activeChar(), key = `newLook.${mode}.${ch.id}`, recent = store.get(key, []), st = $("dolphinStatus");
  // Extra 18+ tags (Adult workspace only) go into every new look for this character.
  const extra = adultMode() ? splitTags((S.newLookExtra || {})[ch.id]).filter(t => !REF_BLOCK.has(normTag(t))) : [];
  const nude = extra.some(isNudeTag), adultAi = adultMode() && !!S.newLookAdultAi;
  let look = "", rel = null;
  if (assocOn(extra)) {
    st.textContent = `🔗 Looking up tags that go with ${extra.join(", ")}…`;
    try { rel = await relatedTags(extra); }
    catch (err) { toast(tfError(err, "Couldn't look up related tags") + " Using normal random tags."); }
  }
  // The AI writer gets the closest related tags as suggestions.
  const relHint = rel ? [...rel].sort((a, b) => b[1] - a[1]).map(([t]) => t).filter(t => !ANIMAL_SEX.test(t) && !REF_BLOCK.has(t)).slice(0, 25) : [];
  if ((S.newLook || "ai") === "ai") {
    st.textContent = `🎲 Writing a new look for ${ch.name}…`;
    try {
      look = await askDolphin(`${ch.name} ${nude ? "naked, with no clothes, in a new pose and place" : "in a new outfit, pose and place"}.`
        + (adultAi ? " This is an explicit 18+ image for adults: " + (nude ? "" : "make the outfit sexy and revealing (lingerie, fetish wear or half undressed), ")
          + "give them a seductive or sexual pose and expression, and an intimate setting that suits it." : "")
        + (extra.length ? ` Build the look around: ${extra.join(", ")}. Every other tag must make sense together with these.` : "")
        + (relHint.length ? ` Prefer tags that usually go with them, such as: ${relHint.join(", ")}.` : "")
        + (recent.length ? ` Make it clearly different from these recent looks: ${recent.join(" | ")}` : ""), dolphinTarget(), true, nude);
    } catch (err) { toast(dolphinError(err) + " Using a random Tag library mix instead."); }
  }
  const seed = [...extra, ...splitTags(joinTags(charPromptParts(true, "")))];
  if (!look) look = randomLook(seed, rel);
  // Hair and eyes belong to the character (and their learned LoRA), not to the outfit of the day. AI tags that clash
  // with the Extra 18+ tags, the character or each other are dropped too.
  if (!isPhotoEngine(S.engine)) {
    const kept = [];
    for (const t of splitTags(look)) if (!isTrait(normTag(t)) && fitsLook(t, [...seed, ...kept])) kept.push(t);
    look = kept.join(", ");
  }
  // Nude (from the Extra 18+ tags or the look itself): no clothes but underwear. Sentences (Klein, Z-Image)
  // can't be filtered tag by tag; the writer is told instead.
  if (!isPhotoEngine(S.engine) && (nude || hasNude(look))) look = dropGarments(look);
  if (extra.length) {
    const have = new Set(splitTags(look).map(normTag));
    look = joinTags([look, ...extra.filter(t => !have.has(normTag(t)))]);
  }
  if (!look) { st.textContent = ""; toast("Add tags to the Clothing, Pose and Setting categories of your Tag library, or set “With an empty prompt” to “Just the character”."); return null; }
  store.set(key, [look.slice(0, 160), ...recent].slice(0, 5));
  st.textContent = `🎲 New look: ${look}`;
  return look;
}
$("idea").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); writeWithDolphin(); } });

$("drop").onclick = () => $("refFile").click();
$("drop").onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); $("refFile").click(); } };
$("refFile").onchange = () => { analyzeRef($("refFile").files[0]); $("refFile").value = ""; };
for (const t of ["dragenter", "dragover"]) $("drop").addEventListener(t, (ev) => { ev.preventDefault(); $("drop").classList.add("over"); });
for (const t of ["dragleave", "drop"]) $("drop").addEventListener(t, (ev) => { ev.preventDefault(); $("drop").classList.remove("over"); });
$("drop").addEventListener("drop", async (ev) => {
  const f = ev.dataTransfer.files[0];
  if (f) return analyzeRef(f);
  // Images dragged from the results grid arrive as a URL, not a file.
  const url = ev.dataTransfer.getData("text/uri-list") || ev.dataTransfer.getData("text/plain");
  if (!url) return;
  try { const b = await (await fetch(url)).blob(); analyzeRef(new File([b], "reference.png", { type: b.type })); }
  catch { toast("Couldn't read that image — save it and drop the file instead."); }
});
document.addEventListener("paste", (ev) => {
  const files = [...((ev.clipboardData && ev.clipboardData.files) || [])].filter(x => /^image\//.test(x.type)), f = files[0];
  if (!f) return;
  if (tab === "train") { if (dsCur) { ev.preventDefault(); dsUpload(files); } return; }
  ev.preventDefault();
  if (tab === "3d") upload3dSource(f);
  else if (tab === "info") loadInfo(f);
  else if (tab === "chars" && editChar()) setCharRef(f); else analyzeRef(f);
});
$("refThr").addEventListener("input", () => { S.refThr = Number($("refThr").value); save(); renderRef(); });
// Which image taggers to combine; models that aren't installed are greyed out.
var lastRefFile = null;   // var: analyzeRef (defined earlier) may run before this line
// The one Kōbō tagger (empty = the server's default, PixAI + Haruka) unless Advanced is on; also used by Image info
// and the character "Tags from image" button. A function declaration, so callers above this line can use it.
function tagModelsParam() { return S.tagAdvanced ? (S.tagModels || []).join(",") : ""; }
function renderTagModels(avail) {
  $("tagAdvanced").checked = !!S.tagAdvanced;
  $("tagModels").style.display = S.tagAdvanced ? "" : "none";
  for (const cb of $("tagModels").querySelectorAll("input")) {
    cb.checked = (S.tagModels || []).includes(cb.value);
    if (avail) {
      cb.disabled = !avail[cb.value];
      cb.parentElement.title = avail[cb.value] ? "" : (cb.value === "joycaption"
        ? "Not installed: add the joycaption-beta-one model to Ollama" : "Model files not found in ComfyUI's models folder");
    }
  }
}
$("tagModels").addEventListener("change", () => {
  S.tagModels = [...$("tagModels").querySelectorAll("input:checked")].map(i => i.value);
  if (!S.tagModels.length) S.tagModels = ["pixai"];
  save(); renderTagModels();
  if (lastRefFile) analyzeRef(lastRefFile, { upload: false });
});
$("tagAdvanced").addEventListener("change", () => {
  S.tagAdvanced = $("tagAdvanced").checked;
  save(); renderTagModels();
  if (lastRefFile) analyzeRef(lastRefFile, { upload: false });
});
renderTagModels();
api("/lora-lab/tagger/status").then(renderTagModels).catch(() => {});   // older server: all stay enabled
$("refChars").onchange = () => { S.refChars = $("refChars").checked; save(); renderRef(); };
$("refNameThr").addEventListener("input", () => { S.refNameThr = Number($("refNameThr").value); save(); renderRef(); });
$("refSimple").onchange = () => { S.refSimple = $("refSimple").checked; save(); renderRef(); };
$("refClear").onclick = () => {
  refData = null; refDesc = {}; refDescBusy = {}; $("drop").classList.remove("has"); $("dropText").textContent = DROP_TEXT;
  $("refControls").style.display = "none"; $("refClear").style.display = "none"; renderRef();
  S.refUpload = null; S.refSize = null; S.useRef = false; S.extraRefs = [null, null]; save(); renderRefGen(); updateSummary();
};

// ---------- tag library ----------
// Stored on the ComfyUI machine, so every window and device shares one library.
const LIB_ALL = "All";
let lib = null, libCat = store.get("libCat", LIB_ALL), libEditing = false, libSynced = false, libSaveTimer = null;
let libSort = null, libSorting = false;   // libSort: category name -> pasted tags waiting in the preview
const splitTags = (s) => (s || "").split(",").map(t => t.trim()).filter(Boolean);
const normTag = (t) => t.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();

async function loadLibrary() {
  try { lib = await api("/lora-lab/tags"); libSynced = true; }
  catch { lib = lib || store.get("libLocal", null) || { categories: [] }; libSynced = false; }
  renderLibrary();
}
function saveLibrary() {
  store.set("libLocal", lib);
  renderLibrary();
  clearTimeout(libSaveTimer);
  libSaveTimer = setTimeout(async () => {
    libSaveTimer = null;
    try { lib = await post("/lora-lab/tags", lib); libSynced = true; }
    catch (err) { libSynced = false; if (!ROUTE_MISSING.test(err.message)) toast("Couldn't save the tag library: " + err.message); }
    renderLibrary();
  }, 400);
}
// Adult categories (flagged by the server) only exist in the Adult 18+ workspace.
const catVisible = (c) => adultMode() || !c.adult;
function currentLibCat() { return lib && lib.categories.find(c => c.name === libCat && catVisible(c)); }

function renderLibrary() {
  if (!lib) return;
  renderNewLookCats();
  if (libCat !== LIB_ALL && !currentLibCat()) libCat = LIB_ALL;
  $("libNote").textContent = libSynced ? "" : " · not shared yet — restart Kōbō";
  $("libNote").className = "hint";
  const cats = $("libCats"); cats.innerHTML = "";
  for (const name of [LIB_ALL, ...lib.categories.filter(catVisible).map(c => c.name)]) {
    cats.append(el("button", { class: "cat" + (name === libCat ? " on" : ""), text: name,
      onclick: () => { libCat = name; store.set("libCat", name); renderLibrary(); } }));
  }
  const q = normTag($("libSearch").value);
  const clickTarget = libTarget();
  const inPrompt = new Set(splitTags(clickTarget.get()).map(normTag));
  $("libHint").textContent = `Click a tag to add it to ${clickTarget.label}, click again to remove it.`;
  const box = $("libTags"); box.innerHTML = ""; box.classList.toggle("editing", libEditing);
  let shown = 0;
  for (const c of lib.categories.filter(catVisible)) {
    if (libCat !== LIB_ALL && c.name !== libCat) continue;
    for (const t of c.tags) {
      if (q && !normTag(t).includes(q)) continue;
      const on = inPrompt.has(normTag(t));
      box.append(el("span", { class: "tag" + (on ? " on" : ""), text: libEditing ? t + "  ×" : t,
        title: libEditing ? `Remove "${t}" from ${c.name}` : on ? "In the prompt — click to remove" : "Click to add to the prompt",
        onclick: () => libEditing ? removeLibTag(c, t) : togglePromptTag(t) }));
      shown++;
    }
  }
  if (!shown) box.append(el("span", { class: "hint", text: q ? "No matching tags." : "No tags here yet — use ✎ Edit to add some." }));
  $("libHint").style.display = libEditing ? "none" : "";
  $("libEditor").style.display = libEditing ? "" : "none";
  $("libEdit").textContent = libEditing ? "✓ Done" : "Edit";
  const target = currentLibCat();
  $("libTarget").textContent = target ? target.name : "My tags";
  $("libDelCat").style.display = target ? "" : "none";
  renderLibSort();
}

// Library clicks go to the character field you last clicked into while on the Characters tab, else the prompt.
function libTarget() {
  if (tab === "chars" && editChar() && lastCharField) {
    const f = $(lastCharField);
    return { label: `${editChar().name}'s ${{ charAppearance: "appearance", charOutfit: "outfit", charTriggers: "name tag" }[lastCharField]}`,
      get: () => f.value, set: (v) => { f.value = v; f.dispatchEvent(new Event("input")); } };
  }
  return { label: "the prompt", get: () => S.prompt, set: (v) => { S.prompt = v; $("prompt").value = v; save(); } };
}
function togglePromptTag(t) {
  const target = libTarget();
  const tags = splitTags(target.get()), i = tags.findIndex(x => normTag(x) === normTag(t));
  if (i >= 0) tags.splice(i, 1); else tags.push(t);
  target.set(tags.join(", "));
  renderLibrary();
}
function removeLibTag(c, t) { c.tags = c.tags.filter(x => x !== t); saveLibrary(); }
function addLibTags(text) {
  const tags = splitTags(text);
  if (!tags.length) return;
  const blocked = tags.filter(t => REF_BLOCK.has(normTag(t)));
  if (blocked.length) toast("Child-related tags can't be added: " + blocked.join(", "));
  let cat = currentLibCat();
  if (!cat) {   // "All" is selected: collect into a "My tags" category
    const mine = adultMode() ? "My tags 18+" : "My tags";
    cat = lib.categories.find(c => c.name === mine);
    if (!cat) { cat = { name: mine, tags: [], adult: adultMode() }; lib.categories.push(cat); }
  }
  let added = 0;
  for (const t of tags) {
    if (REF_BLOCK.has(normTag(t)) || cat.tags.some(x => normTag(x) === normTag(t))) continue;
    cat.tags.push(t); added++;
  }
  saveLibrary();
  if (added) toast(`Added ${added} tag${added > 1 ? "s" : ""} to ${cat.name}`, true);
  else if (!blocked.length) toast(`Those tags are already in ${cat.name}`, true);
}

$("libEdit").onclick = () => { libEditing = !libEditing; renderLibrary(); };
$("libSearch").addEventListener("input", renderLibrary);
$("libAddTags").onclick = () => { addLibTags($("libNewTags").value); $("libNewTags").value = ""; };
$("libNewTags").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); $("libAddTags").click(); } });
$("libFromPrompt").onclick = () => addLibTags(S.prompt);
$("libAddCat").onclick = () => {
  const name = $("libNewCat").value.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name || name === LIB_ALL) return;
  if (lib.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) return toast(`"${name}" already exists`);
  lib.categories.push({ name, tags: [], adult: adultMode() });
  libCat = name; store.set("libCat", name); $("libNewCat").value = "";
  saveLibrary();
};
$("libNewCat").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); $("libAddCat").click(); } });
$("libDelCat").onclick = () => {
  const cat = currentLibCat(); if (!cat) return;
  if (!confirm(`Delete the "${cat.name}" category and its ${cat.tags.length} tags?`)) return;
  lib.categories = lib.categories.filter(c => c !== cat);
  libCat = LIB_ALL; store.set("libCat", LIB_ALL);
  saveLibrary();
};

// Paste & sort: a pasted wall of prompts, captions or booru tag lists is split into tags, the prompt writer's model
// says which category each one fits, and nothing is saved until the preview is accepted.
const REF_BLOCK_WORDS = new RegExp("\\b(?:" + [...REF_BLOCK].join("|") + ")\\b");
function pastedTags(text) {
  const have = new Set(lib.categories.flatMap(c => c.tags.map(normTag)));
  const tags = [], seen = new Set(), skipped = { known: 0, long: 0, blocked: 0 };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/<[^>]*>/g, " ").replace(/\\([()])/g, "$1");   // <lora:…> and escaped brackets
    // "? long hair 4.9M" is a row copied from a booru sidebar; a line of under_scored words is a booru post's tag list.
    const parts = /^\s*\?\s/.test(line) ? [line.replace(/^\s*\?\s+(?:[+\-–]\s+)*/, "").replace(/\s+[\d.,]+[kM]?\s*$/, "")]
      : line.includes(",") || !/\w_\w/.test(line) ? line.split(",") : line.trim().split(/\s+/);
    for (let t of parts) {
      t = t.trim().replace(/(?<=\w):[\d.]+(?=[)\]}]*$)/, "");          // (tag:1.2)
      while (/^[([{].*[)\]}]$/.test(t)) t = t.slice(1, -1).trim();      // ((tag))
      t = t.replace(/(?<=[a-z0-9])_(?=[a-z0-9])/gi, " ").replace(/\s+/g, " ").replace(/(?<=\w)\.$/, "").toLowerCase();
      const key = normTag(t);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (REF_BLOCK_WORDS.test(key)) skipped.blocked++;
      else if (have.has(key)) skipped.known++;
      else if (key.length > 80 || key.split(" ").length > 6) skipped.long++;   // a sentence, not a tag
      else tags.push(t);
    }
  }
  return { tags, skipped };
}
function renderLibSort() {
  const box = $("libSorted"); box.innerHTML = "";
  const total = libSort ? [...libSort.values()].reduce((n, tags) => n + tags.length, 0) : 0;
  if (!total) return;
  const to = currentLibCat();
  box.append(el("div", { class: "hint", text: to ? `Click a tag to move it to ${to.name}; click one already there to leave it out.`
    : "Click a tag to leave it out — or pick a category at the top first, then click tags to move them there." }));
  for (const [name, tags] of libSort) {
    if (!tags.length) continue;
    box.append(el("label", { text: `${name} · ${tags.length}` }), el("div", { class: "libtags" }, tags.map(t => el("span", { class: "tag", text: t,
      onclick: () => {
        tags.splice(tags.indexOf(t), 1);
        if (to && to.name !== name) libSort.set(to.name, [...(libSort.get(to.name) || []), t]);
        renderLibSort();
      } }))));
  }
  box.append(el("div", { class: "inline", style: "margin-top:8px" },
    el("button", { class: "btn sm primary", text: `Add ${total} tag${total > 1 ? "s" : ""} to the library`, onclick: applyLibSort }),
    el("button", { class: "btn sm", text: "Discard", onclick: () => { libSort = null; libSorting = false; renderLibSort(); } })));
}
function applyLibSort() {
  let added = 0;
  for (const [name, tags] of libSort) {
    if (!tags.length) continue;
    let cat = lib.categories.find(c => c.name === name);
    if (!cat) { cat = { name, tags: [], adult: mode === "adult" }; lib.categories.push(cat); }
    cat.tags.push(...tags); added += tags.length;
  }
  libSort = null; libSorting = false; $("libPaste").value = "";
  saveLibrary();
  toast(`Added ${added} tag${added > 1 ? "s" : ""} to the library`, true);
}
$("libSort").onclick = async () => {
  if (libSorting) { libSorting = false; return; }   // Stop: the batch being sorted still lands
  const { tags, skipped } = pastedTags($("libPaste").value), st = $("libSortStatus");
  const notes = [skipped.known && `${skipped.known} already in the library`, skipped.long && `${skipped.long} too long to be tags`,
    skipped.blocked && `${skipped.blocked} child-related (never added)`].filter(Boolean).join(" · ");
  if (!tags.length) { st.textContent = notes || "Paste some tags first."; return; }
  const mine = mode === "adult" ? "My tags 18+" : "My tags", sorted = libSort = new Map();   // tags no category fits go to My tags
  libSorting = true; $("libSort").textContent = "■ Stop";
  try {
    for (let i = 0; i < tags.length && libSorting; i += 40) {
      st.textContent = `Sorting ${i} of ${tags.length} tags…`;
      const batch = tags.slice(i, i + 40);
      const r = await post("/lora-lab/tags/sort", { tags: batch, model: $("llmModel").value, sfw: mode === "general", free: i === 0 });
      for (const t of batch) { const name = r.sorted[t] || mine; sorted.set(name, [...(sorted.get(name) || []), t]); }
      renderLibSort();
    }
    st.textContent = notes;
  } catch (err) { st.textContent = ""; toast(dolphinError(err)); }
  libSorting = false; $("libSort").textContent = "Sort into categories";
};
let libPromptTimer = null;
$("prompt").addEventListener("input", () => { clearTimeout(libPromptTimer); libPromptTimer = setTimeout(() => { renderLibrary(); renderTf(); }, 150); });
// Pick up changes made on another device when this window comes back into view.
document.addEventListener("visibilitychange", () => { if (!document.hidden && !libEditing && !libSaveTimer) loadLibrary(); });

// ---------- tag finder ----------
// Related booru tags for a main tag, from the TagFinder app; the ComfyUI server does the searching.
// sfw=1 (General workspace) makes the server use safe ratings and skip adult-only sites.
let tfSites = [], tfResults = [], tfView = null;
const tfQuery = (o) => new URLSearchParams({ ...o, sfw: mode === "general" ? "1" : "0" }).toString();
const tfText = (t) => t.replace(/_/g, " ");
const tfImg = (url) => "/lora-lab/tagfinder/image?url=" + encodeURIComponent(url);
const tfError = (err, what) => ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable TagFinder." : `${what}: ${err.message}`;
const shortCount = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);

async function loadTfSites() {
  try { tfSites = await api("/lora-lab/tagfinder/sites?" + tfQuery({})); }
  catch (err) { tfSites = []; $("tfStatus").textContent = tfError(err, "TagFinder"); }
  const chosen = store.get("tfSites." + mode, null);
  $("tfSites").innerHTML = "";
  for (const s of tfSites) {
    const cb = el("input", { type: "checkbox", "data-site": s.name,
      onchange: () => store.set("tfSites." + mode, [...$("tfSites").querySelectorAll("input:checked")].map(x => x.dataset.site)) });
    cb.checked = chosen ? chosen.includes(s.name) : s.default;
    $("tfSites").append(el("label", { class: "check" }, cb, " " + s.label));
  }
  fillSelect($("tfViewSite"), tfSites.map(s => s.name), null, (n) => tfSites.find(s => s.name === n).label);
}
function resetTf() {
  tfResults = []; tfView = null;
  $("tfStatus").textContent = ""; $("tfView").style.display = "none";
  renderTf(); loadTfSites();
}

async function tfSearch(tag) {
  tag = (tag ?? $("tfTag").value).trim();
  if (!tag) return $("tfTag").focus();
  $("tfTag").value = tag;
  const sites = [...$("tfSites").querySelectorAll("input:checked")].map(x => x.dataset.site);
  if (!sites.length) return toast("Tick at least one site to search");
  $("tfGo").disabled = true;
  $("tfStatus").textContent = `Searching ${sites.map(n => tfSites.find(s => s.name === n).label).join(", ")}…`;
  try {
    const r = await api("/lora-lab/tagfinder/similar?" + tfQuery({ tag, sites: sites.join(","), category: $("tfCat").value, rating: $("tfRating").value, limit: 60 }));
    tfResults = r.similar_tags;
    const perSite = Object.entries(r.sites).map(([n, s]) => s.error ? `${n} failed (${s.error})` : `${n}: ${s.posts.toLocaleString()} posts`);
    $("tfStatus").textContent = `${tfResults.length} related tags for "${tfText(r.main_tag)}" · ${perSite.join(" · ")}`;
    if (!tfResults.length && r.suggestions.length)
      $("tfStatus").append(" · Did you mean: ", ...r.suggestions.map(s => el("span", { class: "tag", text: tfText(s), onclick: () => tfSearch(tfText(s)) }), " "));
  } catch (err) {
    tfResults = []; $("tfStatus").textContent = tfError(err, "Search failed");
  } finally { $("tfGo").disabled = false; }
  renderTf();
}

function renderTf() {
  const box = $("tfTags"); box.innerHTML = "";
  const inPrompt = new Set(splitTags(libTarget().get()).map(normTag));
  for (const r of tfResults) {
    const t = tfText(r.tag), toggle = () => { togglePromptTag(t); renderTf(); };
    box.append(el("span", { class: `tftag ${r.category}${inPrompt.has(normTag(t)) ? " on" : ""}`,
      title: `${r.category} · ${r.posts.toLocaleString()} posts · similarity ${r.score} · ${r.sites.join(", ")}` },
      el("span", { class: "n", text: t, onclick: toggle }),
      el("small", { text: shortCount(r.posts), onclick: toggle }),
      el("button", { text: "🖼", title: `Example images for ${t}`, onclick: () => tfOpenView(r.tag) }),
      el("button", { text: "→", title: `Find tags related to ${t}`, onclick: () => tfSearch(t) })));
  }
  $("tfActions").style.display = tfResults.length ? "" : "none";
}

async function tfOpenView(tag, more) {
  if (!more) {
    tfView = { tag, site: $("tfViewSite").value, page: 0, posts: [] };
    $("tfView").style.display = ""; $("tfGrid").innerHTML = "";
    $("tfViewTitle").textContent = `Examples: ${tfText(tag)}`;
    $("tfView").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  const v = tfView; v.page++;
  $("tfMore").style.display = "none"; $("tfViewStatus").textContent = "Loading…";
  try {
    const r = await api("/lora-lab/tagfinder/posts?" + tfQuery({ site: v.site, tag: v.tag, rating: $("tfRating").value, page: v.page }));
    if (v !== tfView) return;
    const start = v.posts.length;
    v.posts.push(...r.posts.filter(p => !p.video));
    const site = (tfSites.find(s => s.name === v.site) || {}).label || v.site;
    v.posts.slice(start).forEach((p, i) => $("tfGrid").append(el("img", { src: tfImg(p.preview), loading: "lazy", alt: "",
      onclick: () => openLbItems(v.posts.map(x => ({ src: tfImg(x.sample), page: x.page, site, label: `${tfText(v.tag)} · ${site}` })), start + i) })));
    $("tfViewStatus").textContent = v.posts.length ? "" : "No example images here.";
    $("tfMore").style.display = r.more ? "" : "none";
  } catch (err) { if (v === tfView) $("tfViewStatus").textContent = tfError(err, "Couldn't load examples"); }
}

$("tfGo").onclick = () => tfSearch();
$("tfTag").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); tfSearch(); } });
for (const id of ["tfCat", "tfRating"]) $(id).onchange = () => { if ($("tfTag").value.trim()) tfSearch(); };
$("tfAllToPrompt").onclick = () => {
  const target = libTarget(), tags = splitTags(target.get()), have = new Set(tags.map(normTag));
  for (const r of tfResults) { const t = tfText(r.tag); if (!have.has(normTag(t))) { tags.push(t); have.add(normTag(t)); } }
  target.set(tags.join(", ")); renderLibrary(); renderTf();
};
$("tfToLib").onclick = () => addLibTags(tfResults.map(r => tfText(r.tag)).join(", "));
$("tfViewSite").onchange = () => { if (tfView) tfOpenView(tfView.tag); };
$("tfMore").onclick = () => tfOpenView(tfView.tag, true);
$("tfViewClose").onclick = () => { tfView = null; $("tfView").style.display = "none"; };

// ---------- prompt writer model ----------
// "" = Auto: the server picks the strongest installed (qwen3.5 9B, then the 4Bs, …). The list is whatever chat models Ollama has installed.
async function loadLlmModels() {
  let r;
  try { r = await api("/lora-lab/llm/models"); } catch { r = { models: [], default: null }; }
  const sel = $("llmModel"), want = store.get("llmModel", ""), short = (n) => n.replace(/:latest$/, "");
  sel.innerHTML = "";
  sel.append(el("option", { value: "", text: r.default ? `Auto · ${short(r.default)}` : "Auto" }));
  for (const n of r.models) sel.append(el("option", { value: n, text: short(n) }));
  sel.value = r.models.includes(want) ? want : "";
  sel.style.display = r.models.length > 1 ? "" : "none";
  syncWfLlm();
}
$("llmModel").onchange = () => { store.set("llmModel", $("llmModel").value); syncWfLlm(); };

// ---------- tag autocomplete ----------
// Suggests real Danbooru tags while typing in any tag field. danbooru_tags.csv (tag, category, post count, "aliases")
// is the same list the server's prompt-writer filter uses; it loads the first time someone types.
const AC_FIELDS = "#prompt, #negative, #negativeQuick, #quality, #charTriggers, #charAppearance, #charOutfit, #charNegative, #libNewTags, #seqFrames input, #tfTag, .dscard textarea, #dsBulk";
const AC_CATS = { 0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta" };
let acTags = null, acLoading = null, acBox = null, acField = null, acItems = [], acSel = 0;

function loadAcTags() {
  acLoading = acLoading || fetch("danbooru_tags.csv").then(r => r.text()).then(txt => {
    const tags = [], keys = [];
    for (const line of txt.split("\n")) {
      const m = line.match(/^([^,"]+),(\d+),(\d+),"?([^"]*)"?\r?$/);   // skips the few names with quotes in them
      if (!m) continue;
      const i = tags.length, name = m[1].replace(/_/g, " ");
      tags.push({ name, cat: AC_CATS[m[2]] || "general", count: +m[3] });
      keys.push([name, i, false]);
      for (const a of m[4].split(",")) if (a && !a.startsWith("/")) keys.push([a.replace(/_/g, " "), i, true]);
    }
    acTags = { tags, keys };
  });
  return acLoading;
}
// Anima only reads an artist tag with "@" in front (@wlop); without it the style barely shows. Danbooru artist names
// (not aliases, 3+ letters) get the "@", and so do "by wlop" and "artist:wlop"; weights like (wlop:1.2) are kept.
let acArtists = null;
function animaArtists(text) {
  if (S.engine !== "anima") return text;
  if (acTags && !acArtists) acArtists = new Set(acTags.tags.filter(t => t.cat === "artist" && t.name.length >= 3).map(t => t.name));
  return text.split(/([,\n])/).map((part, i) => {
    const m = i % 2 ? null : part.match(/^(\s*\(*\s*)(.*?)(\s*(?::\s*-?[\d.]+)?\s*\)*\s*)$/);
    if (!m || !m[2] || m[2].startsWith("@")) return part;
    let [, lead, core, tail] = m;
    const opens = (s) => (s.match(/\(/g) || []).length - (s.match(/\)/g) || []).length;
    while (opens(core) > 0 && /^\s*\)/.test(tail)) { core += ")"; tail = tail.replace(/^\s*\)/, ""); }   // "ask (askzy)"
    const tagged = core.match(/^artist\s*:\s*(.+)$/i), by = core.match(/^by\s+(.+)$/i);
    const name = tagged ? tagged[1] : by ? by[1] : core;
    const known = acArtists && acArtists.has(name.toLowerCase().replace(/_/g, " ").replace(/\\/g, ""));
    return tagged || known ? `${lead}@${name}${tail}` : part;
  }).join("");
}
// The tag being typed: from the last comma or line break up to the caret, without weight brackets.
function acToken(f) {
  if (f.selectionStart !== f.selectionEnd) return null;
  const v = f.value, end = f.selectionStart;
  let start = Math.max(v.lastIndexOf(",", end - 1), v.lastIndexOf("\n", end - 1)) + 1;
  start += v.slice(start, end).match(/^[\s([{]*/)[0].length;
  const q = v.slice(start, end).toLowerCase().replace(/_/g, " ");
  return q.trim().length >= 2 ? { start, end, q } : null;
}
// Tags whose name or alias starts with what you typed, or has a later word starting with it ("miku" -> hatsune miku),
// ranked by popularity with a boost for starting matches.
function acMatch(q) {
  const banned = mode === "general" ? adultTagSet() : null;
  const hits = [], seen = new Set();
  for (const [key, i, alias] of acTags.keys) {
    const prefix = key.startsWith(q);
    if ((!prefix && !key.includes(" " + q)) || seen.has(i)) continue;
    const t = acTags.tags[i];
    if (REF_BLOCK.has(t.name) || (banned && banned.has(t.name))) continue;
    seen.add(i); hits.push({ ...t, alias: alias ? key : null, rank: t.count * (prefix ? 5 : 1) });
  }
  return hits.sort((a, b) => b.rank - a.rank).slice(0, 10);
}
// Screen position of the caret, so the list opens where you're typing (mirror-div technique for textareas).
function caretXY(f) {
  const r = f.getBoundingClientRect();
  if (f.tagName !== "TEXTAREA") return { x: r.left + 8, y: r.bottom + 2 };
  const cs = getComputedStyle(f), m = document.createElement("div"), s = document.createElement("span");
  for (const p of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "padding", "border", "boxSizing", "width", "tabSize"]) m.style[p] = cs[p];
  Object.assign(m.style, { position: "fixed", top: "0", left: "0", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word" });
  m.textContent = f.value.slice(0, f.selectionStart); s.textContent = "​"; m.append(s);
  document.body.append(m);
  const x = r.left + s.offsetLeft - f.scrollLeft, y = r.top + s.offsetTop + s.offsetHeight - f.scrollTop;
  m.remove();
  return { x: Math.min(x, r.right - 40), y: Math.min(y + 2, r.bottom) };
}
function acRender() {
  acBox.innerHTML = "";
  acItems.forEach((t, i) => acBox.append(el("div", { class: `acitem ${t.cat}${i === acSel ? " on" : ""}`, title: `${t.cat} · ${t.count.toLocaleString()} posts${t.sites ? " · " + t.sites.replace(/,/g, ", ") : ""}`,
      onmousedown: (ev) => { ev.preventDefault(); acAccept(i); } },   // mousedown + preventDefault keeps focus in the field
    el("span", { class: "n", text: t.name }), t.alias ? el("span", { class: "al", text: "← " + t.alias }) : null, el("small", { text: shortCount(t.count) }))));
}
// The Adult and Story workspaces also get every booru's tags (booru_tags.sqlite, see boorutags.py), asked from the
// server per keystroke and merged in; General keeps the Danbooru list only. Tags rule34.xxx has rank ahead of the
// rest with up to RULE34_BOOST times their posts (same as boorutags.RULE34_BOOST), Danbooru tags it also has included.
const RULE34_BOOST = 3;
let acSeq = 0;
function acUpdate(f) {
  const tok = acToken(f), seq = ++acSeq;
  acItems = tok ? acMatch(tok.q.trim()) : [];
  acShow(f, tok);
  if (!tok || mode === "general") return;
  api("/lora-lab/booru-tags?q=" + encodeURIComponent(tok.q.trim())).then(rows => {
    if (seq !== acSeq || document.activeElement !== f) return;
    const boost = (t) => (t.sites || "").split(",").includes("rule34.xxx") ? RULE34_BOOST : 1;
    const server = new Map(rows.filter(t => !REF_BLOCK.has(t.name)).map(t => [t.name, t]));
    const local = acItems.map(t => server.has(t.name) ? { ...t, sites: server.get(t.name).sites, rank: t.rank * boost(server.get(t.name)) } : t);
    const have = new Set(local.map(t => t.name));
    const more = [...server.values()].filter(t => !have.has(t.name))
      .map(t => ({ name: t.name, cat: AC_CATS[t.cat] || "general", count: t.count, sites: t.sites, alias: t.alias, rank: t.count * (t.alias ? 1 : 5) * boost(t) }));
    if (!more.length && local.every((t, i) => t === acItems[i])) return;
    acItems = [...local, ...more].sort((a, b) => b.rank - a.rank).slice(0, 10);
    acShow(f, tok);
  }).catch(() => {});
}
function acShow(f, tok) {
  if (!acItems.length || (acItems.length === 1 && acItems[0].name === tok.q.trim())) return acClose();
  acField = f; acSel = 0;
  if (!acBox) { acBox = el("div", { class: "acbox" }); document.body.append(acBox); }
  acRender();
  const p = caretXY(f);
  acBox.style.display = "block";
  acBox.style.left = Math.max(8, Math.min(p.x, innerWidth - acBox.offsetWidth - 8)) + "px";
  acBox.style.top = (p.y + acBox.offsetHeight > innerHeight - 8 ? p.y - acBox.offsetHeight - 22 : p.y) + "px";
}
function acClose() { if (acBox) acBox.style.display = "none"; acItems = []; acField = null; }
function acAccept(i) {
  const it = acItems[i], f = acField, tok = f && acToken(f);
  if (!it || !tok) return acClose();
  const v = f.value;
  let after = v.slice(tok.end);
  after = after.slice(after.match(/^[^,\n():]*/)[0].length);   // replace the rest of the word too, keep weights like ":1.2)"
  const ins = f.id === "tfTag" ? it.name : it.name + (/^\s*[,):]/.test(after) ? "" : ", ");
  f.value = v.slice(0, tok.start) + ins + after;
  f.setSelectionRange(tok.start + ins.length, tok.start + ins.length);
  acClose();
  f.dispatchEvent(new Event("input", { bubbles: true }));
}
document.addEventListener("input", async (ev) => {
  const f = ev.target;
  if (!ev.isTrusted || !f.matches || !f.matches(AC_FIELDS)) return;
  if (!acTags) { await loadAcTags(); if (document.activeElement !== f) return; }
  acUpdate(f);
});
// Capture phase, so Enter/Tab pick a suggestion before the field's own Enter handler (e.g. TagFinder search) runs.
document.addEventListener("keydown", (ev) => {
  if (!acField || ev.target !== acField) return;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { acSel = (acSel + (ev.key === "ArrowDown" ? 1 : -1) + acItems.length) % acItems.length; acRender(); }
  else if ((ev.key === "Enter" && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) || ev.key === "Tab") acAccept(acSel);
  else if (ev.key === "Escape") acClose();
  else return;
  ev.preventDefault(); ev.stopImmediatePropagation();
}, true);
document.addEventListener("focusout", (ev) => { if (ev.target === acField) acClose(); });
document.addEventListener("scroll", (ev) => { if (acField && ev.target !== acBox) acClose(); }, true);

// ---------- characters ----------
// Stored on the ComfyUI machine (shared by every device). The active character's tags go before the prompt,
// their LoRAs are stacked under every column's LoRA, and their reference image can replace the panel's.
let chars = [], charsLoaded = false, editId = store.get("charEdit", null), lastCharField = null, tab = store.get("tab", "results");
const charSaveTimers = {};
// Each workspace only sees its own characters (characters made before workspaces existed are Adult).
const wsChars = () => chars.filter(c => mode === "story" || (c.workspace || "adult") === mode);   // Story uses everyone
const activeChar = () => wsChars().find(c => c.id === S.charId) || null;
const editChar = () => wsChars().find(c => c.id === editId) || null;
const imgKey = (im) => `${im.subfolder || ""}/${im.filename}`;
function charRefOn() { const ch = activeChar(); return !!(ch && S.charUse.ref && ch.ref); }
const inputUrl = (r) => `/view?filename=${encodeURIComponent(r.name)}&subfolder=${encodeURIComponent(r.subfolder || "")}&type=input`;
function charThumb(c) {
  if (c.ref) return inputUrl(c.ref);
  const imgs = c.images || [];
  return imgs.length ? thumbUrl(imgs[imgs.length - 1].image, 256) : "icon-192.png";
}
const charRouteError = (err, what) => ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable characters." : `${what}: ${err.message}`;

function showTab(t) {
  if (tab === "chat" && t !== "chat") leaveChat();   // learn from what was said
  tab = ["chars", "3d", "train", "images", "info", "game", "novel", "chat", "manga", "workflow", "share"].includes(t) || (t === "story" && mode === "story") ? t : "results"; store.set("tab", tab);
  document.body.dataset.tab = tab;
  for (const b of document.querySelectorAll("button[data-tab]")) b.classList.toggle("on", b.dataset.tab === tab);
  $("moreBtn").classList.toggle("on", !!$("moreMenu").querySelector(".on"));
  document.body.classList.toggle("nopanel", ["novel", "images", "info", "train", "3d", "chars", "share"].includes(tab));   // tabs that never draw with the panel's settings
  $("tabResults").style.display = tab === "results" ? "" : "none";
  $("tabStory").style.display = tab === "story" ? "" : "none";
  $("tabGame").style.display = tab === "game" ? "" : "none";
  $("tabNovel").style.display = tab === "novel" ? "" : "none";
  $("tabChat").style.display = tab === "chat" ? "" : "none";
  $("tabManga").style.display = tab === "manga" ? "" : "none";
  $("tabImages").style.display = tab === "images" ? "" : "none";
  $("tabInfo").style.display = tab === "info" ? "" : "none";
  $("tabChars").style.display = tab === "chars" ? "" : "none";
  $("tab3d").style.display = tab === "3d" ? "" : "none";
  $("tabTrain").style.display = tab === "train" ? "" : "none";
  $("tabWorkflow").style.display = tab === "workflow" ? "" : "none";
  $("tabShare").style.display = tab === "share" ? "" : "none";
  if (tab === "workflow") enterWorkflowTab();
  if (tab === "share") return loadShare();
  if (tab === "story") return renderStoryTab();
  if (tab === "game") return renderGameTab();
  if (tab === "novel") return renderNovelTab();
  if (tab === "chat") return renderChatTab();
  if (tab === "manga") return renderMangaTab();
  if (tab === "images") return loadImages();
  if (tab === "info") return;
  if (tab === "3d") return render3d();
  if (tab === "train") return renderTrain();
  if (tab === "chars") renderChars();
  $(tab === "chars" ? "libSlotChars" : "libSlotCreate").append($("libCard"));
  renderLibrary();
}
$("tabs").addEventListener("click", (ev) => { const b = ev.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); });

// Share Files: one folder on the PC running Kōbō; any device that opens Kōbō can upload to it and download from it.
const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
async function loadShare() {
  let r;
  try { r = await api("/lora-lab/share"); }
  catch (err) { $("shList").replaceChildren(); $("shFolder").textContent = ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable Share Files." : `Couldn't list the files: ${err.message}`; return; }
  $("shFolder").textContent = `${r.files.length} file${r.files.length === 1 ? "" : "s"} · saved on the PC running Kōbō in ${r.folder}`;
  $("shList").replaceChildren(...r.files.map(f => {
    const row = document.createElement("div"); row.className = "shrow";
    const a = document.createElement("a"); a.href = `/lora-lab/share/file?name=${encodeURIComponent(f.name)}`; a.download = f.name; a.textContent = f.name; a.title = "Download";
    const meta = document.createElement("span"); meta.className = "hint"; meta.textContent = `${fmtBytes(f.size)} · ${new Date(f.mtime * 1000).toLocaleString()}`;
    const del = document.createElement("button"); del.className = "btn sm"; del.textContent = "Delete";
    del.onclick = async () => {
      if (!confirm(`Delete ${f.name} from the PC running Kōbō?`)) return;
      try { await post("/lora-lab/share/delete", { name: f.name }); } catch (err) { toast(`Couldn't delete: ${err.message}`); }
      loadShare();
    };
    row.append(a, meta, del);
    return row;
  }));
}
let shBusy = false;
function shareUpload(files) {
  if (!files.length) return;
  if (shBusy) return toast("Wait for the current upload to finish.");
  const fd = new FormData();
  for (const f of files) fd.append("file", f, f.name);
  const xhr = new XMLHttpRequest();   // not fetch: XHR reports upload progress, which matters for big files over Wi-Fi
  xhr.open("POST", "/lora-lab/share/upload");
  xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) $("shDropText").textContent = `Uploading ${files.length} file${files.length === 1 ? "" : "s"}… ${Math.round(ev.loaded / ev.total * 100)}%`; };
  xhr.onloadend = () => {
    shBusy = false; $("shDropText").textContent = "Drop files here, or click to choose them.";
    if (xhr.status === 200) toast(`Uploaded ${files.length} file${files.length === 1 ? "" : "s"}`, true);
    else toast(xhr.status === 404 ? "Restart Kōbō once to enable Share Files." : `Upload failed${xhr.status ? ` (${xhr.status})` : ": connection lost"}`);
    loadShare();
  };
  shBusy = true; xhr.send(fd);
}
$("shDrop").onclick = () => $("shFile").click();
$("shDrop").onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); $("shFile").click(); } };
$("shFile").onchange = () => { shareUpload([...$("shFile").files]); $("shFile").value = ""; };
for (const t of ["dragenter", "dragover"]) $("shDrop").addEventListener(t, (ev) => { ev.preventDefault(); $("shDrop").classList.add("over"); });
for (const t of ["dragleave", "drop"]) $("shDrop").addEventListener(t, (ev) => { ev.preventDefault(); $("shDrop").classList.remove("over"); });
$("shDrop").addEventListener("drop", (ev) => shareUpload([...ev.dataTransfer.files]));

// ⋯ More (bottom-left): the tabs used less often.
function setMoreMenu(open) { $("moreMenu").hidden = !open; $("moreBtn").setAttribute("aria-expanded", String(open)); }
$("moreBtn").onclick = () => setMoreMenu($("moreMenu").hidden);
$("moreMenu").addEventListener("click", (ev) => { const b = ev.target.closest("[data-tab]"); if (b) { showTab(b.dataset.tab); setMoreMenu(false); } });
document.addEventListener("click", (ev) => { if (!ev.target.closest("#moreMenu, #moreBtn")) setMoreMenu(false); });
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !$("moreMenu").hidden) { setMoreMenu(false); $("moreBtn").focus(); } });

// ---------- 🔍 image info: how a picture was made ----------
// The server (imageinfo.py) reads what the app left in the file; this shows it, says which models and LoRAs are installed
// here, and can load it all into Image Generation. 🏷 Find tags runs the image tagger for pictures with nothing in them.
let info = null, infoSrc = null;   // infoSrc: the dropped File, or { filename, subfolder, type } of an image ComfyUI has
const fileKey = (n) => stem(n).toLowerCase().replace(/[\s_.-]+/g, "");
const localFile = (name, pool) => { const k = fileKey((name || "").replace(/\s*\([^)]*\)$/, "")); return k ? pool.find(n => fileKey(n) === k) || null : null; };
const modelPool = () => [...lists.checkpoints, ...lists.diffusion_models, ...lists.unet, ...lists.unet_gguf];
const FILE_POOLS = { "VAE": () => lists.vae, "Text encoder": () => [...lists.text_encoders, ...lists.clip_gguf],
  "ControlNet": () => lists.controlnet, "Upscaler": () => lists.upscale, "Hires upscaler": () => lists.upscale };
function engineOf(model) {
  if (lists.checkpoints.includes(model)) return ckptFamily[model] === "sd15" ? "sd15" : "sdxl";
  if (/klein/i.test(model)) return "klein";
  if (/z[-_]?image/i.test(model)) return "zimage";
  return isAnimaModel(model) ? "anima" : null;
}

async function loadInfo(src) {
  infoSrc = src; info = null;
  const fd = new FormData();
  if (src instanceof Blob) { fd.append("image", src, src.name || "image.png"); $("iiImg").src = URL.createObjectURL(src); }
  else { for (const k of ["filename", "subfolder", "type"]) fd.append(k, src[k] || ""); $("iiImg").src = imgUrl(src); }
  $("iiDrop").classList.add("has"); $("iiDropText").textContent = "Drop another picture, or click";
  $("iiOut").replaceChildren(el("div", { class: "hint", text: "Reading…" }));
  try { info = await api("/lora-lab/imageinfo", { method: "POST", body: fd }); }
  catch (err) {
    return $("iiOut").replaceChildren(el("div", { class: "hint", text: ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable Image info." : "Couldn't read it: " + err.message }));
  }
  renderInfo();
}

function renderInfo() {
  const sec = (title, ...kids) => [el("div", { class: "subh", text: title }), ...kids.flat()];
  const have = (f) => el("span", { class: "iihave" + (f ? " ok" : ""), text: f ? "✓ you have it" : "not installed", title: f || "Not in your models folders" });
  const copy = (text, label) => el("button", { class: "btn sm", text: label || "Copy", onclick: async () => (await copyText(text)) ? toast("Copied", true) : toast("Couldn't copy") });
  const box = (t) => el("div", { class: "iitext", text: t });
  const out = [];
  out.push(...sec("Made with", el("div", { class: "iibig", text: info.software.join(" · ") || "Unknown: no generation info in the file" }),
    info.edited.length ? el("div", { class: "hint", text: "Saved again in " + info.edited.join(", ") }) : null,
    el("div", { class: "hint", text: `${info.file.format} · ${info.file.size}` })));
  if (info.apply && info.apply.prompt) out.push(el("div", { class: "iibar", style: "margin-top:10px" },
    el("button", { class: "btn primary", text: "Use these settings", title: "Load the prompt, model, LoRAs and settings into Image Generation", onclick: applyInfo }),
    info.apply.converted ? el("span", { class: "hint", text: info.apply.converted }) : null));
  if (info.models.length) out.push(...sec("Model", info.models.map(m => el("div", { class: "iirow" },
    el("b", { text: m.name || "(name not saved)" }), el("span", { class: "hint", text: [m.kind, m.hash && "hash " + m.hash, m.loader].filter(Boolean).join(" · ") }),
    el("span", { class: "grow" }), /online/.test(m.kind) ? null : have(localFile(m.name, modelPool()))))));
  out.push(...sec("LoRAs", info.loras.length ? info.loras.map(l => el("div", { class: "iirow" },
    el("b", { text: l.name }), el("span", { class: "hint", text: "strength " + l.strength }), el("span", { class: "grow" }), have(localFile(l.name, lists.loras))))
    : el("div", { class: "hint", text: info.found ? "None used." : "Unknown." })));
  if (info.prompt) out.push(...sec("Prompt", box(info.prompt), el("div", { class: "iibar" }, copy(info.prompt))));
  if (info.characters.length) out.push(...sec(info.software.some(s => /ComfyUI/.test(s)) ? "Text boxes" : "Character prompts", info.characters.map(box)));
  if (info.negative) out.push(...sec("Negative prompt", box(info.negative), el("div", { class: "iibar" }, copy(info.negative))));
  const kv = Object.entries(info.settings);
  if (kv.length) out.push(...sec("Settings", el("dl", { class: "iikv" }, kv.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: String(v) })]))));
  if (info.files.length) out.push(...sec("Other files it used", info.files.map(f => el("div", { class: "iirow" },
    el("span", { class: "hint", text: f.kind }), el("b", { text: f.name }), el("span", { class: "grow" }), FILE_POOLS[f.kind] ? have(localFile(f.name, FILE_POOLS[f.kind]())) : null))));
  if (info.notes.length) out.push(...sec("Notes", info.notes.map(n => el("div", { class: "hint", style: "margin-bottom:4px", text: "• " + n }))));
  const t = info.tags, tagNames = (list) => (list || []).filter(([, s]) => s >= 0.35).map(([n]) => n.replace(/_/g, " "));
  if (t) {
    const groups = [["Character", tagNames(t.character)], ["Style looks like (a guess)", (t.artist || []).map(([n]) => n.replace(/_/g, " "))], ["Tags", tagNames(t.general)]];
    const all = joinTags([...groups[0][1], ...groups[2][1]]);
    out.push(...sec("What the tagger sees", groups.filter(([, l]) => l.length).map(([h, l]) => el("div", {},
      el("div", { class: "hint", text: h }), el("div", { class: "iitags" }, l.map(n => el("span", { class: "tag", text: n }))))),
      el("div", { class: "iibar" }, copy(all, "Copy tags"),
        el("button", { class: "btn sm", text: "Use as prompt", onclick: () => { S.prompt = all; save(); renderSettings(); showTab("results"); toast("Tags loaded as the prompt", true); } }))));
    if (t.text && t.text.length) out.push(...sec("Text in the picture", box(t.text.join("\n")), el("div", { class: "iibar" }, copy(t.text.join("\n")))));
  } else out.push(el("div", { class: "iibar", style: "margin-top:14px" },
    el("button", { class: "btn", text: "Find tags", title: "Run the image tagger on the picture itself (works on any picture)", onclick: (ev) => infoTags(ev.currentTarget) })));
  out.push(el("details", { style: "margin-top:14px" }, el("summary", { class: "hint", text: "Everything stored in the file" }),
    el("pre", { class: "iitext", text: JSON.stringify(info.raw, null, 1) })));
  $("iiOut").replaceChildren(...out.filter(Boolean));
}

async function infoTags(btn) {
  btn.disabled = true; btn.textContent = "Reading the picture…";
  try {
    const blob = infoSrc instanceof Blob ? infoSrc : await (await fetch(imgUrl(infoSrc))).blob();
    const fd = new FormData();
    fd.append("image", blob, "image.png"); fd.append("models", tagModelsParam()); fd.append("rule34", mode === "adult" ? "1" : ""); fd.append("text", "1");
    info.tags = await api("/lora-lab/tag", { method: "POST", body: fd });
    renderInfo();
  } catch (err) { toast("Tagging failed: " + err.message); btn.disabled = false; btn.textContent = "Find tags"; }
}

function applyInfo() {
  const a = info.apply, model = info.models.map(m => localFile(m.name, modelPool())).find(Boolean), eng = model && engineOf(model);
  if (eng) { S.engine = eng; setModel(E(), model); }
  const e = E();
  if (a.settings) {
    if (a.steps) e.steps = Number(a.steps);
    if (a.cfg) e.cfg = Number(a.cfg);
    if (lists.samplers.includes(a.sampler)) e.sampler = a.sampler;
    if (lists.schedulers.includes(a.scheduler)) e.scheduler = a.scheduler;
    if (a.seed != null && Number.isFinite(Number(a.seed))) S.seed = Number(a.seed);
  }
  S.prompt = a.prompt;
  if (a.negative) e.negative = a.negative;
  if (a.width && a.height) {
    Object.assign(S, { w: Number(a.width), h: Number(a.height) });
    S.size = [...$("size").options].some(o => o.value === `${S.w}x${S.h}`) ? `${S.w}x${S.h}` : "custom";
  }
  const missing = [];
  for (const n of lists.loras) loraState(n).on = false;
  for (const l of info.loras) {
    const f = localFile(l.name, lists.loras);
    if (f) Object.assign(loraState(f), { on: true, strength: Number(l.strength) || 1 }); else missing.push(l.name);
  }
  if (info.loras.length > missing.length) E().noLora = false;
  if (info.loras.length - missing.length > 1) S.loraMix = true;
  save(); renderSettings(); showTab("results");
  const where = model ? `on ${stem(model)}` : `on ${ENGINE_LABEL[S.engine]} (the model it used isn't installed)`;
  toast(`Settings loaded ${where}` + (missing.length ? `\nLoRAs not installed: ${missing.join(", ")}` : ""), !missing.length && !!model);
}

$("iiDrop").onclick = () => $("iiFile").click();
$("iiDrop").onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); $("iiFile").click(); } };
$("iiFile").onchange = () => { if ($("iiFile").files[0]) loadInfo($("iiFile").files[0]); $("iiFile").value = ""; };
for (const t of ["dragenter", "dragover"]) $("iiDrop").addEventListener(t, (ev) => { ev.preventDefault(); $("iiDrop").classList.add("over"); });
for (const t of ["dragleave", "drop"]) $("iiDrop").addEventListener(t, (ev) => { ev.preventDefault(); $("iiDrop").classList.remove("over"); });
$("iiDrop").addEventListener("drop", async (ev) => {
  const f = ev.dataTransfer.files[0];
  if (f) return loadInfo(f);
  const url = ev.dataTransfer.getData("text/uri-list") || ev.dataTransfer.getData("text/plain");
  if (!url) return;
  try { const b = await (await fetch(url)).blob(); loadInfo(new File([b], "image.png", { type: b.type })); }
  catch { toast("Couldn't read that image — save it and drop the file instead."); }
});

// ---------- train a LoRA ----------
// Datasets live in input/lora-training/<name> on the ComfyUI machine. The server builds the training graph (settings
// measured on this GPU), checks every image with the tagger first and writes the finished LoRA's training metadata.
const TRAIN_SPEED = { sd15: 1.2, sdxl: 5.3, anima: 4.8 };   // seconds per step measured on this 6 GB GPU (Anima at 768 px)
const TRAIN_KINDS = {
  character: { per: 100, rank: "16", hint: "Hair and eye tags are left out of the captions, so the trigger word learns the face and hair. Everything that changes (pose, clothes, background) stays tagged." },
  outfit: { per: 100, rank: "16", hint: "Tip: after captioning, use “Remove from all” on the tags that describe the outfit itself, so the trigger word learns it." },
  style: { per: 120, rank: "32", hint: "Every tag is kept; the trigger word stands for the style. Use many different subjects drawn in that style." },
};
// What a character never changes: hair colour/length/style and eye colour. Expressions like "closed eyes" stay.
const HAIR_KEEP = new Set(["wet hair", "messy hair", "hand in own hair", "holding hair", "adjusting hair", "floating hair", "hair down", "hair up", "tucking hair"]);
const isTrait = (t) => (/ hair$/.test(t) && !HAIR_KEEP.has(t)) || /(^| )bangs$|^(sidelocks|ahoge|hair between eyes|hair intakes|heterochromia)$/.test(t)
  || /^(aqua|black|blue|brown|green|grey|orange|pink|purple|red|white|yellow|golden) eyes$/.test(t);
let datasets = [], dsCur = null, trJobs = [], trJobsTimer = null, dsBusy = false;
const trProgress = {}, dsCapTimers = {};
const dsUrl = (file) => `/view?filename=${encodeURIComponent(file)}&subfolder=${encodeURIComponent("lora-training/" + dsCur.name)}&type=input`;
const fmtDur = (s) => s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
const trainError = (err) => ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable training." : err.message;

function renderTrain() { loadDatasets(); loadTrainJobs(); }
async function loadDatasets() {
  try { datasets = await api(`/lora-lab/train/datasets?workspace=${mode}`); }
  catch (err) { datasets = []; $("dsEmpty").textContent = trainError(err); }
  renderDsList();
  const want = (dsCur && dsCur.name) || store.get("dsCur." + mode, null);
  if (want && datasets.some(d => d.name === want)) openDataset(want); else { dsCur = null; renderDataset(); }
}
function renderDsList() {
  const box = $("dsList"); box.innerHTML = "";
  for (const d of datasets) {
    box.append(el("div", { class: "charitem" + (dsCur && dsCur.name === d.name ? " on" : ""), onclick: () => openDataset(d.name) },
      el("img", { src: d.thumb ? `/view?filename=${encodeURIComponent(d.thumb)}&subfolder=${encodeURIComponent("lora-training/" + d.name)}&type=input` : "icon-192.png", alt: "" }),
      el("div", { style: "min-width:0" }, el("b", { text: d.name }), el("div", { class: "hint", style: "margin:0", text: `${d.count} image${d.count === 1 ? "" : "s"}${d.trigger ? " · " + d.trigger : ""}` }))));
  }
  if (!datasets.length) box.append(el("div", { class: "hint", text: "No datasets in this workspace yet." }));
}
async function openDataset(name) {
  try { dsCur = await api(`/lora-lab/train/dataset?name=${encodeURIComponent(name)}`); }
  catch (err) { return toast(trainError(err)); }
  store.set("dsCur." + mode, name);
  renderDsList(); renderDataset();
}
function dsKind() { return store.get(`dsKind.${mode}.${dsCur.name}`, "character"); }

function renderDataset() {
  $("dsEmpty").style.display = dsCur ? "none" : "";
  $("dsForm").style.display = dsCur ? "" : "none";
  if (!dsCur) return;
  const n = dsCur.images.length, captioned = dsCur.images.filter(i => i.caption).length, flagged = dsCur.images.filter(i => i.child).length;
  $("dsTitle").textContent = dsCur.name;
  $("dsCount").textContent = `${n} image${n === 1 ? "" : "s"} · ${captioned} captioned${flagged ? ` · ${flagged} can't be used` : ""}`;
  $("dsTrigger").value = dsCur.trigger;
  $("dsKind").value = dsKind();
  $("dsKindHint").textContent = TRAIN_KINDS[dsKind()].hint;
  $("dsThr").value = store.get("dsThr", 0.35); $("dsThrV").textContent = Number($("dsThr").value).toFixed(2);
  const grid = $("dsGrid"); grid.innerHTML = "";
  dsCur.images.forEach((im, idx) => {
    const ta = el("textarea", { rows: "3", placeholder: "trigger, 1girl, …", oninput: (ev) => saveDsCaption(im, ev.target.value) });
    ta.value = im.caption;
    grid.append(el("div", { class: "dscard" + (im.child ? " child" : "") },
      el("img", { src: dsUrl(im.file), loading: "lazy", alt: im.file,
        onclick: () => openLbItems(dsCur.images.map(x => ({ src: dsUrl(x.file), page: dsUrl(x.file), label: `${dsCur.name} · ${x.file}` })), idx) }),
      im.child ? el("div", { class: "warn", text: "Looks like a child — remove it" }) : null,
      el("button", { class: "x", text: "✕", title: "Remove this image from the dataset", onclick: () => deleteDsImage(im) }),
      ta));
  });
  renderTrainer();
}
function saveDsCaption(im, text) {
  im.caption = text;
  clearTimeout(dsCapTimers[im.file]);
  const name = dsCur.name;
  dsCapTimers[im.file] = setTimeout(async () => {
    delete dsCapTimers[im.file];
    try { await post("/lora-lab/train/caption", { name, file: im.file, caption: text }); }
    catch (err) { toast("Couldn't save the caption: " + trainError(err)); }
  }, 500);
}
async function setDsCaptions(fn) {   // fn(tags) -> new tags; saves the captions that changed
  for (const im of dsCur.images) {
    const before = splitTags(im.caption), after = fn(before);
    if (after.join(", ") === before.join(", ")) continue;
    im.caption = after.join(", ");
    await post("/lora-lab/train/caption", { name: dsCur.name, file: im.file, caption: im.caption });
  }
  renderDataset();
}
async function deleteDsImage(im) {
  if (!confirm(`Remove ${im.file} and its caption from "${dsCur.name}"? The file is deleted.`)) return;
  try { await post("/lora-lab/train/image/delete", { name: dsCur.name, file: im.file }); }
  catch (err) { return toast(trainError(err)); }
  dsCur.images = dsCur.images.filter(x => x !== im);
  renderDataset(); loadDatasets();
}
async function dsUpload(files) {
  if (!dsCur) return toast("Create or pick a dataset first");
  files = [...files].filter(f => /^image\//.test(f.type));
  const name = dsCur.name;
  for (let i = 0; i < files.length; i++) {
    $("dsStatus").textContent = `Adding image ${i + 1} of ${files.length}…`;
    const fd = new FormData(); fd.append("name", name); fd.append("image", files[i], files[i].name);
    try { await api("/lora-lab/train/image", { method: "POST", body: fd }); }
    catch (err) { toast(`${files[i].name}: ${trainError(err)}`); }
  }
  $("dsStatus").textContent = files.length ? `Added ${files.length} image${files.length > 1 ? "s" : ""}. Press ✨ Auto-caption next.` : "";
  await openDataset(name); loadDatasets();
}
// Tagger captions: trigger word first; for a character, hair and eye tags are left out (see isTrait).
async function captionImages(name, images, trigger, kind, threshold, progress) {
  let i = 0;
  for (const im of images) {
    progress(++i, images.length);
    const r = await post("/lora-lab/train/autotag", { name, file: im.file, threshold });
    im.child = r.child;
    im.caption = joinTags([trigger, ...(kind === "character" ? r.tags.filter(t => !isTrait(t)) : r.tags)]);
    await post("/lora-lab/train/caption", { name, file: im.file, caption: im.caption });
  }
}
async function autoCaption() {
  if (dsBusy || !dsCur) return;
  const todo = dsCur.images.filter(im => $("dsOverwrite").checked || !im.caption);
  if (!todo.length) return toast("Every image already has a caption — tick “Replace existing captions” to redo them.", true);
  dsBusy = true; $("dsAuto").disabled = true;
  try {
    await captionImages(dsCur.name, todo, $("dsTrigger").value.trim(), dsKind(), Number($("dsThr").value),
      (i, n) => $("dsStatus").textContent = `Captioning ${i} of ${n}… (the first image also loads the tagger)`);
    const flagged = dsCur.images.filter(i => i.child).length;
    $("dsStatus").textContent = `Captioned ${todo.length} image${todo.length > 1 ? "s" : ""}.${flagged ? ` ${flagged} look like a child and must be removed before training.` : " Check the captions, then train."}`;
  } catch (err) { $("dsStatus").textContent = "Auto-caption stopped: " + trainError(err); }
  finally { dsBusy = false; $("dsAuto").disabled = false; renderDataset(); }
}

// Anima has no all-in-one checkpoint: training uses the text encoder and VAE picked for Anima in the Model tab.
function animaTrainFiles() {
  const e = S.eng.anima || {};
  return { te: e.te || lists.text_encoders.find(n => /qwen_3_06b/i.test(n)), vae: e.avae || lists.vae.find(n => /qwen_image/i.test(n)) };
}
function renderTrainer() {
  const fam = store.get("trFamily", ["sd15", "anima"].includes(S.engine) ? S.engine : "sdxl");
  $("trFamily").value = fam;
  const ckpts = fam === "anima" ? lists.diffusion_models.filter(isAnimaModel)
    : lists.checkpoints.filter(n => !is3dCheckpoint(n) && (fam === "sd15" ? ckptFamily[n] === "sd15" : ckptFamily[n] === "sdxl"));
  fillSelect($("trCkpt"), ckpts, store.get("trCkpt." + fam, null));
  const key = `trSet.${mode}.${dsCur.name}`, set = store.get(key, {}), kind = TRAIN_KINDS[dsKind()], n = dsCur.images.length;
  $("trName").value = set.name || dsCur.name.replace(/[^A-Za-z0-9_-]+/g, "_");
  $("trSteps").value = set.steps || Math.round(Math.min(fam === "sd15" ? 3000 : 2500, Math.max(800, n * kind.per)) / 100) * 100;
  $("trRank").value = set.rank || kind.rank;
  $("trLr").value = set.lr || "0.0001";
  updateTrainEstimate();
}
function updateTrainEstimate() {
  const fam = $("trFamily").value, steps = Number($("trSteps").value) || 0, n = dsCur ? dsCur.images.length : 0;
  const files = fam === "anima" ? animaTrainFiles() : null;
  $("trEstimate").textContent = `${n} images · ${steps} steps · about ${fmtDur(steps * TRAIN_SPEED[fam] + 90)} on this GPU · saved as ${fam}_${$("trName").value || "lora"}`
    + (files ? ` · with ${stem(files.te || "no text encoder")} and ${stem(files.vae || "no VAE")}` : "");
}
function saveTrainSet(field, value) {
  const key = `trSet.${mode}.${dsCur.name}`;
  store.set(key, Object.assign(store.get(key, {}), { [field]: value }));
  updateTrainEstimate();
}
async function startTraining() {
  if (!dsCur) return;
  const missing = dsCur.images.filter(i => !i.caption).length;
  if (dsCur.images.length < 5) return toast("Add at least 5 images (15–40 works best).");
  if (missing && !confirm(`${missing} image${missing > 1 ? "s have" : " has"} no caption and will be trained with an empty one. Start anyway?`)) return;
  if (!$("dsTrigger").value.trim() && !confirm("There's no trigger word, so nothing in your prompt will switch the LoRA on specifically. Start anyway?")) return;
  const fam = $("trFamily").value, files = fam === "anima" ? animaTrainFiles() : {};
  if (!$("trCkpt").value) return toast(fam === "anima" ? "No Anima model found in models/diffusion_models." : "No checkpoint of this type found in models/checkpoints.");
  if (fam === "anima" && !(files.te && files.vae)) return toast("Anima needs its text encoder (qwen_3_06b) in models/text_encoders and the Qwen-Image VAE in models/vae.");
  $("trGo").disabled = true; $("trEstimate").textContent = "Checking every image with the tagger…";
  try {
    const r = await post("/lora-lab/train/prepare", { dataset: dsCur.name, family: fam, checkpoint: $("trCkpt").value, text_encoder: files.te, vae: files.vae,
      lora_name: $("trName").value, steps: Number($("trSteps").value), rank: Number($("trRank").value), learning_rate: Number($("trLr").value) });
    let res;
    try { res = await post("/prompt", { prompt: r.graph, client_id: clientId }); }
    catch (err) { throw new Error(nodeErrorText(err.body) || err.message); }
    await post("/lora-lab/train/jobs", { pid: res.prompt_id, job: r.job, workspace: mode });
    toast(`Training "${r.job.name}" started — follow it under Training runs`, true);
    loadTrainJobs();
  } catch (err) {
    toast("Couldn't start training: " + trainError(err));
    openDataset(dsCur.name);   // shows any images the check flagged
  } finally { $("trGo").disabled = false; updateTrainEstimate(); }
}

async function loadTrainJobs() {
  let jobs;
  try { jobs = await api(`/lora-lab/train/jobs?workspace=${mode}`); } catch { return; }
  const newlyDone = jobs.some(j => j.status === "done" && !trJobs.some(o => o.pid === j.pid && o.status === "done"));
  trJobs = jobs;
  if (newlyDone) { await loadLoras(); renderLoras(); }
  // "Learn this character" runs attach their LoRA on the server; tell the user once per run.
  const told = store.get("learnTold", []), learned = jobs.filter(j => j.status === "done" && j.attached && !told.includes(j.pid));
  if (learned.length) {
    store.set("learnTold", [...told, ...learned.map(j => j.pid)].slice(-50));
    await loadChars();
    toast(`🎓 ${learned.map(j => j.name.replace(/_learned$/, "")).join(", ")} learned: the new LoRA is now part of the character.`, true);
  }
  renderJobs();
  clearTimeout(trJobsTimer);
  if (trJobs.some(j => j.status === "running")) trJobsTimer = setTimeout(loadTrainJobs, 20000);
}
function renderJobs() {
  const box = $("trJobs"); box.innerHTML = "";
  for (const j of [...trJobs].reverse()) {
    const p = trProgress[j.pid] || {}, kids = [el("b", { text: `${j.name} · ${ENGINE_LABEL[j.family]}`, title: j.file || j.name })];
    if (j.status === "running") {
      let text = "Waiting in the queue…", frac = 0;
      if (p.node === "6" && p.max) {
        frac = p.value / p.max;
        const rate = p.value > p.v0 ? (Date.now() - p.t0) / 1000 / (p.value - p.v0) : TRAIN_SPEED[j.family];
        text = `Step ${p.value} / ${p.max} · about ${fmtDur((p.max - p.value) * rate)} left`;
      } else if (p.node) text = "Preparing the images…";
      kids.push(el("div", { class: "pbar" }, el("div", { style: `width:${frac * 100}%` })), el("div", { class: "hint", style: "margin:0", text }),
        el("div", { class: "acts" }, el("button", { class: "btn sm danger", text: "Cancel", onclick: () => cancelTraining(j) })));
    } else if (j.status === "done") {
      kids.push(el("div", { class: "hint", style: "margin:0", text: `✓ ${j.images} images · ${j.steps} steps${j.trigger ? " · trigger: " + j.trigger : ""}` }),
        el("div", { class: "acts" },
          el("button", { class: "btn sm primary", text: "Try it", title: "Tick this LoRA and open Image Generation", onclick: () => tryTrained(j) }),
          j.loss_graph ? el("button", { class: "btn sm", text: "Loss graph", onclick: () => openLbItems([{ src: imgUrl(j.loss_graph), page: imgUrl(j.loss_graph), label: "Training loss — it should drop and then level off" }], 0) }) : null));
    } else kids.push(el("div", { class: "hint", style: "margin:0;color:var(--err)", text: j.error || "Failed" }));
    box.append(el("div", { class: "trjob" + (j.status === "error" ? " error" : "") }, kids));
  }
  if (!trJobs.length) box.append(el("div", { class: "hint", text: "Nothing trained here yet." }));
}
function onTrainMessage(type, d) {
  const j = trJobs.find(x => x.pid === d.prompt_id && x.status === "running");
  if (!j) return;
  if (type === "progress") {
    const p = trProgress[j.pid] || (trProgress[j.pid] = {});
    if (d.node === "6" && p.node !== "6") { p.t0 = Date.now(); p.v0 = d.value; }
    Object.assign(p, { node: d.node, value: d.value, max: d.max });
    renderJobs();
  } else if (type === "executing" && d.node) { (trProgress[j.pid] || (trProgress[j.pid] = {})).node = d.node; renderJobs(); }
  else if (type === "execution_success" || type === "execution_error" || type === "execution_interrupted") setTimeout(loadTrainJobs, 1500);
}
async function cancelTraining(j) {
  if (!confirm(`Stop training "${j.name}"? Nothing is saved.`)) return;
  try {
    if (runningId === j.pid) await post("/interrupt", { prompt_id: j.pid }); else await post("/queue", { delete: [j.pid] });
  } catch (err) { return toast("Cancel failed: " + err.message); }
  setTimeout(loadTrainJobs, 1500);
}
async function tryTrained(j) {
  await loadLoras();
  const n = lists.loras.find(x => stem(x) === stem(j.file));
  if (!n) return toast("The new LoRA isn't in the list yet — press ↻ in the LoRA panel.");
  if (!loraAllowed(n)) return toast("Its captions mark this LoRA as adult; use it in the Adult 18+ workspace.");
  S.engine = j.family;
  if (modelList().includes(j.checkpoint)) setModel(E(), j.checkpoint);
  const st = loraState(n); st.on = true; E().noLora = false;
  if (j.trigger && !st.triggers) st.triggers = j.trigger;
  save(); renderSettings(); renderLoras(); showPane("model"); showTab("results");
  toast(`${stem(n)} is ticked${j.trigger ? ` (trigger "${j.trigger}" is added)` : ""} — write a prompt and press Generate`, true);
}

$("dsNew").onclick = async () => {
  const name = $("dsNewName").value.trim().replace(/\s+/g, " ");
  if (!name) return $("dsNewName").focus();
  try { dsCur = await post("/lora-lab/train/dataset", { name, workspace: mode }); }
  catch (err) { return toast(trainError(err)); }
  $("dsNewName").value = ""; store.set("dsCur." + mode, name);
  await loadDatasets(); $("dsTrigger").focus();
};
$("dsNewName").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); $("dsNew").click(); } });
$("dsTrigger").addEventListener("change", async () => {
  const old = dsCur.trigger, t = $("dsTrigger").value.trim();
  try { dsCur.trigger = (await post("/lora-lab/train/trigger", { name: dsCur.name, trigger: t })).trigger; }
  catch (err) { return toast(trainError(err)); }
  // Keep the trigger as the first tag of every caption.
  await setDsCaptions((tags) => !tags.length ? tags : [...(dsCur.trigger ? [dsCur.trigger] : []), ...tags.filter(x => x !== old && x !== dsCur.trigger)]);
  loadDatasets();
});
$("dsDrop").onclick = () => $("dsFiles").click();
$("dsFiles").onchange = () => { dsUpload($("dsFiles").files); $("dsFiles").value = ""; };
for (const t of ["dragenter", "dragover"]) $("dsDrop").addEventListener(t, (ev) => { ev.preventDefault(); $("dsDrop").classList.add("over"); });
$("dsDrop").addEventListener("dragleave", () => $("dsDrop").classList.remove("over"));
$("dsDrop").addEventListener("drop", (ev) => { ev.preventDefault(); $("dsDrop").classList.remove("over"); dsUpload(ev.dataTransfer.files); });
$("dsKind").onchange = () => { store.set(`dsKind.${mode}.${dsCur.name}`, $("dsKind").value); store.set(`trSet.${mode}.${dsCur.name}`, {}); renderDataset(); };
$("dsThr").addEventListener("input", () => { store.set("dsThr", Number($("dsThr").value)); $("dsThrV").textContent = Number($("dsThr").value).toFixed(2); });
$("dsAuto").onclick = autoCaption;
$("dsBulkAdd").onclick = () => {
  const t = $("dsBulk").value.trim(); if (!t) return;
  setDsCaptions((tags) => tags.some(x => normTag(x) === normTag(t)) ? tags : (tags[0] === dsCur.trigger ? [tags[0], t, ...tags.slice(1)] : [t, ...tags]));
};
$("dsBulkDel").onclick = () => { const t = $("dsBulk").value.trim(); if (t) setDsCaptions((tags) => tags.filter(x => normTag(x) !== normTag(t))); };
$("trFamily").onchange = () => { store.set("trFamily", $("trFamily").value); saveTrainSet("steps", null); renderTrainer(); };
$("trCkpt").onchange = () => store.set("trCkpt." + $("trFamily").value, $("trCkpt").value);
$("trName").addEventListener("input", () => saveTrainSet("name", $("trName").value));
$("trSteps").addEventListener("input", () => saveTrainSet("steps", Number($("trSteps").value)));
$("trRank").onchange = () => saveTrainSet("rank", $("trRank").value);
$("trLr").onchange = () => saveTrainSet("lr", $("trLr").value);
$("trGo").onclick = startTraining;

// ---------- learn this character ----------
// The character's gallery (minus unticked images) becomes dataset "char <name>", captioned so the trigger word learns
// the character but not their clothes, and trains an Illustrious/SDXL or Anima LoRA. When it's done the server adds the LoRA
// and trigger to the character, so a plain Generate (with the new-look option) gives them any outfit and pose.
let learnOff = new Set();
const learnTrigger = (c) => c.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "character";
const learnImages = (c) => galleryImages(c).filter(x => !learnOff.has(imgKey(x.image)));
const learnModels = () => ({ sdxl: lists.checkpoints.filter(n => !is3dCheckpoint(n) && ckptFamily[n] === "sdxl"),
  anima: lists.diffusion_models.filter(isAnimaModel) });
const learnFamily = () => learnModels().anima.includes($("learnCkpt").value) ? "anima" : "sdxl";
function openLearn() {
  const c = editChar(); if (!c) return;
  learnOff = new Set(store.get(`learnOff.${c.id}`, []));
  // Default: the model most of their gallery was made with, else one that fits the type they're made for.
  const m = learnModels(), all = [...m.sdxl, ...m.anima], used = {};
  for (const x of galleryImages(c)) if (all.includes(x.model)) used[x.model] = (used[x.model] || 0) + 1;
  fillSelect($("learnCkpt"), all, Object.keys(used).sort((a, b) => used[b] - used[a])[0]
    || (c.engine === "anima" ? m.anima[0] : m.sdxl.find(n => /illustrious/i.test(n))));
  $("learnSwitch").checked = c.engine !== learnFamily();
  delete $("learnSteps").dataset.touched;
  $("learnStatus").textContent = "";
  $("learnBox").style.display = "";
  renderLearn();
  $("learnBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function renderLearn() {
  const c = editChar(); if (!c || $("learnBox").style.display === "none") return;
  const all = galleryImages(c), grid = $("learnGrid"), n = learnImages(c).length;
  grid.innerHTML = "";
  for (const x of all) {
    const key = imgKey(x.image), on = !learnOff.has(key);
    grid.append(el("label", { class: "learncard" + (on ? "" : " off"), title: on ? "Used for learning — click to leave it out" : "Left out — click to use it" },
      el("input", Object.assign({ type: "checkbox", onchange: () => {
        if (learnOff.has(key)) learnOff.delete(key); else learnOff.add(key);
        store.set(`learnOff.${c.id}`, [...learnOff]); renderLearn(); } }, on ? { checked: "" } : {})),
      el("img", { src: thumbUrl(x.image, 256), loading: "lazy", alt: "" })));
  }
  if (!$("learnSteps").dataset.touched) $("learnSteps").value = Math.min(2000, Math.max(1200, Math.round(n * 50 / 100) * 100));
  $("learnInfo").textContent = `${n} of ${all.length} images will be used${n < 30 ? " (30 or more works best)" : ""}. Captions name the clothes, pose and place `
    + `but not the hair and eyes, so the trigger word "${learnTrigger(c)}" learns ${c.name}'s look and any outfit still works afterwards.`;
  const fam = learnFamily();
  $("learnSwitchLbl").textContent = `Use ${fam === "anima" ? "Anima" : "Illustrious / Pony"} for them afterwards`;
  $("learnEstimate").textContent = `${$("learnSteps").value} steps · about ${fmtDur(Number($("learnSteps").value) * TRAIN_SPEED[fam] + 120)} on this GPU — fine to leave running overnight`;
}
async function startLearn() {
  const c = editChar(); if (!c) return;
  const imgs = learnImages(c);
  if (imgs.length < 10) return toast("Keep at least 10 images ticked (30 or more works best).");
  if (!$("learnCkpt").value) return toast("No Illustrious / Pony checkpoint (models/checkpoints) or Anima model (models/diffusion_models) found.");
  const fam = learnFamily(), files = fam === "anima" ? animaTrainFiles() : {};
  if (fam === "anima" && !(files.te && files.vae)) return toast("Anima needs its text encoder (qwen_3_06b) in models/text_encoders and the Qwen-Image VAE in models/vae.");
  const btn = $("learnGo"), st = $("learnStatus");
  btn.disabled = true;
  try {
    st.textContent = "Copying the images into a training set…";
    const ds = await post("/lora-lab/train/from-character", { id: c.id, workspace: mode, images: imgs.map(x => x.image) });
    await captionImages(ds.name, ds.images.filter(im => !im.caption), ds.trigger, "character", 0.35,
      (i, n) => st.textContent = `Captioning ${i} of ${n}… (the first image also loads the tagger)`);
    const flagged = ds.images.filter(im => im.child);
    if (flagged.length) {   // untick them in the grid so the next try works
      for (const im of flagged) if (im.source) learnOff.add(im.source);
      store.set(`learnOff.${c.id}`, [...learnOff]); renderLearn();
      throw new Error(`${flagged.length} image(s) look like a child and can't be used for training; they're now unticked. Press Start again.`);
    }
    st.textContent = "Checking every image and starting…";
    const steps = Number($("learnSteps").value);
    const r = await post("/lora-lab/train/prepare", { dataset: ds.name, family: fam, checkpoint: $("learnCkpt").value, text_encoder: files.te, vae: files.vae,
      lora_name: `${learnTrigger(c)}_learned`, steps, rank: 16, learning_rate: 0.0001 });
    let res;
    try { res = await post("/prompt", { prompt: r.graph, client_id: clientId }); }
    catch (err) { throw new Error(nodeErrorText(err.body) || err.message); }
    await post("/lora-lab/train/jobs", { pid: res.prompt_id, job: r.job, workspace: mode, character_id: c.id, switch_engine: $("learnSwitch").checked });
    st.textContent = `Learning started (about ${fmtDur(steps * TRAIN_SPEED[fam] + 120)}). When it finishes, the LoRA and "${ds.trigger}" are added to ${c.name} by themselves. Progress: Train LoRA → Training runs.`;
    loadTrainJobs();
  } catch (err) { st.textContent = "Couldn't start: " + trainError(err); }
  finally { btn.disabled = false; }
}
$("charLearn").onclick = openLearn;
$("learnClose").onclick = () => $("learnBox").style.display = "none";
$("learnAll").onclick = () => { const c = editChar(); learnOff = new Set(); if (c) store.set(`learnOff.${c.id}`, []); renderLearn(); };
$("learnSteps").addEventListener("input", () => { $("learnSteps").dataset.touched = "1"; renderLearn(); });
$("learnGo").onclick = startLearn;
$("learnCkpt").addEventListener("change", () => { const c = editChar(); if (c) $("learnSwitch").checked = c.engine !== learnFamily(); renderLearn(); });

// ---------- image -> 3D (ComfyUI's built-in Hunyuan3D nodes) ----------
// The checkpoint lives in models/checkpoints (we use a 3d/ subfolder) and is loaded with ImageOnlyCheckpointLoader.
function is3dCheckpoint(n) { return /hunyuan.?3d/i.test(n || "") || /^3d[\\/]/i.test(n || ""); }
// Based on ComfyUI's official Hunyuan3D 2.0 / 2.1 templates (2.0's note recommends CFG 4–8).
const M3_DEFAULTS = {
  v20: { steps: 20, cfg: 6, latent: 3072, crop: "none" },
  v21: { steps: 30, cfg: 5, latent: 4096, crop: "center" },
  mv: { steps: 30, cfg: 5, latent: 4096, crop: "center" },
};
const m3Kind = (n) => /mv/i.test(stem(n)) ? "mv" : /2[._]?1/.test(stem(n)) ? "v21" : "v20";
const M3_NODE_LABEL = { "10": "Removing background", "20": "Loading 3D model", "30": "Shaping", "31": "Building mesh", "32": "Building mesh",
  "40": "Cleaning up", "41": "Reducing faces", "42": "Unwrapping", "43": "Painting colours", "44": "Smoothing", "33": "Saving" };
// Side and back views: Hunyuan's multi-view "left" image looks at the subject's own left side.
const M3_VIEWS = ["left", "back", "right"];
const M3_VIEW_LABEL = { left: "Left side", back: "Back", right: "Right side" };
const M3_VIEW_PROMPT = {
  left: "Show the same subject turned 90 degrees, seen exactly from its left side: a full side profile facing the left edge of the image.",
  back: "Show the same subject turned around, seen from directly behind: we see its back, not its face.",
  right: "Show the same subject turned 90 degrees, seen exactly from its right side: a full side profile facing the right edge of the image.",
};
const M3_VIEW_TAIL = " Keep everything else identical: same character or object, same hair, outfit, colours, art style, proportions and pose, "
  + "whole subject in frame from top to bottom, plain white background, no shadow.";
const m3 = Object.assign({ model: "auto", detail: "256", steps: null, cfg: null, seed: rand(), autoSeed: true, cut: true, srcs: {},
  views: {}, autoViews: true, paint: true, clean: true, faces: 0 }, store.get("m3", {}));
if (m3.small) { m3.faces = 100000; delete m3.small; }   // the old "Smaller file" box
if (!m3.autoModel) { m3.model = "auto"; m3.autoModel = true; }   // one-time: older pages saved a fixed model
// The source image belongs to the workspace it was picked in.
const src3d = () => m3.srcs[mode] || null;
let m3models = store.get("m3models", []), m3job = null, m3current = null, mvLoading = null;
const save3d = () => { store.set("m3", m3); store.set("m3models", m3models.slice(-60)); };
const m3Models = () => lists.checkpoints.filter(is3dCheckpoint);
const views3d = () => (m3.views[mode] ||= {});
// "auto": the multi-view model when there are side/back views, else 2.1, else 2.0.
function m3ModelFor(nViews, choice = m3.model) {
  const ms = m3Models();
  if (choice !== "auto" && ms.includes(choice)) return choice;
  const kind = (k) => ms.find(n => m3Kind(n) === k);
  return (nViews && kind("mv")) || kind("v21") || kind("v20") || ms[0] || "";
}
const m3NodesReady = () => lists.asaMesh;
const m3PaintReady = () => m3NodesReady() && lists.bgRemoval.length > 0;
function kleinFor3d() {
  const m = [...new Set([...lists.unet_gguf, ...lists.unet])].filter(n => /klein/i.test(n)).sort((a, b) => /9b/i.test(b) - /9b/i.test(a))[0];
  const vae = lists.vae.find(n => /flux2/i.test(n));
  return m && vae ? { model: m, te: kleinTE(m), vae } : null;
}
const viewUrl = (f) => `/view?filename=${encodeURIComponent(f.filename || f.name)}&subfolder=${encodeURIComponent(f.subfolder || "")}&type=${f.type || "output"}`;

// <model-viewer> (Google's glTF viewer) is loaded only once the 3D tab is opened.
function loadViewer() {
  if (customElements.get("model-viewer")) return Promise.resolve(true);
  if (!mvLoading) mvLoading = new Promise((res) => {
    const s = document.createElement("script");
    s.type = "module"; s.src = "https://cdn.jsdelivr.net/npm/@google/model-viewer@4/dist/model-viewer.min.js";
    s.onload = () => customElements.whenDefined("model-viewer").then(() => res(true));
    s.onerror = () => { mvLoading = null; res(false); };
    document.head.append(s);
  });
  return mvLoading;
}

function render3d() {
  const models = m3Models();
  if (m3.model !== "auto" && !models.includes(m3.model)) m3.model = "auto";
  const nViews = Object.keys(views3d()).length;
  fillSelect($("m3Model"), models.length ? ["auto", ...models] : [], m3.model,
    (n) => n === "auto" ? `Auto (now: ${stem(m3ModelFor(nViews, "auto"))})` : stem(n));
  if (!models.length) $("m3Model").append(el("option", { value: "", text: "No Hunyuan3D model in models/checkpoints" }));
  const d = M3_DEFAULTS[m3Kind(m3ModelFor(nViews))];
  $("m3Detail").value = m3.detail;
  $("m3Steps").value = m3.steps ?? d.steps;
  $("m3Cfg").value = m3.cfg ?? d.cfg;
  $("m3Seed").value = m3.seed;
  $("m3AutoSeed").checked = m3.autoSeed;
  $("m3Cut").checked = m3.cut && lists.bgRemoval.length > 0;
  $("m3Cut").disabled = !lists.bgRemoval.length;
  $("m3Paint").checked = m3.paint && m3PaintReady(); $("m3Paint").disabled = !m3PaintReady();
  $("m3Clean").checked = m3.clean && m3NodesReady(); $("m3Clean").disabled = !m3NodesReady();
  $("m3Faces").value = m3.faces || ""; $("m3Faces").disabled = !m3NodesReady();
  const k = kleinFor3d();
  $("m3AutoViews").checked = m3.autoViews && !!k; $("m3AutoViews").disabled = !k;
  $("m3MakeViews").disabled = !k || !src3d() || !!m3job;
  $("m3ViewsHint").textContent = k ? `with ${stem(k.model)}, about 2 min each` : "Drawing them needs a Klein model; you can still drop your own.";
  render3dSource();
  render3dViews();
  render3dList();
  if (!m3job) $("m3Status").textContent = !models.length ? "Download a Hunyuan3D checkpoint first (see the Guide)."
    : !m3NodesReady() ? "Restart Kōbō (↻) to turn on colours and clean-up." : src3d() ? "" : "Pick an image first.";
  $("m3Go").disabled = !!m3job;
  if (m3current && (m3current.workspace || "general") !== mode) clear3dView();
  if (m3current) show3d(m3current); else loadViewer();
}
function render3dSource() {
  const src = src3d();
  $("m3Drop").classList.toggle("has", !!src);
  $("m3Img").src = src ? viewUrl(src) : "";
  $("m3DropText").innerHTML = src ? "Drop or paste another image to replace"
    : "Drop an image of one object or character, paste (Ctrl+V), or click.<br>Or open any result and press 🧊 Make 3D.";
}
// A new source image starts without side views (they showed the old subject), unless they come with it.
function set3dSource(src, views = {}) { m3.srcs[mode] = src; m3.views[mode] = { ...views }; save3d(); if (tab === "3d") render3d(); }
async function upload3dImage(file, prefix) {
  const ext = ((/\.(png|jpe?g|webp|bmp|gif)$/i.exec(file.name || "") || [".png"])[0]).toLowerCase();
  const fd = new FormData();
  fd.append("image", file, `${prefix}_${Date.now()}${ext}`);
  fd.append("type", "input"); fd.append("subfolder", "lora-lab"); fd.append("overwrite", "true");
  try {
    const r = await api("/upload/image", { method: "POST", body: fd });
    return { name: r.name, subfolder: r.subfolder || "", type: "input" };
  } catch (err) { toast("Couldn't upload the image: " + err.message); return null; }
}
async function upload3dSource(file) { const src = await upload3dImage(file, "3d"); if (src) set3dSource(src); }
async function upload3dView(view, file) {
  const src = await upload3dImage(file, "3d_" + view);
  if (!src) return;
  views3d()[view] = src; save3d(); if (tab === "3d") render3d();
}
let m3ViewTarget = null;
function render3dViews() {
  const box = $("m3Views"); box.innerHTML = "";
  const vs = views3d();
  for (const v of M3_VIEWS) {
    const slot = el("div", { class: "m3slot", tabindex: "0", title: `${M3_VIEW_LABEL[v]}: drop, paste or click to pick a picture` },
      vs[v] ? el("img", { src: viewUrl(vs[v]), alt: "" }) : el("span", { text: `${M3_VIEW_LABEL[v]}\ndrop or click` }),
      vs[v] ? el("div", { class: "lbl", text: M3_VIEW_LABEL[v] }) : null,
      vs[v] ? el("button", { class: "x", text: "×", title: "Remove this view", onclick: (ev) => { ev.stopPropagation(); delete views3d()[v]; save3d(); render3d(); } }) : null);
    slot.style.whiteSpace = "pre-line";
    slot.onclick = () => { m3ViewTarget = v; $("m3ViewFile").click(); };
    for (const t of ["dragenter", "dragover"]) slot.addEventListener(t, (ev) => { ev.preventDefault(); ev.stopPropagation(); slot.classList.add("over"); });
    for (const t of ["dragleave", "drop"]) slot.addEventListener(t, (ev) => { ev.preventDefault(); ev.stopPropagation(); slot.classList.remove("over"); });
    slot.addEventListener("drop", (ev) => { const f = ev.dataTransfer.files[0]; if (f) upload3dView(v, f); });
    box.append(slot);
  }
}
function urlSize(url) {
  return new Promise((res) => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => res(null); i.src = url; });
}

// Hunyuan3D wants one centred object on white. Pad the image to a square with a margin (so CLIP vision
// doesn't stretch or crop it), optionally cutting the background out with BiRefNet first.
// views: [{ view, src, size }] for the side/back pictures; with the multi-view model they shape the mesh too,
// with any model they help paint it.
function build3dGraph(src, size, seed, model, views = []) {
  const kind = m3Kind(model), d = M3_DEFAULTS[kind];
  const paint = m3.paint && m3PaintReady(), needMask = (m3.cut || paint) && lists.bgRemoval.length > 0;
  const load = (s) => `${s.subfolder ? s.subfolder + "/" : ""}${s.name} [${s.type === "input" ? "input" : "output"}]`;
  // Picture -> centred on a white square with a margin (optionally cut out) -> CLIP vision.
  const prep = (g, s, sz, base, maskRef) => {
    const side = Math.round(Math.max(sz.w, sz.h) * 1.15), [sq, comp, enc] = [base + 1, base + 2, base + 3].map(String);
    g[sq] = { class_type: "EmptyImage", inputs: { width: side, height: side, batch_size: 1, color: 0xFFFFFF } };
    g[comp] = { class_type: "ImageCompositeMasked", inputs: { destination: [sq, 0], source: [String(base), 0], x: Math.round((side - sz.w) / 2), y: Math.round((side - sz.h) / 2), resize_source: false } };
    if (m3.cut && maskRef) g[comp].inputs.mask = maskRef;
    g[enc] = { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["20", 1], image: [comp, 0], crop: d.crop } };
    return [enc, 0];
  };
  const g = {
    "1": { class_type: "LoadImage", inputs: { image: load(src) } },
    "20": { class_type: "ImageOnlyCheckpointLoader", inputs: { ckpt_name: model } },
    "23": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["20", 0], shift: 1.0 } },
    "24": { class_type: "EmptyLatentHunyuan3Dv2", inputs: { resolution: d.latent, batch_size: 1 } },
    "30": { class_type: "KSampler", inputs: { model: ["23", 0], positive: ["22", 0], negative: ["22", 1], latent_image: ["24", 0], seed,
      steps: Number($("m3Steps").value) || d.steps, cfg: Number($("m3Cfg").value) || d.cfg, sampler_name: "euler", scheduler: "normal", denoise: 1 } },
    "31": { class_type: "VAEDecodeHunyuan3D", inputs: { samples: ["30", 0], vae: ["20", 2], num_chunks: 8000, octree_resolution: Number(m3.detail) } },
    "32": { class_type: "VoxelToMesh", inputs: { voxel: ["31", 0], algorithm: "surface net", threshold: 0.6 } },
  };
  if (needMask) {
    g["10"] = { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: lists.bgRemoval.find(n => /birefnet/i.test(n)) || lists.bgRemoval[0] } };
    g["11"] = { class_type: "RemoveBackground", inputs: { bg_removal_model: ["10", 0], image: ["1", 0] } };
  }
  const clip = { front: prep(g, src, size, 1, needMask ? ["11", 0] : null) }, pics = {};
  views.forEach((v, i) => {
    const base = 100 + i * 10, mask = String(base + 5);
    g[String(base)] = { class_type: "LoadImage", inputs: { image: load(v.src) } };
    if (needMask) {
      g[mask] = { class_type: "RemoveBackground", inputs: { bg_removal_model: ["10", 0], image: [String(base), 0] } };
      pics[v.view] = [String(base), 0]; pics[v.view + "_mask"] = [mask, 0];
    }
    if (kind === "mv") clip[v.view] = prep(g, v.src, v.size, base, needMask ? [mask, 0] : null);
  });
  g["22"] = kind === "mv"
    ? { class_type: "Hunyuan3Dv2ConditioningMultiView", inputs: clip }
    : { class_type: "Hunyuan3Dv2Conditioning", inputs: { clip_vision_output: clip.front } };
  // Faces empty = keep every face: decimating tears thin cloth (capes, skirts) on Hunyuan meshes.
  const faces = m3NodesReady() ? m3.faces || 0 : 0;
  let mesh = ["32", 0];
  if (m3NodesReady() && (m3.clean || faces)) {
    g["40"] = { class_type: "ASALabMeshCleanup", inputs: { mesh, min_part: m3.clean ? 0.01 : 0, smooth_iters: 0, target_faces: 0 } };
    mesh = ["40", 0];
  }
  const dense = mesh;
  if (faces) {
    g["41"] = { class_type: "ASALabMeshCleanup", inputs: { mesh, min_part: 0, smooth_iters: 0, target_faces: faces } };
    mesh = ["41", 0];
    if (paint && faces <= 150000) {   // too few vertices to hold the colours: put them in a texture
      g["42"] = { class_type: "UnwrapMesh", inputs: { mesh, segmenter: "pec", resolution: 2048, padding: 2, weld_distance: 0 } };
      mesh = ["42", 0];
    }
  }
  if (paint) {
    g["43"] = { class_type: "ASALabTextureFromViews", inputs: { mesh, front: ["1", 0], front_mask: ["11", 0], resolution: 2048, front_weight: 2.0, reference_mesh: dense, ...pics } };
    mesh = ["43", 0];
  }
  if (m3NodesReady() && (paint || m3.clean)) {
    g["44"] = { class_type: "MeshSmoothNormals", inputs: { mesh, crease_angle: 180.0 } };
    mesh = ["44", 0];
  }
  g["33"] = { class_type: "SaveGLB", inputs: { mesh, filename_prefix: "LoRA-Lab/3d/" + safe(src.name) } };
  return g;
}

// Klein redraws the subject from the side(s) and back; one prompt, shared model loaders.
function buildViewsGraph(src, size, missing, seed) {
  const k = kleinFor3d(), px = 0.8e6, a = size.w / size.h;
  const W = Math.round(Math.sqrt(px * a) / 16) * 16, H = Math.round(Math.sqrt(px / a) / 16) * 16;
  const g = {
    "1": /\.gguf$/i.test(k.model) ? { class_type: "UnetLoaderGGUF", inputs: { unet_name: k.model } }
      : { class_type: "UNETLoader", inputs: { unet_name: k.model, weight_dtype: "default" } },
    "3": { class_type: "CLIPLoaderGGUF", inputs: { clip_name: k.te, type: "flux2" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: k.vae } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "blurry, low quality, deformed, extra limbs, front view, text, watermark", clip: ["3", 0] } },
    "20": { class_type: "LoadImage", inputs: { image: `${src.subfolder ? src.subfolder + "/" : ""}${src.name} [${src.type === "input" ? "input" : "output"}]` } },
    "21": { class_type: "ImageScaleToTotalPixels", inputs: { image: ["20", 0], upscale_method: "lanczos", megapixels: 1.0, resolution_steps: 16 } },
    "22": { class_type: "VAEEncode", inputs: { pixels: ["21", 0], vae: ["4", 0] } },
    "24": { class_type: "ReferenceLatent", inputs: { conditioning: ["6", 0], latent: ["22", 0] } },
    "7": { class_type: "EmptyFlux2LatentImage", inputs: { width: W, height: H, batch_size: 1 } },
    "11": { class_type: "Flux2Scheduler", inputs: { steps: 4, width: W, height: H } },
    "13": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  };
  const saves = {};
  missing.forEach((v, i) => {
    const [pos, ref, guide, noise, samp, dec, save] = [0, 1, 2, 3, 4, 5, 6].map(j => String(200 + i * 10 + j));
    g[pos] = { class_type: "CLIPTextEncode", inputs: { text: M3_VIEW_PROMPT[v] + M3_VIEW_TAIL, clip: ["3", 0] } };
    g[ref] = { class_type: "ReferenceLatent", inputs: { conditioning: [pos, 0], latent: ["22", 0] } };
    g[guide] = { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: [ref, 0], negative: ["24", 0], cfg: 1.0 } };
    g[noise] = { class_type: "RandomNoise", inputs: { noise_seed: seed + i } };
    g[samp] = { class_type: "SamplerCustomAdvanced", inputs: { noise: [noise, 0], guider: [guide, 0], sampler: ["13", 0], sigmas: ["11", 0], latent_image: ["7", 0] } };
    g[dec] = { class_type: "VAEDecode", inputs: { samples: [samp, 0], vae: ["4", 0] } };
    g[save] = { class_type: "SaveImage", inputs: { filename_prefix: `LoRA-Lab/3d/views/${safe(src.name)}_${v}`, images: [dec, 0] } };
    saves[save] = v;
  });
  return { graph: g, saves, size: { w: W, h: H } };
}
async function make3dViews(missing) {
  const src = src3d();
  const size = await urlSize(viewUrl(src));
  if (!size) throw new Error("Couldn't read the source image — pick it again.");
  const { graph, saves, size: out } = buildViewsGraph(src, size, missing, rand());
  $("m3Status").textContent = `Drawing ${missing.map(v => M3_VIEW_LABEL[v].toLowerCase()).join(", ")}…`;
  const res = await post("/prompt", { prompt: graph, client_id: clientId });
  m3job = { pid: res.prompt_id, views: missing.length, done: 0 };
  render3d();
  for (let i = 0; i < 1200; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const h = await api("/history/" + encodeURIComponent(res.prompt_id)).catch(() => null);
    const entry = h && h[res.prompt_id]; if (!entry) continue;
    const m = ((entry.status || {}).messages || []).find(x => x[0] === "execution_error");
    if (m) throw new Error(m[1].exception_message);
    if (!(entry.status && entry.status.completed)) continue;
    const vs = views3d();
    for (const [id, v] of Object.entries(saves)) {
      const f = ((entry.outputs[id] || {}).images || [])[0];
      if (f) vs[v] = { name: f.filename, subfolder: f.subfolder || "", type: f.type || "output", size: out };
    }
    save3d();
    return;
  }
  throw new Error("Timed out");
}

async function drawViews() {
  if (m3job || !src3d() || !kleinFor3d()) return;
  const missing = M3_VIEWS.filter(v => !views3d()[v]);
  if (!missing.length) return toast("All three views are there. Remove one (×) to draw it again.");
  $("m3Go").disabled = true; $("m3Bar").style.width = "0";
  try { await make3dViews(missing); toast("Side and back views ready", true); }
  catch (err) { toast("Drawing the views failed: " + (err.body ? nodeErrorText(err.body) : err.message)); }
  finally { m3job = null; $("m3Go").disabled = false; $("m3Bar").style.width = "0"; if (tab === "3d") render3d(); }
}

async function make3d() {
  if (m3job) return;
  if (!m3Models().length) return toast("No Hunyuan3D model found in models/checkpoints.");
  const src = src3d();
  if (!src) return toast("Pick an image first.");
  const size = await urlSize(viewUrl(src));
  if (!size) return toast("Couldn't read the source image — pick it again.");
  if (m3.autoSeed) { m3.seed = rand(); $("m3Seed").value = m3.seed; }
  const seed = Number($("m3Seed").value) || 0;
  m3.seed = seed; save3d();
  $("m3Go").disabled = true; $("m3Bar").style.width = "0";
  $("m3Status").textContent = "Queued…";
  try {
    const missing = M3_VIEWS.filter(v => !views3d()[v]);
    if (m3.autoViews && kleinFor3d() && missing.length) {
      await make3dViews(missing);
      m3job = null; $("m3Bar").style.width = "0";
    }
    const views = [];
    for (const v of M3_VIEWS) {
      const s = views3d()[v];
      if (!s) continue;
      const sz = s.size || await urlSize(viewUrl(s));
      if (sz) views.push({ view: v, src: s, size: sz });
    }
    const model = m3ModelFor(views.length);
    const res = await post("/prompt", { prompt: build3dGraph(src, size, seed, model, views), client_id: clientId });
    m3job = { pid: res.prompt_id };
    const file = await waitFor3d(res.prompt_id);
    const item = { id: Date.now(), file, src, views: { ...views3d() }, seed, model, detail: m3.detail, workspace: mode };
    m3models.push(item); save3d();
    $("m3Status").textContent = "Done — saved in output/LoRA-Lab/3d";
    if (tab === "3d") { show3d(item); render3dList(); }
    toast("3D model ready", true);
  } catch (err) {
    $("m3Status").textContent = "";
    toast("3D failed: " + (err.body ? nodeErrorText(err.body) : err.message));
  } finally {
    m3job = null; $("m3Go").disabled = false; $("m3Bar").style.width = "0";
    $("m3MakeViews").disabled = !kleinFor3d() || !src3d();
    if (tab === "3d") render3dViews();
  }
}
function on3dMessage(type, d) {
  if (m3job.views) {   // Klein drawing the side/back views: samplers are nodes 204, 214, 224
    if (type === "executing" && /^2\d4$/.test(String(d.node))) $("m3Status").textContent = `Drawing view ${Math.floor((Number(d.node) - 200) / 10) + 1} of ${m3job.views}…`;
    else if (type === "progress" && d.max) $("m3Bar").style.width = (d.value / d.max * 100) + "%";
    return;
  }
  if (type === "executing" && d.node != null && M3_NODE_LABEL[d.node]) $("m3Status").textContent = M3_NODE_LABEL[d.node] + "…";
  else if (type === "execution_cached" ) $("m3Status").textContent = "Starting…";
  else if (type === "progress" && d.max) {
    $("m3Bar").style.width = (d.value / d.max * 100) + "%";
    if (d.node === "30") $("m3Status").textContent = `Shaping… ${d.value}/${d.max}`;
  }
}
async function waitFor3d(pid) {
  for (let i = 0; i < 1200; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const h = await api("/history/" + encodeURIComponent(pid)).catch(() => null);
    const entry = h && h[pid]; if (!entry) continue;
    for (const out of Object.values(entry.outputs || {})) for (const f of out["3d"] || []) return f;
    const m = ((entry.status || {}).messages || []).find(x => x[0] === "execution_error");
    if (m) throw new Error(m[1].exception_message);
    if (entry.status && entry.status.completed) throw new Error("No 3D model was produced");
  }
  throw new Error("Timed out");
}

async function show3d(item) {
  m3current = item;
  $("m3Empty").style.display = "none";
  const url = viewUrl(item.file);
  $("m3Links").innerHTML = "";
  $("m3Links").append(el("a", { href: url, download: item.file.filename, text: "⬇ Download .glb" }),
    el("a", { href: "#", text: "Use source image", onclick: (ev) => { ev.preventDefault(); set3dSource(item.src, item.views); } }));
  for (const n of document.querySelectorAll(".m3item")) n.classList.toggle("on", n.dataset.id === String(item.id));
  if (!(await loadViewer())) {
    $("m3Stage").innerHTML = "";
    $("m3Empty").style.display = ""; $("m3Empty").textContent = "The 3D viewer needs an internet connection the first time. You can still download the .glb below and open it in Windows 3D Viewer or Blender.";
    return;
  }
  let mv = $("m3Stage").querySelector("model-viewer");
  if (!mv) {
    mv = el("model-viewer", { "camera-controls": "", "auto-rotate": "", "shadow-intensity": "1", exposure: "1.1", "interaction-prompt": "none", style: "width:100%;height:100%" });
    $("m3Stage").append(mv);
  }
  mv.src = url;
}
function clear3dView() {
  m3current = null; $("m3Stage").innerHTML = ""; $("m3Links").innerHTML = "";
  $("m3Empty").style.display = ""; $("m3Empty").innerHTML = "Your 3D model appears here.<br>Drag to rotate, scroll to zoom, right-drag to pan.";
}
function render3dList() {
  const list = $("m3List"); list.innerHTML = "";
  const mine = m3models.filter(x => (x.workspace || "general") === mode).reverse();
  if (!mine.length) return list.append(el("div", { class: "hint", text: "Nothing yet." }));
  for (const it of mine) {
    list.append(el("div", { class: "m3item" + (m3current && m3current.id === it.id ? " on" : ""), "data-id": String(it.id), title: `${stem(it.model)} · seed ${it.seed}`, onclick: () => show3d(it) },
      el("img", { src: thumbUrl(it.src), loading: "lazy", alt: "" }),
      el("button", { class: "x", text: "×", title: "Remove from this list (the file stays in the output folder)", onclick: (ev) => {
        ev.stopPropagation(); m3models = m3models.filter(x => x.id !== it.id); save3d();
        if (m3current && m3current.id === it.id) clear3dView();
        render3dList();
      } })));
  }
}

$("m3Drop").onclick = () => $("m3File").click();
$("m3Drop").onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); $("m3File").click(); } };
$("m3File").onchange = () => { if ($("m3File").files[0]) upload3dSource($("m3File").files[0]); $("m3File").value = ""; };
for (const t of ["dragenter", "dragover"]) $("m3Drop").addEventListener(t, (ev) => { ev.preventDefault(); $("m3Drop").classList.add("over"); });
for (const t of ["dragleave", "drop"]) $("m3Drop").addEventListener(t, (ev) => { ev.preventDefault(); $("m3Drop").classList.remove("over"); });
$("m3Drop").addEventListener("drop", async (ev) => {
  const f = ev.dataTransfer.files[0];
  if (f) return upload3dSource(f);
  const url = ev.dataTransfer.getData("text/uri-list") || ev.dataTransfer.getData("text/plain");
  if (!url) return;
  try { const b = await (await fetch(url)).blob(); upload3dSource(new File([b], "source.png", { type: b.type })); }
  catch { toast("Couldn't read that image — save it and drop the file instead."); }
});
$("m3Model").onchange = () => { m3.model = $("m3Model").value; m3.steps = m3.cfg = null; save3d(); render3d(); };
$("m3Detail").onchange = () => { m3.detail = $("m3Detail").value; save3d(); };
$("m3Steps").onchange = () => { m3.steps = Number($("m3Steps").value) || null; save3d(); };
$("m3Cfg").onchange = () => { m3.cfg = Number($("m3Cfg").value) || null; save3d(); };
$("m3Seed").onchange = () => { m3.seed = Number($("m3Seed").value) || 0; save3d(); };
$("m3AutoSeed").onchange = () => { m3.autoSeed = $("m3AutoSeed").checked; save3d(); };
$("m3Cut").onchange = () => { m3.cut = $("m3Cut").checked; save3d(); };
$("m3Paint").onchange = () => { m3.paint = $("m3Paint").checked; save3d(); };
$("m3Clean").onchange = () => { m3.clean = $("m3Clean").checked; save3d(); };
$("m3Faces").onchange = () => { m3.faces = Math.max(0, Math.round(Number($("m3Faces").value) || 0)); $("m3Faces").value = m3.faces || ""; save3d(); };
$("m3AutoViews").onchange = () => { m3.autoViews = $("m3AutoViews").checked; save3d(); };
$("m3MakeViews").onclick = drawViews;
$("m3ViewFile").onchange = () => { const f = $("m3ViewFile").files[0]; if (f && m3ViewTarget) upload3dView(m3ViewTarget, f); $("m3ViewFile").value = ""; };
$("m3Go").onclick = make3d;

async function loadChars() {
  try { chars = (await api("/lora-lab/characters")).characters; charsLoaded = true; }
  catch { charsLoaded = false; }
  if (charsLoaded && S.charId && !activeChar()) { S.charId = ""; save(); }
  renderCharActive();
  if (tab === "chars") renderChars();
  if (tab === "images") renderImages();
}

// Sidebar: pick the active character and what to use from it.
function renderCharActive() {
  const sel = $("charActive"); sel.innerHTML = "";
  sel.append(el("option", { value: "", text: wsChars().length ? "No character" : "No characters yet — see the Characters tab" }));
  for (const c of wsChars()) sel.append(el("option", { value: c.id, text: c.name }));
  const ch = activeChar();
  sel.value = ch ? ch.id : "";
  renderWfChar();
  $("charActiveBox").style.display = ch ? "" : "none";
  $("charEditActive").style.display = ch ? "" : "none";
  if (!ch) $("faceWrap").style.display = $("faceNote").style.display = "none";
  $("newLookExtraWrap").style.display = ch && adultMode() && (S.newLook || "ai") !== "off" ? "" : "none";
  if (ch) {
    $("charMiniImg").src = charThumb(ch);
    $("charMiniName").textContent = ch.name;
    const info = [];
    if (ch.loras.length) info.push(`${ch.loras.filter(l => compatible(l.name)).length} of ${ch.loras.length} LoRAs fit ${ENGINE_LABEL[S.engine]}`);
    if (ch.engine !== "any" && ch.engine !== S.engine) info.push(`made for ${ENGINE_LABEL[ch.engine]}`);
    $("charMiniInfo").textContent = info.join(" · ") || "Their tags go before your prompt";
    $("cuAppearance").checked = S.charUse.appearance;
    $("cuOutfit").checked = S.charUse.outfit;
    $("cuLoras").checked = S.charUse.loras; $("cuLoras").disabled = !ch.loras.length;
    $("newLookMode").value = S.newLook || "ai";
    $("newLookExtra").value = (S.newLookExtra || {})[ch.id] || "";
    $("newLookAdult").checked = S.newLookAdult !== false;
    $("newLookAdultWrap").style.display = S.newLook === "random" ? "" : "none";
    $("newLookAdultAi").checked = !!S.newLookAdultAi;
    $("newLookAssoc").checked = !!S.newLookAssoc;
    $("newLookAdultAiWrap").style.display = (S.newLook || "ai") === "ai" ? "" : "none";
    renderNewLookCats();
    $("cuRef").checked = S.charUse.ref && !!ch.ref; $("cuRef").disabled = !ch.ref;
    $("cuFace").checked = S.charUse.face !== false && !!ch.ref; $("cuFace").disabled = !ch.ref;
    renderFaceLock(ch);
    // Memory: last settings and recent prompts used with this character in this workspace.
    const last = (ch.last || {})[mode];
    $("charRestore").style.display = last ? "" : "none";
    const recent = (ch.prompts || {})[mode] || [];
    const rs = $("charRecent"); rs.innerHTML = "";
    rs.style.display = recent.length ? "" : "none";
    rs.append(el("option", { value: "", text: `Recent prompts (${recent.length})…` }));
    recent.forEach((t, i) => rs.append(el("option", { value: String(i), text: t.length > 70 ? t.slice(0, 70) + "…" : t, title: t })));
  }
  renderRefGen(); updateSummary();
}
$("charActive").onchange = () => { S.charId = $("charActive").value; save(); renderCharActive(); renderCharList(); prefetchAssoc(); };
$("newLookMode").onchange = () => { S.newLook = $("newLookMode").value; save(); renderCharActive(); };
$("newLookAdult").onchange = () => { S.newLookAdult = $("newLookAdult").checked; save(); };
$("newLookAdultAi").onchange = () => { S.newLookAdultAi = $("newLookAdultAi").checked; save(); };
$("newLookAssoc").onchange = () => { S.newLookAssoc = $("newLookAssoc").checked; save(); prefetchAssoc(); };
// One button per 18+ Tag library category; each click puts a random tag from it into the Extra 18+ tags box,
// one that makes sense with the tags already there and with the character.
function renderNewLookCats() {
  const box = $("newLookCats"); box.innerHTML = "";
  if (!lib || !adultMode()) return;
  for (const c of lib.categories.filter(c => c.adult && !/^dog$/i.test(c.name.trim())))
    box.append(el("button", { class: "btn sm", text: "+ " + c.name.replace(/\s*\(NSFW\)\s*$/i, ""), title: `Add a random tag from ${c.name}`,
      onclick: () => addNewLookTag(c) }));
}
async function addNewLookTag(c) {
  const mine = splitTags($("newLookExtra").value), have = [...mine, ...splitTags(joinTags(charPromptParts(true, "")))];
  let rel = null;
  if (assocOn(mine)) try { rel = await relatedTags(mine); } catch (err) { toast(tfError(err, "Couldn't look up related tags")); }
  const t = pickFit(c.tags.filter(t => !ANIMAL_SEX.test(t) && !REF_BLOCK.has(normTag(t))), have, rel);
  if (!t) return toast(`No tag from ${c.name} fits with the tags you already have`);
  $("newLookExtra").value = joinTags([$("newLookExtra").value, t]);
  $("newLookExtra").onchange();
}
$("newLookExtra").onchange = () => {
  const ch = activeChar();
  if (!ch) return;
  const tags = splitTags($("newLookExtra").value), blocked = tags.filter(t => REF_BLOCK.has(normTag(t)));
  if (blocked.length) toast("Child-related tags can't be added: " + blocked.join(", "));
  const kept = tags.filter(t => !REF_BLOCK.has(normTag(t))).join(", ");
  (S.newLookExtra || (S.newLookExtra = {}))[ch.id] = kept; $("newLookExtra").value = kept; save(); prefetchAssoc();
};
for (const k of ["appearance", "outfit", "loras", "ref", "face"]) {
  const id = "cu" + k[0].toUpperCase() + k.slice(1);
  $(id).onchange = () => { S.charUse[k] = $(id).checked; save(); renderCharActive(); };
}
// What "Keep face" does with the current model type.
function renderFaceLock(ch) {
  const on = S.charUse.face !== false, support = faceLockSupport(), note = $("faceNote");
  let text = "";
  if (!ch.ref) text = `Add a reference image to ${ch.name} (Characters tab) to keep the same face every time.`;
  else if (on && support === "ipa") text = `${ch.name}'s face is copied from the reference image (IP-Adapter). Works best when the reference shows the face clearly.`;
  else if (on && support === "klein") text = `Klein copies ${ch.name}'s face from the reference image.`;
  else if (on && support === "panel") text = `Anima draws ${ch.name} beside the reference image and keeps only the new picture, so each image takes about twice as long. Hair, face and eyes carry over well; small marks can still vary.`;
  else if (on && S.engine === "anima") text = `Keep face on Anima is paused while the Reference image or a sketch pose is in use.`;
  else if (on && S.engine === "sdxl") text = "Keeping the face on SDXL needs the IP-Adapter node pack with ip-adapter-plus-face_sdxl_vit-h and a ViT-H CLIP vision model.";
  else if (on) text = `${ENGINE_LABEL[S.engine]} can't copy a face from an image, so only ${ch.name}'s tags are used and the face will vary between images. Use an SDXL model (Illustrious, NoobAI, Pony) or Klein to keep it the same.`;
  note.textContent = text; note.style.display = text ? "" : "none";
  $("faceWrap").style.display = ch.ref && on && support === "ipa" ? "" : "none";
  $("faceWeight").value = S.faceWeight; $("faceWeightV").textContent = Number(S.faceWeight).toFixed(2);
}
$("faceWeight").addEventListener("input", () => { S.faceWeight = Number($("faceWeight").value); $("faceWeightV").textContent = S.faceWeight.toFixed(2); save(); });
$("charEditActive").onclick = () => { editId = S.charId; store.set("charEdit", editId); showTab("chars"); };

// Characters tab
function renderCharList() {
  const list = $("charList"); list.innerHTML = "";
  if (!charsLoaded) list.append(el("div", { class: "hint", text: "Restart Kōbō once to enable characters." }));
  for (const c of wsChars()) {
    list.append(el("div", { class: "charitem" + (c.id === editId ? " on" : ""), onclick: () => { editId = c.id; store.set("charEdit", editId); lastCharField = null; renderChars(); renderLibrary(); } },
      el("img", { src: charThumb(c), alt: "" }),
      el("div", { style: "min-width:0" }, el("b", { text: c.name }),
        el("div", { class: "hint", text: `${galleryImages(c).length} images${c.id === S.charId ? " · active" : ""}` }))));
  }
}

const CHAR_FIELDS = { charName: "name", charTriggers: "triggers", charAppearance: "appearance", charOutfit: "outfit", charNegative: "negative",
  charNotes: "notes", charMemory: "memory" };
const CHAR_TAG_FIELDS = ["charTriggers", "charAppearance", "charOutfit"];
function renderChars() {
  renderCharList();
  const c = editChar();
  $("charEmpty").style.display = c ? "none" : "";
  $("charForm").style.display = c ? "" : "none";
  if (!c) return;
  for (const [id, key] of Object.entries(CHAR_FIELDS)) if (document.activeElement !== $(id)) $(id).value = c[key] || "";
  $("charEngine").value = c.engine;
  $("charRefDrop").classList.toggle("has", !!c.ref);
  $("charRefImg").src = c.ref ? inputUrl(c.ref) : "";
  $("charAutoTag").disabled = !c.ref;
  $("charUseBtn").textContent = c.id === S.charId ? "✓ Active character" : "Use this character";
  renderCharLoras();
  renderCharGallery();
}
function renderCharLoras() {
  const c = editChar(); if (!c) return;
  const box = $("charLoras"); box.innerHTML = "";
  for (const l of c.loras) {
    const fam = (loraInfo[l.name] || {}).family || "other";
    const mismatch = c.engine !== "any" && fam !== c.engine;
    box.append(el("div", { class: "charlora" },
      el("span", { class: "name", text: stem(l.name), title: l.name }),
      el("span", { class: "badge " + fam, text: ENGINE_LABEL[fam] || fam, title: mismatch ? `Made for ${ENGINE_LABEL[fam] || fam}; only used when generating with that model type` : "" }),
      el("input", { type: "number", min: "-2", max: "3", step: "0.05", value: l.strength, title: "Strength",
        oninput: (ev) => { l.strength = parseFloat(ev.target.value) || 0; scheduleCharSave(c); } }),
      el("button", { class: "btn sm danger", text: "×", title: "Remove", onclick: () => { c.loras = c.loras.filter(x => x !== l); scheduleCharSave(c); renderCharLoras(); } })));
  }
  if (!c.loras.length) box.append(el("div", { class: "hint", text: "None yet." }));
  const avail = lists.loras.filter(n => !c.loras.some(l => l.name === n) && loraAllowed(n) && ENGINE_LABEL[(loraInfo[n] || {}).family])
    .sort((a, b) => isAdultLora(a) - isAdultLora(b));
  fillSelect($("charLoraPick"), avail, null, n => `${isAdultLora(n) ? "18+ · " : ""}${stem(n)} — ${ENGINE_LABEL[loraInfo[n].family]}`);
  $("charLoraAdd").disabled = !avail.length;
}
// Gallery of this workspace only, favourites first.
function galleryImages(c) {
  const fav = new Set(c.favorites || []);
  const imgs = (c.images || []).filter(x => (x.mode || "adult") === mode).slice().reverse();
  return [...imgs.filter(x => fav.has(imgKey(x.image))), ...imgs.filter(x => !fav.has(imgKey(x.image)))];
}
// Rank by likeness: CCIP differences of the gallery's pictures to the character's reference image (lower = more alike).
let likeness = null;   // { id, ref, threshold, diffs: Map imgKey -> difference }
const likenessRef = (c) => c.ref ? `${c.ref.subfolder || ""}/${c.ref.name}` : "";
async function rankLikeness(c, imgs, btn) {
  btn.disabled = true; btn.textContent = "Comparing…";
  try {
    const r = await post("/lora-lab/likeness", { ref: { filename: c.ref.name, subfolder: c.ref.subfolder || "", type: "input" }, images: imgs.map(x => x.image) });
    likeness = { id: c.id, ref: likenessRef(c), threshold: r.threshold,
      diffs: new Map(imgs.map((x, i) => [imgKey(x.image), r.differences[i]]).filter(([, d]) => d != null)) };
  } catch (err) { toast("Rank by likeness failed: " + err.message); }
  finally { btn.disabled = false; renderCharGallery(); }
}
function likenessBadge(d, thr) {
  const [cls, text] = d <= thr ? ["match", "same"] : d <= thr * 1.5 ? ["close", "close"] : ["off", "off-model"];
  return el("span", { class: "lk " + cls, text, title: `CCIP difference ${d.toFixed(3)} (${thr.toFixed(2)} or lower = the same character)` });
}
function renderCharGallery() {
  const c = editChar(); if (!c) return;
  const fav = new Set(c.favorites || []);
  const rank = likeness && likeness.id === c.id && likeness.ref === likenessRef(c) ? likeness : null;
  const far = (x) => rank.diffs.get(imgKey(x.image)) ?? Infinity;
  const imgs = rank ? [...galleryImages(c)].sort((a, b) => far(a) - far(b)) : galleryImages(c);
  $("charCount").textContent = imgs.length ? `(${imgs.length})` : "";
  $("charDownloadAll").style.display = imgs.length ? "" : "none";
  const rb = $("charRank");
  rb.style.display = lists.likeness && c.ref && imgs.length > 1 ? "" : "none";
  rb.textContent = rank ? "Newest first" : "Rank by likeness";
  rb.onclick = () => { if (rank) { likeness = null; renderCharGallery(); } else rankLikeness(c, imgs, rb); };
  const box = $("charGallery"); box.innerHTML = "";
  if (!imgs.length) box.append(el("div", { class: "hint", text: "Images you generate with this character in this workspace show up here." }));
  const items = imgs.map(x => ({ image: x.image, label: c.name + (x.lora ? " · " + stem(x.lora) : ""), seed: x.seed }));
  imgs.forEach((x, i) => {
    const key = imgKey(x.image), isFav = fav.has(key), d = rank && rank.diffs.get(key);
    box.append(el("div", { class: "gimg" },
      el("img", { src: thumbUrl(x.image), loading: "lazy", alt: "", onclick: () => openLbItems(items, i) }),
      d != null && rank ? likenessBadge(d, rank.threshold) : null,
      el("div", { class: "gb" },
        el("button", { class: isFav ? "on" : "", text: "★", title: isFav ? "Remove from favourites" : "Add to favourites",
          onclick: () => { c.favorites = isFav ? (c.favorites || []).filter(k => k !== key) : [...(c.favorites || []), key]; scheduleCharSave(c); renderCharGallery(); } }),
        el("button", { text: "⤴", title: "Use as this character's reference image",
          onclick: async () => { try { const b = await (await fetch(imgUrl(x.image))).blob(); setCharRef(new File([b], x.image.filename, { type: b.type })); } catch { toast("Couldn't read that image."); } } }))));
  });
}

// ⬇ Download all: the gallery's images in one .zip, built in the page (stored, not compressed: PNGs already are),
// so it works on any device without a server change. Images deleted from the output folder are skipped.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipBlob(files) {   // files: [{ name, data: Uint8Array }]
  const parts = [], central = [], enc = new TextEncoder(), d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const head = (sig, extra) => { const b = new DataView(new ArrayBuffer(extra)); b.setUint32(0, sig, true); return b; };
    const local = head(0x04034b50, 30);
    // version 2.0, flag bit 11 = UTF-8 names, method 0 = stored
    [[4, 20], [6, 0x800], [8, 0], [10, time], [12, date], [26, name.length], [28, 0]].forEach(([o, v]) => local.setUint16(o, v, true));
    [[14, crc], [18, size], [22, size]].forEach(([o, v]) => local.setUint32(o, v, true));
    const cen = head(0x02014b50, 46);
    [[4, 20], [6, 20], [8, 0x800], [10, 0], [12, time], [14, date], [28, name.length], [30, 0], [32, 0], [34, 0], [36, 0]].forEach(([o, v]) => cen.setUint16(o, v, true));
    [[16, crc], [20, size], [24, size], [38, 0], [42, offset]].forEach(([o, v]) => cen.setUint32(o, v, true));
    parts.push(local, name, f.data); central.push(cen, name);
    offset += 30 + name.length + size;
  }
  const cenSize = central.reduce((n, p) => n + p.byteLength, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
// Fetches each image (refs: { subfolder, filename, type }) and saves them as one .zip; btn shows progress.
async function downloadZip(refs, btn, zipName) {
  if (!refs.length) return;
  const label = btn.textContent;
  btn.disabled = true;
  const files = [], used = new Set();
  let missing = 0;
  try {
    for (const [i, ref] of refs.entries()) {
      btn.textContent = `⬇ ${i + 1} / ${refs.length}…`;
      try {
        const r = await fetch(imgUrl(ref));
        if (!r.ok) throw new Error();
        let name = ref.filename;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = ref.filename.replace(/(\.[^.]*)?$/, `-${n}$1`);
        used.add(name.toLowerCase());
        files.push({ name, data: new Uint8Array(await r.arrayBuffer()) });
      } catch { missing++; }
    }
    if (!files.length) return toast("None of these images are in the output folder any more.");
    const a = el("a", { href: URL.createObjectURL(zipBlob(files)), download: zipName.replace(/[\\/:*?"<>|]+/g, "_") + ".zip" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast(`Downloading ${files.length} image${files.length === 1 ? "" : "s"}${missing ? ` (${missing} no longer in the output folder)` : ""}`, true);
  } finally { btn.disabled = false; btn.textContent = label; }
}
async function downloadCharGallery() {
  const c = editChar(); if (!c) return;
  await downloadZip(galleryImages(c).map(x => x.image), $("charDownloadAll"), `${c.name} - ${mode === "adult" ? "Adult" : "General"}`);
}
$("charDownloadAll").onclick = downloadCharGallery;

function scheduleCharSave(c) {
  $("charSaved").textContent = "Saving…";
  clearTimeout(charSaveTimers[c.id]);
  charSaveTimers[c.id] = setTimeout(() => saveChar(c), 500);
}
async function saveChar(c) {
  clearTimeout(charSaveTimers[c.id]); delete charSaveTimers[c.id];
  try {
    const saved = await post("/lora-lab/characters", c);
    // Only take server-owned fields, so text typed while saving isn't overwritten.
    Object.assign(c, { images: saved.images, created: saved.created, updated: saved.updated });
    if (editChar() === c) $("charSaved").textContent = "Saved";
    renderCharList(); renderCharActive();
  } catch (err) { $("charSaved").textContent = ""; toast(charRouteError(err, "Couldn't save the character")); }
}

for (const [id, key] of Object.entries(CHAR_FIELDS)) {
  $(id).addEventListener("input", () => {
    const c = editChar(); if (!c) return;
    c[key] = $(id).value; scheduleCharSave(c);
    if (CHAR_TAG_FIELDS.includes(id)) renderLibrary();
  });
}
for (const id of CHAR_TAG_FIELDS) {
  $(id).addEventListener("focus", () => { lastCharField = id; renderLibrary(); });
  $(id).addEventListener("blur", () => {   // same safeguard as everywhere else
    const c = editChar(); if (!c) return;
    const tags = splitTags($(id).value), kept = tags.filter(t => !REF_BLOCK.has(normTag(t)));
    if (kept.length !== tags.length) {
      $(id).value = c[CHAR_FIELDS[id]] = kept.join(", "); scheduleCharSave(c);
      toast("Child-related tags were removed.");
    }
  });
}
$("charEngine").onchange = () => { const c = editChar(); if (!c) return; c.engine = $("charEngine").value; scheduleCharSave(c); renderCharLoras(); };

$("charNew").onclick = async () => {
  try {
    const c = await post("/lora-lab/characters", { name: `Character ${wsChars().length + 1}`, engine: "any", workspace: mode });
    chars.push(c); charsLoaded = true; editId = c.id; store.set("charEdit", editId); lastCharField = null;
    renderChars(); renderCharActive();
    $("charName").focus(); $("charName").select();
  } catch (err) { toast(charRouteError(err, "Couldn't create a character")); }
};
$("charUseBtn").onclick = () => {
  const c = editChar(); if (!c) return;
  S.charId = c.id;
  if (c.engine !== "any" && c.engine !== S.engine) S.engine = c.engine;
  save(); renderSettings(); renderChars();
  toast(`${c.name} is now the active character`, true);
};
$("charDelete").onclick = async () => {
  const c = editChar(); if (!c) return;
  if (!confirm(`Delete ${c.name}? Their generated images stay in your output folder.`)) return;
  try { await post("/lora-lab/characters/delete", { id: c.id }); }
  catch (err) { return toast(charRouteError(err, "Couldn't delete")); }
  chars = chars.filter(x => x !== c);
  if (S.charId === c.id) { S.charId = ""; save(); }
  editId = chars.length ? chars[0].id : null; store.set("charEdit", editId);
  renderChars(); renderCharActive();
};
$("charLoraAdd").onclick = () => {
  const c = editChar(), n = $("charLoraPick").value; if (!c || !n) return;
  c.loras.push({ name: n, strength: (ENGINE_DEFAULTS[(loraInfo[n] || {}).family] || { strength: 1 }).strength });
  scheduleCharSave(c); renderCharLoras();
};

// Reference image for the character (also used for "✨ Tags from image").
async function setCharRef(file) {
  const c = editChar(); if (!c || !file || !/^image\//.test(file.type)) return;
  const ext = ((/\.(png|jpe?g|webp|bmp|gif)$/i.exec(file.name || "") || [".png"])[0]).toLowerCase();
  const fd = new FormData();
  fd.append("image", file, `char_${c.id}_${Date.now()}${ext}`);
  fd.append("type", "input"); fd.append("subfolder", "lora-lab/characters"); fd.append("overwrite", "true");
  $("charSaved").textContent = "Uploading…";
  try {
    const r = await api("/upload/image", { method: "POST", body: fd });
    c.ref = { name: r.name, subfolder: r.subfolder || "" };
    c.refSize = await imageSize(file);
    await saveChar(c);
    renderChars(); renderCharActive();
    if (!c.appearance && !c.outfit) autoTagChar(c);   // first image: fill the tags automatically
  } catch (err) { $("charSaved").textContent = ""; toast("Couldn't upload the image: " + err.message); }
}
$("charRefDrop").onclick = () => $("charRefFile").click();
$("charRefDrop").onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); $("charRefFile").click(); } };
$("charRefFile").onchange = () => { setCharRef($("charRefFile").files[0]); $("charRefFile").value = ""; };
for (const t of ["dragenter", "dragover"]) $("charRefDrop").addEventListener(t, (ev) => { ev.preventDefault(); $("charRefDrop").classList.add("over"); });
for (const t of ["dragleave", "drop"]) $("charRefDrop").addEventListener(t, (ev) => { ev.preventDefault(); $("charRefDrop").classList.remove("over"); });
$("charRefDrop").addEventListener("drop", async (ev) => {
  const f = ev.dataTransfer.files[0];
  if (f) return setCharRef(f);
  const url = ev.dataTransfer.getData("text/uri-list") || ev.dataTransfer.getData("text/plain");   // dragged from results/gallery
  if (!url) return;
  try { const b = await (await fetch(url)).blob(); setCharRef(new File([b], "reference.png", { type: b.type })); }
  catch { toast("Couldn't read that image — save it and drop the file instead."); }
});

// Split tagger output into appearance (stays) and outfit (changes); poses, expressions and scenery are skipped.
const OUTFIT_CATS = new Set(["Clothing", "Accessories", "Lingerie & fetish wear (NSFW)"]);
const LOOK_CATS = new Set(["Subject", "Hair", "Body", "Fantasy"]);
const LOOK_RE = /(hair\b|hair$|eyes|heterochromia|bangs|ponytail|braid|twintails|bun\b|skin|ears|tail\b|horns|wings|breasts|freckles|mole|pupils|eyelashes|abs\b|muscular|curvy|fang|^\d\+?(girl|boy)s?$|^solo$)/;
const SKIP_RE = /(closed eyes|eye closed|half-closed|looking|eye contact|tears|navel|cleavage|armpits|barefoot|thighs|feet|toes|ass\b|sideboob|underboob|collarbone|stomach|midriff|bare shoulders|wet|sweat|groin|^breasts$)/;
async function autoTagChar(c) {
  if (!c.ref) return;
  const btn = $("charAutoTag"); btn.disabled = true; btn.textContent = "Reading…";
  try {
    const blob = await (await fetch(inputUrl(c.ref))).blob();
    const fd = new FormData(); fd.append("image", blob, c.ref.name);
    fd.append("models", tagModelsParam()); fd.append("rule34", mode === "adult" ? "1" : "");
    const r = await api("/lora-lab/tag", { method: "POST", body: fd });
    const catOf = {};
    if (lib) for (const cat of lib.categories) for (const t of cat.tags) catOf[normTag(t)] = cat.name;
    const look = [], outfit = [];
    for (const [t, p] of r.general) {
      if (p < 0.35 || REF_BLOCK.has(normTag(t)) || SKIP_RE.test(t)) continue;
      const cat = catOf[normTag(t)], group = (r.groups || {})[t];   // your Tags tab first, then the taxonomy
      if (OUTFIT_CATS.has(cat) || (!cat && group === "clothing") || OUTFIT_RE.test(t)) outfit.push(t);
      else if (LOOK_CATS.has(cat) || (!cat && group === "look") || LOOK_RE.test(t)) look.push(t);
    }
    const merge = (cur, add) => {
      const have = new Set(splitTags(cur).map(normTag));
      return splitTags(cur).concat(add.filter(t => !have.has(normTag(t)) && have.add(normTag(t)))).join(", ");
    };
    c.appearance = merge(c.appearance, look);
    c.outfit = merge(c.outfit, outfit);
    await saveChar(c);
    renderChars();
    toast(`Read ${look.length} appearance and ${outfit.length} outfit tags from the image`, true);
  } catch (err) {
    toast(ROUTE_MISSING.test(err.message) ? "The tagger isn't loaded — restart Kōbō once." : "Couldn't read tags: " + err.message);
  } finally { btn.textContent = "Tags from image"; btn.disabled = !(editChar() && editChar().ref); }
}
$("charAutoTag").onclick = () => { const c = editChar(); if (c) autoTagChar(c); };

// ---------- character memory ----------
function settingsSnapshot() {
  const e = E();
  return { engine: S.engine, model: e.model, te: e.te, avae: e.avae, vae: e.vae, clipSkip: e.clipSkip, steps: e.steps, cfg: e.cfg,
    sampler: e.sampler, scheduler: e.scheduler, size: S.size, w: S.w, h: S.h, denoise: S.denoise, kleinRefMode: S.kleinRefMode,
    charUse: Object.assign({}, S.charUse),
    loras: selectedLoras().map(n => ({ name: n, strength: loraStrength(n) })) };
}
function rememberForChar() {
  const ch = activeChar(); if (!ch) return;
  post("/lora-lab/characters/remember", { id: ch.id, mode, settings: settingsSnapshot(), prompt: S.prompt })
    .then((r) => { ch.last = r.last; ch.prompts = r.prompts; renderCharActive(); })
    .catch(() => {});
}
function restoreSettings(st) {
  if (st.engine in ENGINE_DEFAULTS) S.engine = st.engine;
  const e = E();
  for (const k of ["model", "te", "avae", "vae", "clipSkip", "steps", "cfg", "sampler", "scheduler"]) if (st[k] != null) e[k] = st[k];
  for (const k of ["size", "w", "h", "denoise", "kleinRefMode"]) if (st[k] != null) S[k] = st[k];
  if (st.charUse) S.charUse = Object.assign({}, S.charUse, st.charUse);
  if ((st.loras || []).length) e.noLora = false;
  for (const n of lists.loras) if (loraVisible(n)) loraState(n).on = false;
  for (const l of st.loras || []) {
    if (!lists.loras.includes(l.name) || !loraAllowed(l.name)) continue;
    const ls = loraState(l.name); ls.on = true; ls.strength = l.strength;
    if (mode === "adult" && !isAdultLora(l.name)) S.showGenLoras = true;
  }
  save(); renderSettings();
}
$("charRestore").onclick = () => {
  const ch = activeChar(), st = ch && (ch.last || {})[mode];
  if (st) { restoreSettings(st); toast(`Restored the settings last used with ${ch.name}`, true); }
};
$("charRecent").onchange = () => {
  const ch = activeChar(), i = $("charRecent").value;
  const t = ch && i !== "" ? ((ch.prompts || {})[mode] || [])[Number(i)] : null;
  if (t != null) { S.prompt = t; $("prompt").value = t; save(); renderLibrary(); }
  $("charRecent").value = "";
};

// Pick up characters edited on another device.
document.addEventListener("visibilitychange", () => {
  const editing = document.activeElement && document.activeElement.closest && document.activeElement.closest("#charForm");
  if (!document.hidden && !Object.keys(charSaveTimers).length && !editing) loadChars();
});

// ---------- stories (Story workspace) ----------
// The prompt writer plans a story (title, cover, chapter outline, then each chapter's scenes) and it is saved on the
// ComfyUI machine (user/default/lora-lab-stories). Every scene is drawn with the story's character, the Model panel's
// model and ticked LoRAs; finished images go into the story file, never into the character's gallery.
let stories = [], storyCur = null, storyWriting = false, storySaveTimer = null;
const STORY_LEVEL_LABEL = { safe: "General", spicy: "Explicit 18+", nude: "Nude 18+", strip: "Dressed → nude 18+" };
const STORY_PER_CHAPTER = 10;
// Lying, all-fours and wide scenes read better in landscape, as in the sample stories.
const WIDE_SCENE = /\b(lying|on back|on stomach|on side|all fours|doggystyle|doggy style|prone bone|mating press|spooning|top-down bottom-up|sleeping|wide shot|scenery|panorama|bed|bathtub|sex from behind|missionary)\b/i;
// General stories keep nudity out; Nude stories keep clothes out.
const STORY_NEG = { safe: "nsfw, nude, nipples, pussy, penis, sex, underwear", spicy: "", nude: "clothes, shirt, dress, skirt, pants, jacket" };
// Dressed → nude stories: each scene's stage (dressed, undressing, underwear/topless, nude) comes from the writer.
const STRIP_NEG = ["nude, completely nude, topless, nipples, pussy", "completely nude, pussy", "", STORY_NEG.nude + ", panties, bra, underwear"];
const UNDERWEAR_RE = /\b(panties|bra|underwear|lingerie|thong|g-string|bikini)\b/;
const storyScenes = (s) => s.chapters.flatMap((ch, ci) => ch.scenes.map((sc, si) => ({ ch, ci, sc, si })));
const storyPick = (sc) => (sc.images || [])[Math.min(sc.pick || 0, (sc.images || []).length - 1)];
const storyError = (err, what) => ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable stories." : `${what}: ${err.message}`;
// What the writer is told about each cast member; "count" (1girl/1boy) tells it who is a woman and who a man.
const storyWho = (c) => ({ name: c.name, memory: c.memory || "", count: splitTags(c.appearance).map(normTag).find(x => /^1(girl|boy|other)$/.test(x)) || "" });
const storyCast = (s) => [s.charId, s.costarId].map(id => chars.find(c => c.id === id)).filter(Boolean);
const storyPending = (sid, scene) => batches.filter(b => b.story && b.story.id === sid).flatMap(b => b.cells)
  .filter(c => c.story && (!scene || c.story.scene === scene) && !c.image && c.pid && (c.status === "queued" || c.status === "running")).length;

async function loadStories() {
  try { stories = await api("/lora-lab/stories?workspace=story"); }
  catch (err) { stories = []; $("stStatus").textContent = storyError(err, "Couldn't load stories"); }
  renderStoryList();
}
function renderStoryTab() {
  $("stView").style.display = storyCur ? "" : "none";
  $("stList").style.display = storyCur ? "none" : "";
  $("stNew").style.display = storyCur ? "none" : "";
  $("stIdeaCard").style.display = storyCur ? "none" : "";
  if (storyCur) renderStoryView(); else loadStories();
}
function renderStoryList() {
  const box = $("stList"); box.innerHTML = "";
  if (!stories.length) box.append(el("div", { class: "hint", text: "No stories yet. Press ＋ New story, pick a character and say what happens." }));
  for (const s of stories) {
    const who = chars.find(c => c.id === s.charId);
    box.append(el("div", { class: "stcard", onclick: () => openStory(s.id) },
      s.cover ? el("img", { src: thumbUrl(s.cover, 512), loading: "lazy", alt: "" }) : el("div", { class: "stph", text: "📖" }),
      el("div", { class: "stmeta" }, el("b", { text: s.title }),
        el("span", { text: `${who ? who.name + " · " : ""}${STORY_LEVEL_LABEL[s.level] || s.level} · ${s.done}/${s.scenes} drawn` }))));
  }
}
async function openStory(id) {
  try { storyCur = await api("/lora-lab/story?id=" + encodeURIComponent(id)); }
  catch (err) { return toast(storyError(err, "Couldn't open the story")); }
  $("stForm").style.display = "none";
  renderStoryTab();
}
function saveStorySoon() {
  clearTimeout(storySaveTimer);
  storySaveTimer = setTimeout(async () => {
    try { const saved = await post("/lora-lab/story", storyCur); if (storyCur && saved.id === storyCur.id) storyCur.updated = saved.updated; }
    catch (err) { toast(storyError(err, "Couldn't save the story")); }
  }, 800);
}

// ✍ Write: the outline first (saved right away), then each chapter's scenes, one call per chapter.
function openStoryForm() {
  const opts = (sel, none) => { sel.innerHTML = ""; if (none) sel.append(el("option", { value: "", text: none })); for (const c of chars) sel.append(el("option", { value: c.id, text: c.name })); };
  opts($("stChar")); opts($("stCostar"), "— none —");
  if (activeChar()) $("stChar").value = activeChar().id;
  $("stStatus").textContent = "";
  $("stForm").style.display = "";
}
// 🎞 From video: frames are taken here in the browser (no upload limit), JoyCaption describes them on the server and the
// writer retells them as the premise.
const VIDEO_FRAMES = 12;
const VIDEO_BAD = "This video format can't be opened here; convert it to MP4 (H.264) and try again.";
async function videoFrames(file, onFrame) {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  const once = (ev) => new Promise((ok, bad) => {
    v.addEventListener(ev, ok, { once: true });
    v.addEventListener("error", () => bad(new Error(VIDEO_BAD)), { once: true });
  });
  v.muted = true; v.preload = "auto";
  try {
    const loaded = once("loadeddata"); v.src = url; await loaded;
    if (!isFinite(v.duration) || !v.videoWidth) throw new Error(VIDEO_BAD);
    const scale = Math.min(1, 768 / Math.max(v.videoWidth, v.videoHeight));
    const cv = document.createElement("canvas");
    cv.width = Math.round(v.videoWidth * scale); cv.height = Math.round(v.videoHeight * scale);
    // Blank frames (fades, black screens) are swapped for one a little later or earlier in the same stretch.
    const probe = document.createElement("canvas"); probe.width = 32; probe.height = 16;
    const blank = () => {
      const g = probe.getContext("2d", { willReadFrequently: true });
      g.drawImage(v, v.videoWidth / 4, v.videoHeight / 4, v.videoWidth / 2, v.videoHeight / 2, 0, 0, 32, 16);
      const px = g.getImageData(0, 0, 32, 16).data;
      let sum = 0, sq = 0;
      for (let k = 0; k < px.length; k += 4) { const y = (px[k] + px[k + 1] + px[k + 2]) / 3; sum += y; sq += y * y; }
      const n = px.length / 4;
      return sq / n - (sum / n) ** 2 < 150;
    };
    const out = [];
    for (let i = 0; i < VIDEO_FRAMES; i++) {
      let t;
      for (const shift of [0.5, 0.8, 0.2]) {
        const seeked = once("seeked");
        t = v.duration * (i + shift) / VIDEO_FRAMES; v.currentTime = t; await seeked;
        if (!blank()) break;
      }
      cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);
      out.push({ time: Math.round(t), image: cv.toDataURL("image/jpeg", 0.85).split(",")[1] });
      onFrame(i + 1);
    }
    return out;
  } finally { v.removeAttribute("src"); v.load(); URL.revokeObjectURL(url); }
}
async function storyFromVideo(file) {
  if (!file) return;
  const ch = chars.find(c => c.id === $("stChar").value);
  const co = chars.find(c => c.id === $("stCostar").value && c.id !== (ch && ch.id));
  const status = $("stStatus");
  $("stVideo").disabled = $("stWrite").disabled = true;
  try {
    const frames = await videoFrames(file, n => { status.textContent = `🎞 Taking frames… ${n}/${VIDEO_FRAMES}`; });
    status.textContent = `🎞 Watching ${frames.length} frames, then writing what happens… (runs on this PC; about 2-4 minutes)`;
    const r = await post("/lora-lab/story/video", { frames, level: $("stLevel").value, workspace: "story", model: $("llmModel").value,
      character: [ch, co].filter(Boolean).map(storyWho) });
    $("stPremise").value = r.premise;
    status.textContent = "Done: read “What happens”, change anything you like, then press ✍ Write story.";
  } catch (err) {
    status.textContent = "";
    toast(ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable 🎞 From video." : err.message);
  } finally { $("stVideo").disabled = false; $("stWrite").disabled = storyWriting; $("stVideoFile").value = ""; }
}
async function writeStory() {
  const ch = chars.find(c => c.id === $("stChar").value);
  if (!ch) return toast("Make a character first (Characters tab), then pick it here.");
  const co = chars.find(c => c.id === $("stCostar").value && c.id !== ch.id) || null;
  const total = Math.max(20, Math.min(300, Number($("stCount").value) || 60));
  const chapters = Math.max(1, Math.round((total - 1) / STORY_PER_CHAPTER));
  const level = $("stLevel").value, premise = $("stPremise").value.trim();
  const cast = [ch, co].filter(Boolean).map(storyWho);
  const base = { level, target: dolphinTarget(), model: $("llmModel").value, workspace: "story", character: cast };
  storyWriting = true; $("stWrite").disabled = true;
  $("stStatus").textContent = `✍ Planning ${chapters} chapters… (the prompt writer runs on this PC; this takes a minute)`;
  try {
    const o = await post("/lora-lab/story/outline", { ...base, premise, chapters });
    storyCur = await post("/lora-lab/story", { charId: ch.id, costarId: co ? co.id : "", workspace: "story", level, target: base.target,
      title: o.title, premise, gen: { engine: S.engine, model: E().model, variants: Number($("stVariants").value), mix: $("stMix").checked, face: $("stFace").checked },
      chapters: [{ cover: true, title: "Cover", want: 1, scenes: o.cover ? [{ text: o.title, prompt: o.cover }] : [] },
        ...o.chapters.map((c, i, all) => ({ ...c, want: Math.round((i + 1) * (total - 1) / all.length) - Math.round(i * (total - 1) / all.length), scenes: [] }))] });
    $("stForm").style.display = "none"; $("stPremise").value = "";
    renderStoryTab();
    await writeChapters(base);
  } catch (err) { $("stStatus").textContent = storyError(err, "Writing failed"); toast(storyError(err, "Writing failed")); }
  finally { storyWriting = false; $("stWrite").disabled = false; }
}
async function writeChapters(base) {
  const s = storyCur, plot = { title: s.title, premise: s.premise, chapters: s.chapters.filter(c => !c.cover) };
  base = base || { level: s.level, target: s.target || dolphinTarget(), model: $("llmModel").value, workspace: "story",
    character: storyCast(s).map(storyWho) };
  storyWriting = true; renderStoryView();
  try {
    for (let i = 0; i < plot.chapters.length; i++) {
      const c = plot.chapters[i];   // looked up each time: every save replaces the chapter objects
      if (c.scenes.length) continue;
      if (storyCur !== s) return;   // another story was opened
      setStoryNote(`✍ Writing chapter ${i + 1} of ${plot.chapters.length}: ${c.title}…`);
      // The writer sometimes stops early or answers in a shape that can't be read: ask again for the rest,
      // continuing from the last scene (up to 3 tries).
      let got = [], failed = null;
      for (let tries = 0; tries < 3 && got.length < c.want; tries++) {
        const prev = got.length ? got[got.length - 1] : plot.chapters.slice(0, i).flatMap(x => x.scenes).pop();
        try { got = got.concat((await post("/lora-lab/story/chapter", { ...base, story: plot, index: i, scenes: c.want - got.length, first: got.length, prev: prev ? prev.text : "" })).scenes); }
        catch (err) { failed = err; if (ROUTE_MISSING.test(err.message)) break; }
      }
      if (!got.length) throw failed || new Error("no scenes");
      c.scenes = got.map(x => ({ ...x, wide: !!s.gen.mix && WIDE_SCENE.test(x.prompt) }));
      Object.assign(s, await post("/lora-lab/story", s));
      plot.chapters = s.chapters.filter(x => !x.cover);
      renderStoryView();
    }
    setStoryNote("");
    toast(`"${s.title}" is written: ${storyScenes(s).length} scenes. Press ▶ Draw all to make the images.`, true);
  } catch (err) { setStoryNote(storyError(err, "Writing stopped") + " — press ✍ Write missing chapters to go on."); }
  finally { storyWriting = false; if (storyCur === s) renderStoryView(); }
}
const setStoryNote = (t) => { const n = $("stNote"); if (n) n.textContent = t; };

// ▶ Draw: every scene that has fewer versions than the story asks for, cover first, in one results batch.
function storyGraph(s, x, cast, seed, prefix) {
  const [ch, co] = cast, keep = { charId: S.charId, charUse: S.charUse, w: S.w, h: S.h };
  Object.assign(S, { charId: ch.id, charUse: { appearance: true, outfit: false, loras: true, ref: false, face: s.gen.face !== false },
    w: x.sc.wide ? 1216 : 832, h: x.sc.wide ? 832 : 1216 });
  plainGraph = true;
  try {
    const stage = s.level === "strip" ? x.sc.stage || 0 : -1, nude = s.level === "nude" || stage === 3;
    let prompt = joinTags([nude || stage > 1 ? "" : x.ch.outfit, x.sc.prompt]);
    if (nude) prompt = joinTags(["nude, completely nude", dropGarments(prompt)]);
    if (stage === 3) prompt = splitTags(prompt).filter(t => !UNDERWEAR_RE.test(normTag(t))).join(", ");
    // The scene says who is in the picture (1girl, 1boy…); without it, the character's own count tags.
    if (!splitTags(prompt).some(t => COUNT_TAG.test(normTag(t)))) prompt = joinTags([...splitTags(ch.appearance).filter(t => COUNT_TAG.test(normTag(t))), prompt]);
    const extra = [...selectedLoras().map(n => ({ name: n, strength: loraStrength(n) })), ...(co ? co.loras : [])];
    return buildGraph(null, seed, prefix, { prompt, newLook: true, neg: stage < 0 ? STORY_NEG[s.level] : STRIP_NEG[stage], extraLoras: extra,
      cast: co ? [co.triggers, co.appearance].filter(Boolean).map(dropCountTags) : [] }).graph;
  } finally { Object.assign(S, keep); plainGraph = false; }
}
async function drawStory(onlyScene) {
  const s = storyCur, cast = storyCast(s), e = E();
  if (!cast.length || cast[0].id !== s.charId) return toast("This story's character no longer exists.");
  if (!e.model) return toast("No model selected (Model panel).");
  const need = (sc) => onlyScene ? 1 : Math.max(0, (s.gen.variants || 1) - (sc.images || []).length - storyPending(s.id, sc.id));
  const todo = storyScenes(s).filter(x => !onlyScene || x.sc.id === onlyScene).flatMap(x => Array.from({ length: need(x.sc) }, () => x));
  if (!todo.length) return toast("Every scene already has its images. Use ↻ on a scene for another version.", true);
  const day = new Date().toISOString().slice(0, 10);
  const batch = { id: Date.now(), engine: S.engine, model: e.model, prompt: `📖 ${s.title}`, story: { id: s.id, title: s.title }, w: 832, h: 1216,
    steps: e.steps, cfg: e.cfg, sampler: e.sampler, scheduler: e.scheduler, seed: 0, count: 1, mode,
    cols: Array.from({ length: Math.min(6, todo.length) }, () => ({ lora: null })), cells: [] };
  for (const x of todo) batch.cells.push({ lora: null, status: "queued", seed: rand(), story: { scene: x.sc.id, label: x.ch.cover ? "Cover" : `${x.ci}.${x.si + 1}` } });
  batches.unshift(batch);
  renderResults(); renderStoryView();
  for (const [idx, cell] of batch.cells.entries()) {
    const graph = storyGraph(s, todo[idx], cast, cell.seed, `LoRA-Lab/stories/${safe(s.title)}/${S.engine}`);
    try {
      const res = await post("/prompt", { prompt: graph, client_id: clientId });
      cell.pid = res.prompt_id; jobs.set(res.prompt_id, { batchId: batch.id, idx });
    } catch (err) {
      cell.status = "error"; cell.error = nodeErrorText(err.body) || err.message;
      if (idx === 0) { toast("ComfyUI rejected the job:\n" + cell.error); batch.cells.forEach((c, j) => { if (j) { c.status = "error"; c.error = "Skipped"; } }); break; }
    }
  }
  saveBatches(); updateProgress(); renderStoryView();
  toast(`${todo.length} image${todo.length === 1 ? "" : "s"} queued for "${s.title}"`, true);
}
async function stopStory() {
  const s = storyCur, ids = [...jobs.entries()].filter(([, j]) => { const b = batches.find(x => x.id === j.batchId); return b && b.story && b.story.id === s.id; }).map(([pid]) => pid);
  if (!ids.length) return;
  try {
    await post("/queue", { delete: ids.filter(id => id !== runningId) });
    if (ids.includes(runningId)) await post("/interrupt", { prompt_id: runningId });
  } catch (e) { return toast("Stop failed: " + e.message); }
  for (const id of ids) { const f = findJob(id); if (f && !f.c.image) { f.c.status = "cancelled"; updateCell(f.b, f.idx); } jobs.delete(id); }
  saveBatches(); renderStoryView(); toast("Stopped", true);
}
// A finished story image goes into the story file as one more version of its scene.
function storyImageDone(b, c) {
  if (c.storyPosted || !c.image || !c.story) return;
  c.storyPosted = true;
  post("/lora-lab/story/image", { id: b.story.id, scene: c.story.scene, image: c.image, seed: c.seed })
    .then((sc) => {
      if (!storyCur || storyCur.id !== b.story.id) return;
      const x = storyScenes(storyCur).find(y => y.sc.id === sc.id);
      if (x) { x.sc.images = sc.images; x.sc.pick = sc.pick; renderSceneCard(x); renderStoryHead(); }
    })
    .catch(() => { c.storyPosted = false; });
}

function renderStoryView() {
  const s = storyCur, box = $("stView"); if (!s) return;
  box.innerHTML = "";
  box.append(el("div", { class: "sthead", id: "stHead" }), el("div", { class: "hint", id: "stNote" }));
  for (const ch of s.chapters) {
    const sec = el("section", { class: "stchap" },
      el("div", { class: "stchaph" }, el("b", { text: ch.cover ? "Cover" : ch.title }),
        ch.cover ? null : el("span", { class: "hint", text: [ch.setting, s.level === "nude" ? "" : ch.outfit].filter(Boolean).join(" · ") })),
      ch.summary ? el("div", { class: "hint", text: ch.summary }) : null,
      ch.scenes.length ? null : el("div", { class: "hint", text: storyWriting ? "Being written…" : "Not written yet." }));
    const grid = el("div", { class: "stgrid" });
    ch.scenes.forEach((sc, si) => { const d = el("div", { class: "stscene", id: "sc-" + sc.id }); grid.append(d); });
    sec.append(grid); box.append(sec);
  }
  for (const x of storyScenes(s)) renderSceneCard(x);
  renderStoryHead();
}
function renderStoryHead() {
  const s = storyCur, h = $("stHead"); if (!s || !h) return;
  const all = storyScenes(s), drawn = all.filter(x => (x.sc.images || []).length).length, pend = storyPending(s.id);
  const who = storyCast(s).map(c => c.name).join(" & ") || "missing character";
  const missing = s.chapters.some(c => !c.cover && !c.scenes.length);
  const loras = selectedLoras().map(stem).join(", ") || "none";
  h.innerHTML = "";
  h.append(
    el("button", { class: "btn sm", text: "← Stories", onclick: () => { storyCur = null; renderStoryTab(); } }),
    el("input", { type: "text", class: "sttitle", value: s.title, onchange: (ev) => { s.title = ev.target.value || s.title; saveStorySoon(); } }),
    el("div", { class: "stinfo", text: `${who} · ${STORY_LEVEL_LABEL[s.level]} · ${drawn}/${all.length} scenes drawn${pend ? ` · ${pend} in progress` : ""} · ${s.gen.variants || 1} version${(s.gen.variants || 1) > 1 ? "s" : ""} per scene` }),
    el("div", { class: "stinfo hint", text: `Draws with ${ENGINE_LABEL[S.engine]} · ${stem(E().model || "no model")} · LoRAs: ${loras} (change them in the Model panel)` }),
    el("div", { class: "inline stbtns" },
      missing ? el("button", { class: "btn", text: "Write missing chapters", disabled: storyWriting ? "" : null, onclick: () => writeChapters() }) : null,
      el("button", { class: "btn primary", text: "▶ Draw all", title: "Queue every scene that doesn't have its images yet", onclick: () => drawStory() }),
      pend ? el("button", { class: "btn", text: "⏹ Stop", onclick: stopStory }) : null,
      drawn ? el("button", { class: "btn", text: "Read", onclick: () => openReader(0) }) : null,
      drawn ? el("button", { class: "btn", text: "⬇ Download", title: "The picked image of every scene, in story order, as one .zip", onclick: downloadStory }) : null,
      el("button", { class: "btn danger", text: "Delete", onclick: deleteStory })));
}
function renderSceneCard(x) {
  const s = storyCur, sc = x.sc, d = document.getElementById("sc-" + sc.id); if (!d) return;
  const imgs = sc.images || [], cur = storyPick(sc), pend = storyPending(s.id, sc.id);
  d.innerHTML = "";
  d.classList.toggle("wide", !!sc.wide);
  d.append(...[el("div", { class: "stimg" },
      cur ? el("img", { src: thumbUrl(cur.image, 1024), loading: "lazy", alt: "", onclick: () => openReader(storyScenes(s).findIndex(y => y.sc.id === sc.id)) })
        : el("div", { class: "stph", text: pend ? "Drawing…" : "No image yet" }),
      el("span", { class: "stnum", text: x.ch.cover ? "Cover" : `${x.ci}.${x.si + 1}` })),
    imgs.length > 1 ? el("div", { class: "stvars" }, ...imgs.map((im, i) => el("button", { class: "stvar" + (i === (sc.pick || 0) ? " on" : ""), title: "Use this version",
      style: `background-image:url("${thumbUrl(im.image, 256)}")`, onclick: () => pickVersion(x, i) }))) : null,
    el("textarea", { class: "sttext", rows: "2", text: sc.text, placeholder: "Narration", onchange: (ev) => { sc.text = ev.target.value; saveStorySoon(); } }),
    el("details", {}, el("summary", { text: "Image prompt" }),
      el("textarea", { rows: "3", text: sc.prompt, onchange: (ev) => { sc.prompt = ev.target.value; saveStorySoon(); } }),
      s.level === "strip" && !x.ch.cover ? el("label", { class: "hint" }, "Clothes (set automatically by the story): ",
        el("select", { class: "stage", title: "Only change this to fix a scene; new versions use it", style: "width:auto",
          onchange: (ev) => { sc.stage = Number(ev.target.value); saveStorySoon(); } },
          ...["👗 Dressed", "👚 Undressing", "👙 Underwear", "Nude"].map((t, i) => el("option", { value: i, text: t, selected: i === (sc.stage || 0) ? "" : null })))) : null),
    el("div", { class: "inline" },
      el("button", { class: "btn sm", text: "↻", title: "Draw another version of this scene", onclick: () => drawStory(sc.id) }),
      el("button", { class: "btn sm", text: sc.wide ? "▭ Landscape" : "▯ Portrait", title: "Switch between portrait and landscape for new versions",
        onclick: () => { sc.wide = !sc.wide; saveStorySoon(); renderSceneCard(x); } }),
      pend ? el("span", { class: "hint", text: `${pend} in progress` }) : null)].filter(Boolean));
}
async function pickVersion(x, i) {
  try { const sc = await post("/lora-lab/story/pick", { id: storyCur.id, scene: x.sc.id, pick: i }); x.sc.pick = sc.pick; renderSceneCard(x); }
  catch (err) { toast(storyError(err, "Couldn't pick that version")); }
}
async function deleteStory() {
  const s = storyCur;
  if (!confirm(`Delete the story "${s.title}"? Its images stay in the output folder.`)) return;
  try { await post("/lora-lab/story/delete", { id: s.id }); } catch (err) { return toast(storyError(err, "Couldn't delete")); }
  storyCur = null; renderStoryTab();
}
async function downloadStory() {
  const s = storyCur, pages = storyScenes(s).filter(x => storyPick(x.sc)), files = [];
  toast(`Packing ${pages.length} images…`, true);
  for (const [i, x] of pages.entries()) {
    try { const r = await fetch(imgUrl(storyPick(x.sc).image)); if (r.ok) files.push({ name: `${String(i + 1).padStart(3, "0")}.png`, data: new Uint8Array(await r.arrayBuffer()) }); }
    catch {}
  }
  if (!files.length) return toast("None of these images are in the output folder any more.");
  const a = el("a", { href: URL.createObjectURL(zipBlob(files)), download: `${s.title.replace(/[\\/:*?"<>|]+/g, "_")} ${files.length}p.zip` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// 📖 Reader: one scene per page, picked version, with its narration; chapter titles on a chapter's first page.
let readerPos = 0;
const readerPages = () => storyCur ? storyScenes(storyCur).filter(x => storyPick(x.sc)) : [];
function openReader(sceneIndex) {
  const all = storyCur ? storyScenes(storyCur) : [], pages = readerPages();
  if (!pages.length) return;
  readerPos = Math.max(0, pages.indexOf(all[sceneIndex] && pages.find(p => p.sc.id === all[sceneIndex].sc.id)));
  $("stReader").classList.add("on"); showReader();
}
function showReader() {
  const pages = readerPages(); if (!pages.length) return;
  readerPos = (readerPos + pages.length) % pages.length;
  const x = pages[readerPos], first = x.si === 0;
  $("stPage").innerHTML = "";
  $("stPage").append(el("img", { src: imgUrl(storyPick(x.sc).image), alt: "" }),
    el("div", { class: "stcap" },
      first ? el("b", { text: x.ch.cover ? storyCur.title : x.ch.title }) : null,
      x.ch.cover ? null : el("p", { text: x.sc.text }),
      el("span", { class: "hint", text: `${readerPos + 1} / ${pages.length}` })));
}
$("stRPrev").onclick = () => { readerPos--; showReader(); };
$("stRNext").onclick = () => { readerPos++; showReader(); };
$("stRX").onclick = () => $("stReader").classList.remove("on");
document.addEventListener("keydown", (ev) => {
  if (!$("stReader").classList.contains("on")) return;
  if (ev.key === "ArrowRight" || ev.key === " ") { ev.preventDefault(); readerPos++; showReader(); }
  else if (ev.key === "ArrowLeft") { readerPos--; showReader(); }
  else if (ev.key === "Escape") $("stReader").classList.remove("on");
});
$("stNew").onclick = openStoryForm;
$("stCancelForm").onclick = () => { $("stForm").style.display = "none"; };
$("stWrite").onclick = writeStory;
$("stVideo").onclick = () => $("stVideoFile").click();
$("stVideoFile").onchange = (ev) => storyFromVideo(ev.target.files[0]);

// 💡 One line ("date at the beach between mia and leo"): the characters it names become the cast in the order
// they are named, the line becomes the premise, and the story is written (and drawn) with the New story defaults.
function castFromIdea(text) {
  const t = text.toLowerCase(), at = (n) => {
    const m = new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").exec(t);
    return m ? m.index : Infinity;
  };
  return chars.map(c => ({ c, pos: Math.min(at(c.name.toLowerCase().trim()), at(c.name.toLowerCase().trim().split(/\s+/)[0])) }))
    .filter(x => x.pos < Infinity).sort((a, b) => a.pos - b.pos).map(x => x.c);
}
$("stIdeaGo").onclick = async () => {
  const idea = $("stIdea").value.trim();
  if (!idea) return toast("Write the idea first, e.g. date at the beach between mia and leo");
  if (storyWriting) return toast("A story is being written; wait for it to finish.");
  const cast = castFromIdea(idea);
  if (!cast.length) return toast(chars.length ? `Name one of your characters in the idea: ${chars.map(c => c.name).join(", ")}` : "Make a character first (Characters tab).");
  openStoryForm();
  $("stChar").value = cast[0].id; $("stCostar").value = cast[1] ? cast[1].id : "";
  $("stLevel").value = $("stIdeaLevel").value; $("stPremise").value = idea;
  await writeStory();
  if (!storyCur || storyCur.premise !== idea) return;
  $("stIdea").value = "";
  if ($("stIdeaDraw").checked && storyScenes(storyCur).length) drawStory();
};
$("stIdea").addEventListener("keydown", (ev) => { if (ev.key === "Enter") $("stIdeaGo").click(); });

// ---------- game story ----------
// The script of a game, text only: six parts, each written by the prompt writer with the other parts as context and
// shown as Markdown you can edit. Saved on the ComfyUI PC (user/default/lora-lab-games). Writing goes on in the
// background when you leave the game, so the game being written stays one object (gameJob.g) until it's done.
const GAME_PARTS = [["overview", "Overview"], ["world", "World"], ["characters", "Characters"], ["plot", "Main story"], ["quests", "Quests"], ["dialogue", "Dialogue"]];
let games = [], gameCur = null, gameJob = null, gameSaveTimer = null;   // gameJob: { g, key, note, stop } while the writer is busy
const gameError = (err, what) => ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable Game Story." : `${what}: ${err.message}`;
const gameWritten = (g) => GAME_PARTS.filter(([k]) => g.parts[k]).length;
// Part names become "## " headings, so the headings inside a part move one level down.
const gameMarkdown = (g) => `# ${g.title}\n\n` + GAME_PARTS.filter(([k]) => g.parts[k]).map(([k, name]) => `## ${name}\n\n${g.parts[k].replace(/^#/gm, "##")}\n`).join("\n");
const saveGame = (g) => post("/lora-lab/game", g).catch((err) => toast(gameError(err, "Couldn't save the game")));
function saveGameSoon() {
  const g = gameCur;
  clearTimeout(gameSaveTimer);
  gameSaveTimer = setTimeout(() => { gameSaveTimer = null; saveGame(g); }, 800);
}

async function loadGames() {
  try { games = await api("/lora-lab/games?workspace=" + mode); }
  catch (err) { games = []; return $("gmList").replaceChildren(el("div", { class: "hint", text: gameError(err, "Couldn't load the games") })); }
  renderGameList();
}
function renderGameTab() {
  $("gmView").style.display = gameCur ? "" : "none";
  $("gmList").style.display = gameCur ? "none" : "";
  $("gmNew").style.display = gameCur ? "none" : "";
  if (gameCur) renderGameView(); else loadGames();
}
function renderGameList() {
  const box = $("gmList"); box.innerHTML = "";
  if (!games.length) box.append(el("div", { class: "hint", text: "No games yet. Press ＋ New game and say what the game is about." }));
  for (const g of games) box.append(el("div", { class: "card gmcard", onclick: () => openGame(g.id) },
    el("b", { text: g.title }), el("span", { text: `${g.genre ? g.genre + " · " : ""}${g.written}/${GAME_PARTS.length} parts written` }),
    g.idea ? el("p", { text: g.idea }) : null));
}
async function openGame(id) {
  if (gameJob && gameJob.g.id === id) gameCur = gameJob.g;
  else try { gameCur = await api("/lora-lab/game?id=" + encodeURIComponent(id)); }
  catch (err) { return toast(gameError(err, "Couldn't open the game")); }
  $("gmForm").style.display = "none";
  renderGameTab();
}
async function closeGame() {
  const g = gameCur;
  gameCur = null; stopRpgWatch();
  if (gameSaveTimer) { clearTimeout(gameSaveTimer); gameSaveTimer = null; await saveGame(g); }   // so the list shows the last edits
  renderGameTab();
}
async function newGame() {
  if (gameJob) return toast(`"${gameJob.g.title}" is still being written; wait for it to finish.`);
  $("gmWrite").disabled = true;
  try {
    gameCur = await post("/lora-lab/game", { workspace: mode === "general" ? "general" : "adult", idea: $("gmIdea").value,
      genre: $("gmGenre").value, tone: $("gmTone").value, size: $("gmSize").value, cast: pickedCast("gm") });
  } catch (err) { $("gmStatus").textContent = gameError(err, "Couldn't start the game"); return; }
  finally { $("gmWrite").disabled = false; }
  $("gmForm").style.display = "none"; $("gmIdea").value = "";
  renderGameTab();
  writeGameParts();
}
// ✍ Every part that is still empty, in order, or only one (↻ Rewrite). One call per part.
async function writeGameParts(only) {
  const g = gameCur;
  if (gameJob) return toast(`"${gameJob.g.title}" is still being written; wait for it to finish.`);
  const todo = GAME_PARTS.filter(([k]) => only ? k === only : !g.parts[k]), job = gameJob = { g, key: "", note: "", stop: false };
  const show = (key) => { if (gameCur === g) { renderGamePart(key); renderGameHead(); } };
  let failed = "";
  try {
    for (const [i, [key, name]] of todo.entries()) {
      if (job.stop) break;
      job.key = key;
      job.note = `✍ Writing ${name}${todo.length > 1 ? ` (part ${i + 1} of ${todo.length})` : ""}… the writer runs on this PC; a part takes one to three minutes.`;
      show(key);
      const r = await post("/lora-lab/game/write", { game: g, part: key, model: $("llmModel").value });
      g.parts[key] = r.text;
      if (r.title && g.title === "Untitled game") g.title = r.title;
      await post("/lora-lab/game", g);
      job.key = "";
      show(key);
    }
    if (!job.stop) toast(only ? "Rewritten" : `"${g.title}" is written. ⬇ Download saves it as one text file.`, true);
  } catch (err) { failed = gameError(err, "Writing stopped") + (only ? "" : " — press ✍ Write missing parts to go on."); toast(failed); }
  finally {
    gameJob = null;
    if (job.key) show(job.key); else if (gameCur === g) renderGameHead();
    if (gameCur === g && $("gmNote")) $("gmNote").textContent = failed;
  }
}
function renderGameView() {
  const g = gameCur, box = $("gmView"); if (!g) return;
  box.innerHTML = "";
  box.append(el("div", { class: "sthead", id: "gmHead" }), el("div", { class: "hint", id: "gmNote", style: "margin-bottom:12px" }));
  for (const [key] of GAME_PARTS) box.append(el("div", { class: "card gmpart", id: "gm-" + key }));
  box.append(el("div", { class: "card", id: "gm-art" }), el("div", { class: "card", id: "gm-rpg" }));
  for (const [key] of GAME_PARTS) renderGamePart(key);
  renderGameHead(); renderGameArt(); renderGameRpg();
  if (!(g.rpg && g.rpg.project)) startRpgWatch(g);
}
function renderGameHead() {
  const g = gameCur, h = $("gmHead"); if (!g || !h) return;
  const job = gameJob && gameJob.g === g ? gameJob : null, n = gameWritten(g);
  h.innerHTML = "";
  h.append(
    el("button", { class: "btn sm", text: "← Games", onclick: closeGame }),
    el("input", { type: "text", class: "sttitle", value: g.title, maxlength: "120", onchange: (ev) => { g.title = ev.target.value.trim() || g.title; saveGameSoon(); } }),
    el("div", { class: "stinfo", text: [g.genre, g.tone, `${g.size} game`, `${n}/${GAME_PARTS.length} parts written`].filter(Boolean).join(" · ") }),
    (g.cast || []).length ? el("div", { class: "stinfo", text: "" + g.cast.map(c => c.name + (c.player ? " (player)" : "")).join(", ") }) : null,
    g.idea ? el("div", { class: "stinfo hint", text: g.idea }) : null,
    el("div", { class: "inline stbtns" },
      !job && n < GAME_PARTS.length ? el("button", { class: "btn primary", text: "Write missing parts", onclick: () => writeGameParts() }) : null,
      job ? el("button", { class: "btn", text: job.stop ? "Stopping after this part…" : "⏹ Stop", disabled: job.stop ? "" : null, onclick: () => { job.stop = true; renderGameHead(); } }) : null,
      n ? el("button", { class: "btn", text: "Art", title: "Pictures for the game, made from the story", onclick: () => $("gm-art").scrollIntoView({ behavior: "smooth" }) }) : null,
      el("button", { class: "btn", text: "RPG Maker", title: "Build the game into an RPG Maker MV / MZ project", onclick: () => $("gm-rpg").scrollIntoView({ behavior: "smooth" }) }),
      n ? el("button", { class: "btn", text: "Copy all", onclick: () => copyGameText(gameMarkdown(g)) }) : null,
      n ? el("button", { class: "btn", text: "⬇ Download", title: "The whole game story as one Markdown (.md) text file", onclick: downloadGame }) : null,
      el("button", { class: "btn danger", text: "Delete", onclick: deleteGame })));
  $("gmNote").textContent = job ? job.note : "";
}
function renderGamePart(key) {
  const g = gameCur, d = $("gm-" + key); if (!g || !d) return;
  const busy = gameJob && gameJob.g === g && gameJob.key === key, name = GAME_PARTS.find(p => p[0] === key)[1];
  const ta = el("textarea", { text: g.parts[key], readonly: busy ? "" : null, placeholder: busy ? "Being written…" : "Not written yet.",
    oninput: () => { g.parts[key] = ta.value; saveGameSoon(); } });
  d.innerHTML = "";
  d.append(el("div", { class: "h" }, el("span", { text: name + (busy ? " · ✍ being written…" : "") }),
    el("span", { class: "inline" },
      el("button", { class: "btn sm", text: "Copy", onclick: () => copyGameText(ta.value) }),
      busy ? null : el("button", { class: "btn sm", text: g.parts[key] ? "↻ Rewrite" : "Write", title: "The AI writes this part again, keeping it in line with the other parts",
        onclick: () => { if (!ta.value.trim() || confirm(`Rewrite "${name}"? Its current text is replaced.`)) writeGameParts(key); } }))), ta);
  ta.style.height = Math.min(640, ta.scrollHeight + 2) + "px";
}
// 🎞 Video describer: frames are taken in the browser (videoFrames), JoyCaption describes each and the writer sums the
// video up. Any moment, or the whole description, goes to the idea box and through ✨ Write, ready to Generate.
function showVideo(on) {
  $("vidBox").style.display = on ? "" : "none";
  for (const c of document.querySelectorAll('.chip[data-go="vid"]')) c.classList.toggle("on", on);
}
function vidToPrompt(text) {
  $("idea").value = text;
  $("composer").classList.add("ideaopen");
  for (const c of document.querySelectorAll('.chip[data-go="idea"]')) c.classList.add("on");
  $("dolphinBtn").click();
}
$("vidOff").onclick = () => showVideo(false);
$("vidPick").onclick = () => $("vidFile").click();
$("vidSumUse").onclick = () => { const t = $("vidSummary").value.trim(); if (t) vidToPrompt(t.split(/\n\s*Key moments:/i)[0].trim()); };
$("vidFile").onchange = async (ev) => {
  const file = ev.target.files[0], st = $("vidStatus"), list = $("vidMoments");
  if (!file) return;
  $("vidPick").disabled = true; list.replaceChildren();
  $("vidSummary").style.display = $("vidSumRow").style.display = "none";
  try {
    const frames = await videoFrames(file, n => { st.textContent = `🎞 Taking frames… ${n}/${VIDEO_FRAMES}`; });
    st.textContent = `🎞 Watching ${frames.length} frames and describing the video…`;
    const r = await post("/lora-lab/video/describe", { frames, model: $("llmModel").value, sfw: mode === "general" });
    $("vidSummary").value = r.summary;
    $("vidSummary").style.display = $("vidSumRow").style.display = "";
    const thumb = Object.fromEntries(frames.map(f => [f.time, f.image]));
    for (const m of r.moments) {
      const row = document.createElement("div"); row.className = "inline"; row.style.cssText = "margin-top:6px;align-items:flex-start;gap:8px";
      const img = document.createElement("img"); img.alt = ""; img.style.cssText = "width:96px;border-radius:6px;flex:none";
      if (thumb[m.time]) img.src = "data:image/jpeg;base64," + thumb[m.time];
      const txt = document.createElement("div"); txt.className = "hint"; txt.style.cssText = "flex:1;margin:0";
      txt.textContent = `${Math.floor(m.time / 60)}:${String(Math.floor(m.time % 60)).padStart(2, "0")} — ${m.text}`;
      const b = document.createElement("button"); b.className = "btn sm"; b.textContent = "→ Prompt"; b.title = "Let the AI write a prompt from this moment";
      b.onclick = () => vidToPrompt(m.text);
      row.append(img, txt, b); list.append(row);
    }
    st.textContent = "Done: press → Prompt on the description or a moment, then Generate.";
  } catch (err) {
    st.textContent = "";
    toast(ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable the video describer." : err.message);
  } finally { $("vidPick").disabled = false; $("vidFile").value = ""; }
};
// execCommand also works over plain http on the LAN, where navigator.clipboard is missing.
async function copyText(text) {
  try { if (navigator.clipboard) { await navigator.clipboard.writeText(text); return true; } } catch {}
  const ta = el("textarea", { text }); document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch {}
  ta.remove(); return ok;
}
function copyGameText(text) {
  const ta = el("textarea", { text }); document.body.append(ta); ta.select();
  const ok = document.execCommand("copy"); ta.remove();
  toast(ok ? "Copied" : "Couldn't copy; use ⬇ Download instead", ok);
}
function downloadGame() {
  const g = gameCur, a = el("a", { href: URL.createObjectURL(new Blob([gameMarkdown(g)], { type: "text/markdown" })), download: `${g.title.replace(/[\\/:*?"<>|]+/g, "_")}.md` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function deleteGame() {
  const g = gameCur;
  if (gameJob && gameJob.g === g) return toast("It is still being written: press ⏹ Stop and wait for the part to finish.");
  if (!confirm(`Delete the game story "${g.title}"?`)) return;
  clearTimeout(gameSaveTimer); gameSaveTimer = null;
  try { await post("/lora-lab/game/delete", { id: g.id }); } catch (err) { return toast(gameError(err, "Couldn't delete")); }
  gameCur = null; renderGameTab();
}
// New game / novel: tick your own characters to put them in the story; one of them can be the player or main character.
// p is the form's id prefix: "gm" (Game Story) or "nv" (Novel).
function renderCastPicker(p) {
  const box = $(p + "Chars"), list = wsChars(), was = new Set([...box.querySelectorAll("input:checked")].map(i => i.value));
  box.innerHTML = "";
  if (!list.length) box.append(el("div", { class: "hint", text: "No characters in this workspace yet (Characters tab)." }));
  for (const c of list) box.append(el("label", { class: "gmchar" },
    el("input", { type: "checkbox", value: c.id, checked: was.has(c.id) ? "" : null, onchange: () => renderCastLead(p) }),
    el("img", { src: charThumb(c), alt: "", loading: "lazy" }), el("span", { text: c.name })));
  renderCastLead(p);
}
function renderCastLead(p) {
  const ids = [...$(p + "Chars").querySelectorAll("input:checked")].map(i => i.value), sel = $(p + "Player"), cur = sel.value;
  sel.innerHTML = "";
  sel.append(el("option", { value: "", text: "— someone the AI invents —" }), ...ids.map(id => el("option", { value: id, text: chars.find(c => c.id === id).name })));
  sel.value = ids.includes(cur) ? cur : "";
  $(p + "PlayerRow").style.display = ids.length ? "" : "none";
}
function pickedCast(p) {
  const lead = $(p + "Player").value;
  return [...$(p + "Chars").querySelectorAll("input:checked")].map(i => chars.find(c => c.id === i.value)).filter(Boolean).map(c => ({
    id: c.id, name: c.name, sex: splitTags(c.appearance).map(normTag).find(x => /^1(girl|boy)$/.test(x)) || "",
    about: [c.memory, c.appearance ? "Look (image tags): " + c.appearance : ""].filter(Boolean).join(" ").slice(0, 600), player: c.id === lead }));
}
$("gmNew").onclick = () => { $("gmStatus").textContent = ""; $("gmForm").style.display = ""; renderCastPicker("gm"); $("gmIdea").focus(); };
$("gmCancel").onclick = () => { $("gmForm").style.display = "none"; };
$("gmWrite").onclick = newGame;

// ---------- manga ----------
// A black-and-white manga. The writer plans it (everyone's look as tags, one line per page), then writes each page as
// 3-6 panels (shot, who is in it, the picture, narration, dialogue); every panel gets a tag prompt from the prompt writer
// and is drawn with the model and  on the right. The page is put together here: a panel layout, each picture
// cropped into its panel and the words lettered in speech bubbles you can drag. Downloads as PNG pages, PDF or CBZ.
// Saved on the ComfyUI PC (user/default/lora-lab-manga); panel pictures only change through /manga/image and /manga/drop.
let mangas = [], mangaCur = null, mangaJob = null, mangaSaveTimer = null;   // mangaJob: { m, note, stop } while the writer is busy
const MG_W = 1000, MG_H = 1414, MG_M = 44, MG_G = 14;   // page, margin and gutter in page units (B5 proportions)
// Panel layouts per panel count, in reading order, as [x, y, w, h] of the page inside its margins (left to right;
// right-to-left pages are mirrored).
const MG_LAYOUTS = {
  1: [[[0, 0, 1, 1]]],
  2: [[[0, 0, 1, .45], [0, .45, 1, .55]], [[0, 0, .5, 1], [.5, 0, .5, 1]]],
  3: [[[0, 0, 1, .4], [0, .4, .5, .6], [.5, .4, .5, .6]], [[0, 0, 1, .33], [0, .33, 1, .34], [0, .67, 1, .33]],
    [[0, 0, .5, .55], [.5, 0, .5, .55], [0, .55, 1, .45]]],
  4: [[[0, 0, 1, .3], [0, .3, .55, .38], [.55, .3, .45, .38], [0, .68, 1, .32]], [[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]],
    [[0, 0, .6, .5], [.6, 0, .4, .5], [0, .5, .4, .5], [.4, .5, .6, .5]]],
  5: [[[0, 0, .5, .32], [.5, 0, .5, .32], [0, .32, 1, .34], [0, .66, .5, .34], [.5, .66, .5, .34]],
    [[0, 0, 1, .38], [0, .38, .33, .3], [.33, .38, .34, .3], [.67, .38, .33, .3], [0, .68, 1, .32]]],
  6: [[[0, 0, .5, .33], [.5, 0, .5, .33], [0, .33, .5, .34], [.5, .33, .5, .34], [0, .67, .5, .33], [.5, .67, .5, .33]],
    [[0, 0, .6, .33], [.6, 0, .4, .33], [0, .33, .4, .34], [.4, .33, .6, .34], [0, .67, .6, .33], [.6, .67, .4, .33]]],
};
// Each panel is drawn at the size (about one megapixel) closest to its shape, then cropped into it.
const MG_SIZES = [[1024, 1024], [1152, 896], [896, 1152], [1216, 832], [832, 1216], [1344, 768], [768, 1344], [1536, 640], [640, 1536]];
const MG_TAGS = "monochrome, greyscale, screentone, high contrast, sharp lineart";
const MG_NEG = "color, colorful, multicolored, comic, 4koma, multiple views, speech bubble, text, english text, sound effects, watermark, signature, border";
const MG_PHOTO = "Black-and-white manga art: ink lines and screentone shading, high contrast. One single picture with no text and no speech bubbles.";
const MG_SHOTS = /\b(very wide shot|wide shot|full body|cowboy shot|upper body|portrait|close-up|from above|from below|from side|from behind|pov|dutch angle)\b/g;
const MG_FONT = '"Comic Sans MS", "Comic Neue", "Segoe Print", sans-serif';
const MG_KINDS = { speech: "Says", thought: "Thinks", shout: "Shouts", whisper: "Whispers" };
// Same words as llm.py's _MANGA_ADULT, which makes the writer explicit.
const MG_ADULT = /18\+|hentai|erotic|smut|nsfw|porn|lewd|explicit/i;
const MG_ADULT_GENRES = ["Hentai (18+)", "Erotic romance (18+)", "Erotic fantasy (18+)", "Office affair (18+)"];
const mgKey = () => Math.random().toString(16).slice(2, 10);
const mgPick = (p) => p.images.length ? p.images[Math.min(p.pick || 0, p.images.length - 1)] : null;
const mgNewPanel = () => ({ key: mgKey(), shot: "", count: "", idea: "", caption: "", captionAt: null, dialogue: [], prompt: "", images: [], pick: 0, focus: { x: .5, y: .3 } });
const mgClamp = (v, lo, hi) => lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v));
const mangaError = (err, what) => ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable Manga." : `${what}: ${err.message}`;
const saveManga = (m) => post("/lora-lab/manga", m).catch((err) => toast(mangaError(err, "Couldn't save the manga")));
function saveMangaSoon(m) { clearTimeout(mangaSaveTimer); mangaSaveTimer = setTimeout(() => { mangaSaveTimer = null; saveManga(m); }, 800); }
const mgPending = (m, key) => batches.filter(b => b.manga && b.manga.id === m.id).flatMap(b => b.cells)
  .filter(x => x.manga && (!key || x.manga.key === key) && !x.image && x.pid && (x.status === "queued" || x.status === "running")).length;

function mgRects(m, pg) {
  if (!pg.panels.length) return [];
  const opts = MG_LAYOUTS[Math.min(6, pg.panels.length)], lay = opts[(pg.layout || 0) % opts.length];
  const cw = MG_W - 2 * MG_M, ch = MG_H - 2 * MG_M, g = MG_G / 2;
  return lay.map(([x, y, w, h]) => {
    if (m.rtl) x = 1 - x - w;
    const x0 = MG_M + x * cw + (x > .001 ? g : 0), y0 = MG_M + y * ch + (y > .001 ? g : 0);
    const x1 = MG_M + (x + w) * cw - (x + w < .999 ? g : 0), y1 = MG_M + (y + h) * ch - (y + h < .999 ? g : 0);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  });
}
const mgSize = (r) => MG_SIZES.reduce((a, s) => Math.abs(Math.log(s[0] / s[1] * r.h / r.w)) < Math.abs(Math.log(a[0] / a[1] * r.h / r.w)) ? s : a);

// Who is in a panel: everyone in the cast or in "Characters and how they look" whose first name its picture mentions.
// Your own characters bring their look (and LoRAs, through buildGraph); everyone else their look tags from the plan.
function mgPeople(m, p) {
  const text = ` ${p.idea} `.toLowerCase(), people = [], first = (n) => n.trim().split(/\s+/)[0].toLowerCase();
  const named = (n) => first(n).length > 1 && new RegExp(`\\b${first(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
  for (const c of m.cast) {
    const own = c.id ? wsChars().find(x => x.id === c.id) : null;
    if (named(c.name)) people.push({ name: c.name, own, tags: own ? own.appearance || "" : "" });
  }
  for (const line of (m.looks || "").split("\n")) {
    const mm = line.replace(/^[-*•\s]+/, "").match(/^([^:]{1,60}):\s*(.+)$/);
    if (!mm || !named(mm[1])) continue;
    const have = people.find(x => first(x.name) === first(mm[1]));
    if (!have) people.push({ name: mm[1].trim(), own: null, tags: mm[2] }); else if (!have.own) have.tags = mm[2];
  }
  return people;
}
// The writer sometimes leaves "People" empty: count the girls and boys it names instead.
function mgCount(m, p) {
  if (p.count) return p.count;
  const people = mgPeople(m, p), n = (re) => people.filter(x => re.test(splitTags(x.tags).map(normTag).join(","))).length;
  const girls = n(/\b1girl\b/), boys = n(/\b1boy\b/), tag = (k, w) => k ? (k === 1 ? `1${w}` : `${k}${w}s`) : "";
  return joinTags([tag(girls, "girl"), tag(boys, "boy")]);
}
function mgPrompt(m, p, people) {
  if (isPhotoEngine(S.engine)) return [MG_PHOTO, p.shot ? `Shot: ${p.shot}.` : "", p.prompt || p.idea,
    ...people.filter(x => !x.own && x.tags).map(x => `${x.name} looks like: ${x.tags}.`)].filter(Boolean).join(" ");
  const count = mgCount(m, p), list = splitTags(count).map(normTag);
  return joinTags([MG_TAGS, m.style, count, list.includes("1girl") && list.includes("1boy") ? "couple" : "",
    [...new Set((p.shot || "").toLowerCase().match(MG_SHOTS) || [])].join(", "),
    splitTags(p.prompt || p.idea).filter(t => !COUNT_TAG.test(normTag(t)) && !/^(male|female) focus$/.test(normTag(t))).join(", ")]);
}
function mgGraph(m, p, seed, size, prefix) {
  const people = mgPeople(m, p), lead = people.find(x => x.own);
  const others = people.filter(x => x !== lead).map(x => splitTags(x.tags).filter(t => !COUNT_TAG.test(normTag(t))).join(", ")).filter(Boolean);
  const keep = { charId: S.charId, charUse: S.charUse, w: S.w, h: S.h };
  // Their usual outfit too, so a character looks the same in every panel; no face reference (it's a colour picture).
  Object.assign(S, { charId: lead ? lead.own.id : "", charUse: { appearance: true, outfit: true, loras: true, ref: false, face: false }, w: size[0], h: size[1] });
  plainGraph = true;
  try {
    const extra = selectedLoras().map(n => ({ name: n, strength: loraStrength(n) }));
    return buildGraph(null, seed, prefix, { prompt: mgPrompt(m, p, people), newLook: false, extraLoras: extra,
      cast: isPhotoEngine(S.engine) ? undefined : others, castPeople: others.length, neg: joinTags([MG_NEG, m.workspace !== "adult" ? STORY_NEG.safe : ""]) }).graph;
  } finally { Object.assign(S, keep); plainGraph = false; }
}

// ----- drawing a page: pictures cropped into their panels, then the lettering -----
const mgImgs = new Map();
function mgImage(src, cv) {
  let im = mgImgs.get(src);
  if (!im) {
    im = new Image(); im.cvs = new Set();
    im.onload = () => { for (const c of im.cvs) if (c.isConnected && c.mgRedraw) c.mgRedraw(); im.cvs.clear(); };
    im.src = src; mgImgs.set(src, im);
  }
  if (cv && !im.complete) im.cvs.add(cv);
  return im;
}
const mgLoad = (src) => new Promise((res) => { const im = mgImage(src); if (im.complete) return res(); im.addEventListener("load", res, { once: true }); im.addEventListener("error", res, { once: true }); });
function mgWrap(ctx, text, maxW) {
  const lines = []; let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const t = cur ? cur + " " + word : word;
    if (cur && ctx.measureText(t).width > maxW) { lines.push(cur); cur = word; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
// Where the words of a panel go: a dragged bubble where it was put, the rest in reading order starting from the corner
// the page is read from; narration is a box in that corner.
function mgBubbles(ctx, m, p, r) {
  const fs = Math.max(15, Math.min(23, Math.min(r.w, r.h * 1.3) * .05)), out = [];
  const slots = [[.27, .14], [.73, .24], [.27, .62], [.73, .7], [.5, .42], [.5, .86]];
  let slot = 0;
  if (p.caption) {
    const f = fs * .88, font = `italic 600 ${f}px ${MG_FONT}`;
    ctx.font = font;
    const lines = mgWrap(ctx, p.caption, Math.max(120, r.w * .42)), lh = f * 1.15;
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + f * 1.2, h = lines.length * lh + f * .8, at = p.captionAt;
    const x = at ? r.x + at.x * r.w - w / 2 : m.rtl ? r.x + r.w - w - 6 : r.x + 6, y = at ? r.y + at.y * r.h - h / 2 : r.y + 6;
    out.push({ kind: "caption", idx: "cap", lines, font, fs: f, lh, w, h, x: mgClamp(x, r.x + 3, r.x + r.w - w - 3), y: mgClamp(y, r.y + 3, r.y + r.h - h - 3) });
    slot = 1;
  }
  p.dialogue.forEach((d, i) => {
    if (!d.text.trim()) return;
    const shout = d.kind === "shout", f = shout ? fs * 1.12 : fs, font = `${shout ? 800 : 600} ${f}px ${MG_FONT}`;
    ctx.font = font;
    const lines = mgWrap(ctx, shout ? d.text.toUpperCase() : d.text, Math.max(125, r.w * .42)), lh = f * 1.15;
    const rx = Math.max(...lines.map(l => ctx.measureText(l).width)) / 2 * 1.2 + f * .75, ry = lines.length * lh / 2 * 1.25 + f * .7;
    const s = slots[Math.min(slot++, slots.length - 1)];
    const cx = d.at ? r.x + d.at.x * r.w : r.x + (m.rtl ? 1 - s[0] : s[0]) * r.w, cy = d.at ? r.y + d.at.y * r.h : r.y + s[1] * r.h;
    out.push({ kind: d.kind, idx: i, lines, font, fs: f, lh, rx, ry, cx: mgClamp(cx, r.x + rx + 4, r.x + r.w - rx - 4), cy: mgClamp(cy, r.y + ry + 4, r.y + r.h - ry - 4) });
  });
  return out;
}
function mgDrawBubble(ctx, b, r) {
  ctx.save();
  Object.assign(ctx, { lineWidth: 2.4, strokeStyle: "#000", fillStyle: "#fff", lineJoin: "round" });
  if (b.kind === "caption") {
    ctx.fillRect(b.x, b.y, b.w, b.h); ctx.strokeRect(b.x, b.y, b.w, b.h);
    Object.assign(ctx, { fillStyle: "#000", font: b.font, textAlign: "left", textBaseline: "middle" });
    b.lines.forEach((l, i) => ctx.fillText(l, b.x + b.fs * .6, b.y + b.fs * .4 + (i + .5) * b.lh));
    return ctx.restore();
  }
  const { cx, cy, rx, ry, fs } = b, tipX = cx + (r.x + r.w / 2 - cx) * .18, tipY = Math.min(cy + ry + fs * 1.7, r.y + r.h - 4);
  const ellipse = (k = 1) => { ctx.beginPath(); ctx.ellipse(cx, cy, rx * k, ry * k, 0, 0, Math.PI * 2); };
  const tail = (inset) => { ctx.beginPath(); ctx.moveTo(cx - fs * (.55 - inset), cy + ry * .6); ctx.lineTo(tipX, tipY - inset * 6); ctx.lineTo(cx + fs * (.55 - inset), cy + ry * .6); ctx.closePath(); };
  if (b.kind === "shout") {   // spiky outline, no tail
    ctx.beginPath();
    for (let k = 0; k <= 22; k++) {
      const a = k / 22 * Math.PI * 2, s = k % 2 ? 1.2 : .98;
      ctx[k ? "lineTo" : "moveTo"](cx + Math.cos(a) * rx * s, cy + Math.sin(a) * ry * s);
    }
    ctx.closePath(); ctx.lineWidth = 3; ctx.fill(); ctx.stroke();
  } else if (b.kind === "thought") {   // cloud of bumps, and a trail of little circles instead of a tail
    const n = Math.max(9, Math.round((rx + ry) / (fs * .9))), br = fs * .75;
    ctx.beginPath();
    for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2, x = cx + Math.cos(a) * rx, y = cy + Math.sin(a) * ry; ctx.moveTo(x + br, y); ctx.arc(x, y, br, 0, Math.PI * 2); }
    ctx.fill(); ctx.stroke(); ellipse(); ctx.fill();
    for (const [t, rad] of [[.35, .36], [.75, .22]]) { ctx.beginPath(); ctx.arc(cx + (tipX - cx) * t, cy + ry + br + (tipY - cy - ry) * t, fs * rad, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  } else {   // speech, or whisper with a dashed line
    if (b.kind === "whisper") ctx.setLineDash([7, 5]);
    tail(0); ctx.fill(); ctx.stroke(); ellipse(); ctx.fill(); ctx.stroke();
    ctx.setLineDash([]); tail(.12); ctx.fill();   // hides the ellipse's line where the tail joins it
  }
  Object.assign(ctx, { fillStyle: "#000", font: b.font, textAlign: "center", textBaseline: "middle" });
  b.lines.forEach((l, i) => ctx.fillText(l, cx, cy + (i - (b.lines.length - 1) / 2) * b.lh));
  ctx.restore();
}
// full: the full-size pictures (downloads); otherwise thumbnails, redrawn as they arrive.
function drawMangaPage(cv, m, pg, full) {
  const ctx = cv.getContext("2d"), rects = mgRects(m, pg), hits = [];
  ctx.setTransform(cv.width / MG_W, 0, 0, cv.width / MG_W, 0, 0);
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, MG_W, MG_H);
  if (!full) cv.mgRedraw = () => drawMangaPage(cv, m, pg, false);
  pg.panels.slice(0, 6).forEach((p, i) => {
    const r = rects[i], im = mgPick(p), img = im && mgImage(full ? imgUrl(im) : thumbUrl(im, 640), full ? null : cv);
    ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    if (img && img.complete && img.naturalWidth) {
      const sc = Math.max(r.w / img.naturalWidth, r.h / img.naturalHeight), dw = img.naturalWidth * sc, dh = img.naturalHeight * sc, f = p.focus || { x: .5, y: .3 };
      ctx.drawImage(img, r.x + (r.w - dw) * f.x, r.y + (r.h - dh) * f.y, dw, dh);
    } else {
      ctx.fillStyle = "#ececec"; ctx.fillRect(r.x, r.y, r.w, r.h);
      Object.assign(ctx, { fillStyle: "#888", font: `600 22px ${MG_FONT}`, textAlign: "center", textBaseline: "middle" });
      ctx.fillText(mgPending(m, p.key) ? "Drawing…" : im ? "Loading…" : `Panel ${i + 1}`, r.x + r.w / 2, r.y + r.h / 2);
    }
    for (const b of mgBubbles(ctx, m, p, r)) { mgDrawBubble(ctx, b, r); hits.push(Object.assign(b, { p, r })); }
    ctx.restore();
    ctx.lineWidth = 4; ctx.strokeStyle = "#000"; ctx.strokeRect(r.x, r.y, r.w, r.h);
  });
  Object.assign(ctx, { fillStyle: "#999", font: `15px ${MG_FONT}`, textAlign: "center", textBaseline: "middle" });
  ctx.fillText(String(m.pages.indexOf(pg) + 1), MG_W / 2, MG_H - MG_M / 2);
  cv.mgHits = hits;
}
// Drag a bubble (or the narration box) to move it; double-click puts it back where it goes by itself.
function mgDrag(cv, m, pg) {
  let drag = null;
  const pt = (ev) => { const b = cv.getBoundingClientRect(); return [(ev.clientX - b.left) / b.width * MG_W, (ev.clientY - b.top) / b.height * MG_H]; };
  const hit = (x, y) => [...(cv.mgHits || [])].reverse().find(h => h.kind === "caption"
    ? x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h : ((x - h.cx) / h.rx) ** 2 + ((y - h.cy) / h.ry) ** 2 <= 1);
  const place = (h, at) => { if (h.idx === "cap") h.p.captionAt = at; else h.p.dialogue[h.idx].at = at; };
  cv.onpointerdown = (ev) => {
    const [x, y] = pt(ev), h = hit(x, y);
    if (!h) return;
    const [cx, cy] = h.kind === "caption" ? [h.x + h.w / 2, h.y + h.h / 2] : [h.cx, h.cy];
    drag = { h, dx: x - cx, dy: y - cy }; cv.setPointerCapture(ev.pointerId); cv.style.cursor = "grabbing";
  };
  cv.onpointermove = (ev) => {
    const [x, y] = pt(ev);
    if (!drag) { cv.style.cursor = hit(x, y) ? "grab" : ""; return; }
    const { h, dx, dy } = drag;
    place(h, { x: mgClamp((x - dx - h.r.x) / h.r.w, 0, 1), y: mgClamp((y - dy - h.r.y) / h.r.h, 0, 1) });
    drawMangaPage(cv, m, pg, false);
  };
  cv.onpointerup = cv.onpointercancel = () => { if (drag) { drag = null; cv.style.cursor = ""; saveMangaSoon(m); } };
  cv.ondblclick = (ev) => { const h = hit(...pt(ev)); if (h) { place(h, null); drawMangaPage(cv, m, pg, false); saveMangaSoon(m); } };
}

// ----- the tab -----
function renderMangaTab() {
  $("mgView").style.display = mangaCur ? "" : "none";
  $("mgList").style.display = mangaCur ? "none" : "";
  $("mgNew").style.display = mangaCur ? "none" : "";
  if (mangaCur) renderMangaView(); else loadMangas();
}
async function loadMangas() {
  try { mangas = await api("/lora-lab/mangas?workspace=" + mode); }
  catch (err) { mangas = []; return $("mgList").replaceChildren(el("div", { class: "hint", text: mangaError(err, "Couldn't load the manga") })); }
  $("mgList").replaceChildren(...(mangas.length ? mangas.map(m => el("div", { class: "card gmcard", onclick: () => openManga(m.id) },
    m.cover ? el("img", { class: "mgcover", src: thumbUrl(m.cover, 300), alt: "", loading: "lazy" }) : null,
    el("b", { text: m.title }), el("span", { text: `${m.genre ? m.genre + " · " : ""}${m.pages} pages · ${m.drawn}/${m.panels} panels drawn` }),
    m.idea ? el("p", { text: m.idea }) : null))
    : [el("div", { class: "hint", text: "No manga yet. Press ＋ New manga and say what it's about." })]));
}
async function openManga(id) {
  if (mangaJob && mangaJob.m.id === id) mangaCur = mangaJob.m;
  else try { mangaCur = await api("/lora-lab/manga?id=" + encodeURIComponent(id)); }
  catch (err) { return toast(mangaError(err, "Couldn't open the manga")); }
  $("mgForm").style.display = "none";
  renderMangaTab();
}
async function closeManga() {
  const m = mangaCur;
  mangaCur = null;
  if (mangaSaveTimer) { clearTimeout(mangaSaveTimer); mangaSaveTimer = null; await saveManga(m); }   // so the list shows the last edits
  renderMangaTab();
}
async function newManga() {
  if (mangaJob) return toast(`"${mangaJob.m.title}" is still being written; wait for it to finish.`);
  if (!E().model) { $("mgStatus").textContent = "Pick an image model first ( on the right)."; return; }
  if (mode === "general" && MG_ADULT.test($("mgGenre").value)) { $("mgStatus").textContent = "18+ manga are made in the Adult 18+ workspace; switch to it at the top first."; return; }
  $("mgWrite").disabled = true;
  try {
    mangaCur = await post("/lora-lab/manga", { workspace: mode === "general" ? "general" : "adult", idea: $("mgIdea").value, genre: $("mgGenre").value,
      pageCount: Math.max(1, Math.min(40, Math.round(+$("mgPages").value) || 6)), rtl: $("mgDir").value === "rtl", cast: pickedCast("mg") });
  } catch (err) { $("mgStatus").textContent = mangaError(err, "Couldn't start the manga"); return; }
  finally { $("mgWrite").disabled = false; }
  $("mgForm").style.display = "none"; $("mgIdea").value = "";
  renderMangaTab();
  makeManga(mangaCur);
}
async function deleteManga(m) {
  if (!confirm(`Delete "${m.title}"? Its pictures stay in the Images tab.`)) return;
  try { await post("/lora-lab/manga/delete", { id: m.id }); } catch (err) { return toast(mangaError(err, "Couldn't delete")); }
  mangaCur = null; renderMangaTab();
}
const mgNote = (m) => { if (mangaCur === m && $("mgNote")) $("mgNote").textContent = mangaJob && mangaJob.m === m ? mangaJob.note : ""; };

// ✍ The plan when there is none, every page that has no panels yet (or only one page: ✍ Rewrite page), then a picture
// prompt for every panel without one. Keeps going when you leave the manga (mangaJob holds it).
async function writeManga(m, only) {
  const job = mangaJob = { m, note: "", stop: false }, model = $("llmModel").value;
  try {
    if (!m.outline.length) {
      job.note = "📖 Planning the story and the characters… (runs on this PC; about a minute)"; mgNote(m);
      const r = await post("/lora-lab/manga/outline", { manga: m, model });
      if (r.title && (!m.title || m.title === "Untitled manga")) m.title = r.title;
      Object.assign(m, { looks: r.looks, outline: r.outline, pages: r.outline.map(s => ({ key: mgKey(), summary: s, layout: 0, panels: [] })) });
      await saveManga(m);
      if (mangaCur === m) renderMangaView();
    }
    const todo = m.pages.map((pg, i) => i).filter(i => only != null ? i === only : !m.pages[i].panels.length);
    for (const [n, i] of todo.entries()) {
      if (job.stop) return false;
      job.note = `✍ Writing page ${i + 1}${todo.length > 1 ? ` (${n + 1} of ${todo.length})` : ""}… (about half a minute a page)`; mgNote(m);
      const r = await post("/lora-lab/manga/page", { manga: m, index: i, model }), pg = m.pages[i];
      pg.panels = r.panels.map(p => Object.assign(mgNewPanel(), p, { dialogue: p.dialogue.map(d => Object.assign({ at: null }, d)) }));
      pg.layout = Math.floor(Math.random() * MG_LAYOUTS[Math.max(1, Math.min(6, pg.panels.length))].length);
      await saveManga(m);
      if (mangaCur === m) mgRefreshPage(m, pg);
    }
    const todoPrompts = m.pages.flatMap(pg => pg.panels).filter(p => !p.prompt.trim() && p.idea.trim());
    for (const [n, p] of todoPrompts.entries()) {
      if (job.stop) return false;
      job.note = `✍ Writing the picture prompts: ${n + 1} of ${todoPrompts.length}…`; mgNote(m);
      await mgWritePrompt(m, p);
    }
    if (todoPrompts.length) await saveManga(m);
    return true;
  } catch (err) { toast(mangaError(err, "The writer stopped")); return false; }
  finally { if (mangaJob === job) mangaJob = null; if (mangaCur === m) renderMangaView(); }
}
// Tag engines: the writer picks the key tags and TIPO fills in the rest; looks come from the plan, so it leaves them out.
async function mgWritePrompt(m, p) {
  const idea = [m.style ? `Art style: ${m.style}.` : "", p.shot ? `Shot: ${p.shot}.` : "", p.idea].filter(Boolean).join(" ");
  const sfw = m.workspace !== "adult", model = $("llmModel").value;
  const scene = isPhotoEngine(S.engine) ? null : await post("/lora-lab/llm/scene", { idea, people: mgCount(m, p), target: dolphinTarget(), model, sfw, drop_looks: true })
    .catch(err => { if (ROUTE_MISSING.test(err.message)) return null; throw err; });
  const r = scene || await post("/lora-lab/llm", { idea, target: dolphinTarget(), model, sfw });
  p.prompt = (r && r.text || "").trim();
}
// ▶ Write what's missing, then draw every panel that has no picture yet.
async function makeManga(m) {
  if (mangaJob) return toast(`"${mangaJob.m.title}" is still being written; wait for it to finish.`);
  if (!E().model) return toast("Pick an image model first ( on the right).");
  if (await writeManga(m)) await drawManga(m);
}
async function rewriteMangaPage(m, i) {
  if (mangaJob) return toast(`"${mangaJob.m.title}" is still being written; wait for it to finish.`);
  if (m.pages[i].panels.length && !confirm(`Rewrite page ${i + 1}? Its panels are replaced (their pictures stay in the Images tab).`)) return;
  if (await writeManga(m, i)) await drawManga(m, null, m.pages[i]);
}
// 🎨 Draw: one panel (one more version), the panels of one page that have no picture (all of them if every one has),
// or every panel of the manga that has no picture yet.
async function drawManga(m, key, page) {
  const e = E();
  if (!e.model) return toast("No model selected ( on the right).");
  const todo = [];
  m.pages.forEach((pg, pi) => {
    if (page && pg !== page) return;
    const rects = mgRects(m, pg), all = page && pg.panels.every(p => p.images.length);
    pg.panels.slice(0, 6).forEach((p, i) => {
      if ((key ? p.key === key : all || (!p.images.length && !mgPending(m, p.key))) && (p.prompt || p.idea).trim()) todo.push({ p, r: rects[i], label: `Page ${pi + 1}, panel ${i + 1}` });
    });
  });
  if (!todo.length) return toast(key ? "Write what happens in the panel first." : "Every panel already has a picture. Use ↻ on a panel for another version.", true);
  await post("/lora-lab/llm/unload", {}).catch(() => {});   // the writer would otherwise share the GPU with the pictures
  const batch = { id: Date.now(), engine: S.engine, model: e.model, prompt: `📚 ${m.title}`, manga: { id: m.id, title: m.title }, w: 1024, h: 1024,
    steps: e.steps, cfg: e.cfg, sampler: e.sampler, scheduler: e.scheduler, seed: 0, count: 1, mode,
    cols: Array.from({ length: Math.min(6, todo.length) }, () => ({ lora: null })), cells: [] };
  for (const t of todo) batch.cells.push({ lora: null, status: "queued", seed: rand(), manga: { key: t.p.key, label: t.label } });
  batches.unshift(batch);
  renderResults();
  for (const [idx, cell] of batch.cells.entries()) {
    const graph = mgGraph(m, todo[idx].p, cell.seed, mgSize(todo[idx].r), `LoRA-Lab/manga/${safe(m.title)}`);
    try {
      const res = await post("/prompt", { prompt: graph, client_id: clientId });
      cell.pid = res.prompt_id; jobs.set(res.prompt_id, { batchId: batch.id, idx });
    } catch (err) {
      cell.status = "error"; cell.error = nodeErrorText(err.body) || err.message;
      if (idx === 0) { toast("ComfyUI rejected the job:\n" + cell.error); batch.cells.forEach((x, j) => { if (j) { x.status = "error"; x.error = "Skipped"; } }); break; }
    }
  }
  saveBatches(); updateProgress();
  if (mangaCur === m) renderMangaView();
  toast(`${todo.length} panel${todo.length === 1 ? "" : "s"} queued`, true);
}
async function stopManga(m) {
  if (mangaJob && mangaJob.m === m) mangaJob.stop = true;
  const ids = [...jobs.entries()].filter(([, j]) => { const b = batches.find(x => x.id === j.batchId); return b && b.manga && b.manga.id === m.id; }).map(([pid]) => pid);
  if (ids.length) try {
    await post("/queue", { delete: ids.filter(id => id !== runningId) });
    if (ids.includes(runningId)) await post("/interrupt", { prompt_id: runningId });
  } catch (e) { return toast("Stop failed: " + e.message); }
  for (const id of ids) { const f = findJob(id); if (f && !f.c.image) { f.c.status = "cancelled"; updateCell(f.b, f.idx); } jobs.delete(id); }
  saveBatches(); renderMangaView(); toast("Stopped", true);
}
// A finished picture becomes the panel's newest version.
function mangaImageDone(b, cell) {
  if (cell.mangaPosted || !cell.image || !cell.manga) return;
  cell.mangaPosted = true;
  post("/lora-lab/manga/image", { id: b.manga.id, key: cell.manga.key, image: cell.image, seed: cell.seed })
    .then((panel) => {
      for (const m of new Set([mangaCur, mangaJob && mangaJob.m])) {
        if (!m || m.id !== b.manga.id) continue;
        for (const pg of m.pages) {
          const p = pg.panels.find(x => x.key === panel.key);
          if (p) { p.images = panel.images; p.pick = panel.pick; if (mangaCur === m) mgRefreshPage(m, pg); }
        }
      }
    })
    .catch(() => { cell.mangaPosted = false; });
}
async function dropMangaImage(m, pg, p) {
  if (!confirm("Delete this version of the panel's picture? (The image file stays in the Images tab.)")) return;
  try { const r = await post("/lora-lab/manga/drop", { id: m.id, key: p.key, index: p.pick || 0 }); p.images = r.images; p.pick = r.pick; }
  catch (err) { return toast(mangaError(err, "Couldn't delete")); }
  mgRefreshPage(m, pg);
}

function renderMangaView() {
  const m = mangaCur; if (!m) return;
  const busy = mangaJob && mangaJob.m === m, other = mangaJob && !busy;
  const panels = m.pages.flatMap(pg => pg.panels), drawn = panels.filter(p => p.images.length).length, pend = mgPending(m);
  const names = [...new Set([...m.cast.map(c => c.name), ...(m.looks || "").split("\n").map(l => (l.replace(/^[-*•\s]+/, "").match(/^([^:]{1,60}):/) || [])[1]).filter(Boolean)])];
  const missing = !m.outline.length || m.pages.some(pg => !pg.panels.length) || panels.some(p => !p.images.length);
  $("mgView").replaceChildren(
    el("div", { class: "mgbar" },
      el("button", { class: "btn", text: "← All manga", onclick: closeManga }),
      el("input", { type: "text", class: "title", value: m.title, maxlength: "120", oninput: (ev) => { m.title = ev.target.value; saveMangaSoon(m); } }),
      busy || pend ? el("button", { class: "btn danger", text: "⏹ Stop", onclick: () => stopManga(m) }) : null,
      busy ? null : el("button", { class: "btn primary", text: !m.outline.length ? "Write and draw" : missing ? "▶ Continue" : "All drawn",
        title: "Write the pages and picture prompts that are missing, then draw every panel that has no picture", disabled: other || !missing ? "" : null, onclick: () => makeManga(m) }),
      el("button", { class: "btn", text: "⬇ PDF", title: "The whole manga as one PDF", onclick: () => downloadManga(m, "pdf") }),
      el("button", { class: "btn", text: "⬇ CBZ", title: "Comic book archive for comic reader apps (the pages as PNG)", onclick: () => downloadManga(m, "cbz") }),
      el("button", { class: "btn danger", text: "🗑", title: "Delete this manga", onclick: () => deleteManga(m) })),
    el("div", { class: "mgnote", id: "mgNote", text: busy ? mangaJob.note : pend ? `🎨 ${pend} panel${pend === 1 ? "" : "s"} still drawing (see Image Generation)` : "" }),
    el("div", { class: "row3" },
      el("div", {}, el("label", { text: "Read from" }), el("select", { onchange: (ev) => { m.rtl = ev.target.value === "rtl"; saveMangaSoon(m); renderMangaView(); } },
        el("option", { value: "rtl", text: "Right to left (like Japanese manga)", selected: m.rtl ? "" : null }), el("option", { value: "ltr", text: "Left to right", selected: m.rtl ? null : "" }))),
      el("div", {}, el("label", { text: "Extra style tags (optional)" }), el("input", { type: "text", value: m.style, maxlength: "300", placeholder: "e.g. shoujo, soft lines, retro manga",
        oninput: (ev) => { m.style = ev.target.value; saveMangaSoon(m); } })),
      el("div", {}, el("label", { text: "Progress" }), el("div", { class: "hint", style: "margin-top:8px", text: `${m.pages.length} pages · ${drawn} of ${panels.length} panels drawn` }))),
    el("details", { class: "card", style: "margin-top:12px" }, el("summary", { text: "Story plan and characters" }),
      el("label", { text: "Characters and how they look (one per line, '- Name: image tags'; used in every panel they're in)" }),
      el("textarea", { rows: "4", text: m.looks, oninput: (ev) => { m.looks = ev.target.value; saveMangaSoon(m); } }),
      el("div", { class: "hint", text: "Your own characters use their look and LoRAs from the Characters tab. What happens on each page is in the box next to its number." })),
    el("datalist", { id: "mgNames" }, names.map(n => el("option", { value: n }))),
    m.pages.length ? el("div", { class: "hint", style: "margin:4px 0 10px", text: "Drag a speech bubble on the page to move it; double-click it to put it back. Click a panel's picture to see it full size." }) : null,
    ...m.pages.map((pg, i) => mgPageBlock(m, pg, i)),
    m.outline.length ? el("button", { class: "btn", text: "＋ Add a page", onclick: () => {
      m.outline.push(""); m.pages.push({ key: mgKey(), summary: "", layout: 0, panels: [] }); saveMangaSoon(m); renderMangaView();
    } }) : null);
}
function mgPageBlock(m, pg, i) {
  const n = Math.max(1, Math.min(6, pg.panels.length)), busy = !!mangaJob;
  const cv = el("canvas", { class: "mgcanvas", width: "880", height: String(Math.round(880 * MG_H / MG_W)) });
  const block = el("div", { class: "mgpage", id: "mgp-" + pg.key },
    el("div", { class: "mgpagehead" },
      el("b", { text: `Page ${i + 1}` }),
      el("input", { type: "text", value: m.outline[i] || pg.summary || "", placeholder: "What happens on this page", style: "flex:1 1 240px;width:auto",
        oninput: (ev) => { m.outline[i] = pg.summary = ev.target.value; saveMangaSoon(m); } }),
      pg.panels.length > 1 && MG_LAYOUTS[n].length > 1 ? el("select", { title: "Panel layout", onchange: (ev) => { pg.layout = +ev.target.value; saveMangaSoon(m); drawMangaPage(cv, m, pg, false); } },
        MG_LAYOUTS[n].map((_, k) => el("option", { value: k, text: `Layout ${k + 1}`, selected: k === (pg.layout || 0) % MG_LAYOUTS[n].length ? "" : null }))) : null,
      el("button", { class: "btn sm", text: "＋ Panel", disabled: pg.panels.length >= 6 ? "" : null, onclick: () => { pg.panels.push(mgNewPanel()); saveMangaSoon(m); mgRefreshPage(m, pg); } }),
      el("button", { class: "btn sm", text: pg.panels.length ? "Rewrite page" : "Write page", disabled: busy ? "" : null, onclick: () => rewriteMangaPage(m, i) }),
      pg.panels.length ? el("button", { class: "btn sm", text: "Draw page", title: "Draw the panels without a picture (all of them when every panel has one)", onclick: () => drawManga(m, null, pg) }) : null,
      pg.panels.length ? el("button", { class: "btn sm", text: "⬇ PNG", onclick: () => downloadMangaPage(m, pg, i) }) : null,
      el("button", { class: "btn sm danger", text: "🗑", title: "Delete this page", onclick: () => {
        if (!confirm(`Delete page ${i + 1}? (Its pictures stay in the Images tab.)`)) return;
        m.pages.splice(i, 1); m.outline.splice(i, 1); saveMangaSoon(m); renderMangaView();
      } })),
    el("div", { class: "mgbody" }, cv, el("div", { class: "mgpanels" }, pg.panels.slice(0, 6).map((p, k) => mgPanelCard(m, pg, p, k, cv)))));
  drawMangaPage(cv, m, pg, false); mgDrag(cv, m, pg);
  return block;
}
function mgRefreshPage(m, pg) {
  const old = document.getElementById("mgp-" + pg.key);
  if (old) old.replaceWith(mgPageBlock(m, pg, m.pages.indexOf(pg)));
}
function mgPanelCard(m, pg, p, k, cv) {
  const changed = () => { saveMangaSoon(m); drawMangaPage(cv, m, pg, false); };
  const im = mgPick(p), pend = mgPending(m, p.key), lines = el("div", {});
  const version = (step) => { p.pick = (p.pick + step + p.images.length) % p.images.length; saveMangaSoon(m); mgRefreshPage(m, pg); };
  const renderLines = () => lines.replaceChildren(...p.dialogue.map((d, j) => el("div", { class: "mgline" },
    el("input", { type: "text", value: d.who, placeholder: "Who", list: "mgNames", oninput: (ev) => { d.who = ev.target.value; saveMangaSoon(m); } }),
    el("select", { onchange: (ev) => { d.kind = ev.target.value; changed(); } }, Object.entries(MG_KINDS).map(([v, t]) => el("option", { value: v, text: t, selected: v === d.kind ? "" : null }))),
    el("input", { type: "text", "data-k": "text", value: d.text, maxlength: "400", placeholder: "What they say", oninput: (ev) => { d.text = ev.target.value; changed(); } }),
    el("button", { class: "btn sm", text: "✕", title: "Remove this line", onclick: () => { p.dialogue.splice(j, 1); renderLines(); changed(); } }))));
  renderLines();
  return el("div", { class: "mgpanel" },
    el("div", { class: "ph" }, el("b", { text: `Panel ${k + 1}` }),
      el("input", { type: "text", value: p.shot, maxlength: "60", placeholder: "Shot: close-up, wide shot, from above…", oninput: (ev) => { p.shot = ev.target.value; saveMangaSoon(m); } }),
      el("button", { class: "btn sm danger", text: "🗑", title: "Delete this panel", onclick: () => {
        if (!confirm(`Delete panel ${k + 1}?`)) return;
        pg.panels.splice(k, 1); saveMangaSoon(m); mgRefreshPage(m, pg);
      } })),
    el("div", { class: "mgshot" },
      im ? el("img", { src: thumbUrl(im, 200), alt: "", title: "Open full size", onclick: () => window.open(imgUrl(im), "_blank") }) : null,
      el("div", { class: "v" },
        p.images.length > 1 ? el("div", {}, el("button", { class: "btn sm", text: "‹", onclick: () => version(-1) }), ` ${p.pick + 1} / ${p.images.length} `,
          el("button", { class: "btn sm", text: "›", onclick: () => version(1) })) : null,
        el("div", {}, el("button", { class: "btn sm", text: pend ? "Drawing…" : im ? "↻ Draw again" : "Draw", disabled: pend ? "" : null, onclick: () => drawManga(m, p.key) }),
          im ? el("button", { class: "btn sm", text: "This version", onclick: () => dropMangaImage(m, pg, p) }) : null),
        el("span", { text: `People: ${mgCount(m, p) || "none named"}` }))),
    el("label", { text: "What happens" }),
    el("textarea", { rows: "2", text: p.idea, oninput: (ev) => { p.idea = ev.target.value; saveMangaSoon(m); } }),
    el("label", {}, "Picture prompt ", el("button", { class: "btn sm", text: "New prompt", title: "Write the prompt again from “What happens”", disabled: mangaJob ? "" : null,
      onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try { await mgWritePrompt(m, p); saveMangaSoon(m); } catch (err) { toast(mangaError(err, "The prompt writer stopped")); }
        mgRefreshPage(m, pg);
      } })),
    el("textarea", { rows: "2", text: p.prompt, placeholder: "Written for you; edit it if a picture comes out wrong", oninput: (ev) => { p.prompt = ev.target.value; saveMangaSoon(m); } }),
    el("label", { text: "Narration box" }),
    el("input", { type: "text", value: p.caption, maxlength: "400", placeholder: "(none)", oninput: (ev) => { p.caption = ev.target.value; changed(); } }),
    el("label", { text: "Dialogue" }), lines,
    el("button", { class: "btn sm", text: "＋ Line", style: "margin-top:6px", onclick: () => { if (p.dialogue.length < 6) { p.dialogue.push({ who: "", text: "", kind: "speech", at: null }); renderLines(); } } }));
}

// ----- downloads: pages drawn at full size, as PNG, PDF (JPEG pages) or CBZ (a zip of PNG pages) -----
async function mgPageCanvas(m, pg, width) {
  await Promise.all(pg.panels.map(mgPick).filter(Boolean).map(im => mgLoad(imgUrl(im))));
  const cv = document.createElement("canvas");
  cv.width = width; cv.height = Math.round(width * MG_H / MG_W);
  drawMangaPage(cv, m, pg, true);
  return cv;
}
const mgBlob = (cv, type, q) => new Promise(res => cv.toBlob(res, type, q));
function mgSave(blob, name) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function downloadMangaPage(m, pg, i) {
  toast("Making the page…", true);
  mgSave(await mgBlob(await mgPageCanvas(m, pg, 2000), "image/png"), `${safe(m.title)}_${String(i + 1).padStart(3, "0")}.png`);
}
async function downloadManga(m, kind) {
  const pages = m.pages.filter(pg => pg.panels.length);
  if (!pages.length) return toast("No pages yet.");
  toast(`Making the ${kind.toUpperCase()}… (${pages.length} page${pages.length === 1 ? "" : "s"})`, true);
  const files = [];
  for (const [i, pg] of pages.entries()) {
    const cv = await mgPageCanvas(m, pg, kind === "pdf" ? 1400 : 2000);
    const blob = await mgBlob(cv, kind === "pdf" ? "image/jpeg" : "image/png", .9);
    files.push({ name: `${String(i + 1).padStart(3, "0")}.${kind === "pdf" ? "jpg" : "png"}`, data: new Uint8Array(await blob.arrayBuffer()), w: cv.width, h: cv.height });
  }
  mgSave(kind === "pdf" ? mgPdf(files) : mgZip(files), `${safe(m.title)}.${kind}`);
}
// A PDF with one JPEG per page (B5-sized pages).
function mgPdf(pages) {
  const enc = new TextEncoder(), parts = [], offsets = [];
  let len = 0;
  const add = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, ...body) => { offsets[n] = len; add(`${n} 0 obj\n`); body.forEach(add); add("\nendobj\n"); };
  const W = 516, H = Math.round(W * MG_H / MG_W), count = 3 + pages.length * 3;
  add("%PDF-1.4\n%âãÏÓ\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] >>`);
  pages.forEach((p, i) => {
    const n = 3 + i * 3, draw = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    obj(n + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.data.length} >>\nstream\n`, p.data, "\nendstream");
  });
  const xref = len;
  add(`xref\n0 ${count}\n0000000000 65535 f \n` + offsets.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join(""));
  add(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}
// A zip without compression (PNG and JPEG are compressed already).
const MG_CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function mgZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), h = new DataView(new ArrayBuffer(30)), c = new DataView(new ArrayBuffer(46));
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < f.data.length; i++) crc = MG_CRC[(crc ^ f.data[i]) & 255] ^ (crc >>> 8);
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(12, 0x21, true);   // date: 1 Jan 1980
    h.setUint32(14, crc, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true); h.setUint16(26, name.length, true);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    parts.push(new Uint8Array(h.buffer), name, f.data);
    central.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + f.data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: "application/zip" });
}
$("mgNew").onclick = () => {
  // The 18+ genres are only offered (and only written explicitly) in the Adult workspace.
  $("mgGenres").querySelectorAll(".r18g").forEach(o => o.remove());
  if (mode !== "general") $("mgGenres").append(...MG_ADULT_GENRES.map(g => Object.assign(document.createElement("option"), { className: "r18g", value: g })));
  $("mgStatus").textContent = ""; $("mgForm").style.display = ""; renderCastPicker("mg"); $("mgIdea").focus();
};
$("mgCancel").onclick = () => { $("mgForm").style.display = "none"; };
$("mgWrite").onclick = newManga;

// ---------- novel ----------
// A novel, text only: the writer plans it first (premise, characters, setting, a line or two per chapter), then writes
// the chapters one by one, each with the plan and the end of the chapter before it. Everything is a text box you can
// edit. Saved on the ComfyUI PC (user/default/lora-lab-novels). Writing goes on in the background when you leave the
// novel, so the novel being written stays one object (novelJob.n) until it's done.
let novels = [], novelCur = null, novelJob = null, novelSaveTimer = null;   // novelJob: { n, key, note, stop } while the writer is busy
const NOVEL_WORDS = { short: 1200, medium: 1600, long: 2000 };
const novelError = (err, what) => ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable Novel." : `${what}: ${err.message}`;
const novelWords = (n) => n.chapters.reduce((s, c) => s + (c.text.trim() ? c.text.trim().split(/\s+/).length : 0), 0);
const novelWritten = (n) => n.chapters.filter(c => c.text.trim()).length;
const novelMarkdown = (n) => `# ${n.title}\n\n` + n.chapters.filter(c => c.text.trim()).map(c => `## Chapter ${n.chapters.indexOf(c) + 1}: ${c.title}\n\n${c.text.trim()}\n`).join("\n");
const saveNovel = (n) => post("/lora-lab/novel", n).catch((err) => toast(novelError(err, "Couldn't save the novel")));
function saveNovelSoon() {
  const n = novelCur;
  clearTimeout(novelSaveTimer);
  novelSaveTimer = setTimeout(() => { novelSaveTimer = null; saveNovel(n); }, 800);
}

async function loadNovels() {
  try { novels = await api("/lora-lab/novels?workspace=" + mode); }
  catch (err) { novels = []; return $("nvList").replaceChildren(el("div", { class: "hint", text: novelError(err, "Couldn't load the novels") })); }
  renderNovelList();
}
function renderNovelTab() {
  $("nvView").style.display = novelCur ? "" : "none";
  $("nvList").style.display = novelCur ? "none" : "";
  $("nvNew").style.display = novelCur ? "none" : "";
  if (novelCur) renderNovelView(); else loadNovels();
}
function renderNovelList() {
  const box = $("nvList"); box.innerHTML = "";
  if (!novels.length) box.append(el("div", { class: "hint", text: "No novels yet. Press ＋ New novel and say what it is about." }));
  for (const n of novels) box.append(el("div", { class: "card gmcard", onclick: () => openNovel(n.id) },
    el("b", { text: n.title }), el("span", { text: `${n.genre ? n.genre + " · " : ""}${n.written}/${n.chapters} chapters · ${n.words.toLocaleString()} words` }),
    n.idea ? el("p", { text: n.idea }) : null));
}
async function openNovel(id) {
  if (novelJob && novelJob.n.id === id) novelCur = novelJob.n;
  else try { novelCur = await api("/lora-lab/novel?id=" + encodeURIComponent(id)); }
  catch (err) { return toast(novelError(err, "Couldn't open the novel")); }
  $("nvForm").style.display = "none";
  renderNovelTab();
}
async function closeNovel() {
  const n = novelCur;
  novelCur = null;
  if (novelSaveTimer) { clearTimeout(novelSaveTimer); novelSaveTimer = null; await saveNovel(n); }   // so the list shows the last edits
  renderNovelTab();
}
async function newNovel() {
  if (novelJob) return toast(`"${novelJob.n.title}" is still being written; wait for it to finish.`);
  $("nvWrite").disabled = true;
  try {
    novelCur = await post("/lora-lab/novel", { workspace: mode === "general" ? "general" : "adult", idea: $("nvIdea").value, genre: $("nvGenre").value,
      tone: $("nvTone").value, length: $("nvLength").value, pov: $("nvPov").value, cast: pickedCast("nv") });
  } catch (err) { $("nvStatus").textContent = novelError(err, "Couldn't start the novel"); return; }
  finally { $("nvWrite").disabled = false; }
  $("nvForm").style.display = "none"; $("nvIdea").value = "";
  renderNovelTab();
  writeNovel();
}
// ✍ The plan first when there is none, then every chapter that is still empty, in order (or only one: ↻ Rewrite).
async function writeNovel(only) {
  const n = novelCur;
  if (novelJob) return toast(`"${novelJob.n.title}" is still being written; wait for it to finish.`);
  const job = novelJob = { n, key: "", note: "", stop: false };
  const show = () => { if (novelCur === n) renderNovelView(); };
  let failed = "";
  try {
    if (only === "outline" || !n.chapters.length) {
      job.key = "outline";
      job.note = "✍ Planning the novel: premise, characters and every chapter… the writer runs on this PC; this takes one to three minutes.";
      show();
      const r = await post("/lora-lab/novel/outline", { novel: n, model: $("llmModel").value });
      n.outline = r.outline; n.chapters = r.chapters.map(c => ({ ...c, text: "" }));
      if (r.title && (n.title === "Untitled novel" || only === "outline")) n.title = r.title;
      Object.assign(n, await post("/lora-lab/novel", n));
      job.key = "";
    }
    const todo = only === "outline" ? [] : n.chapters.map((c, i) => i).filter(i => typeof only === "number" ? i === only : !n.chapters[i].text.trim());
    for (const [k, i] of todo.entries()) {
      if (job.stop) break;
      job.key = i;
      job.note = `✍ Writing chapter ${i + 1}: ${n.chapters[i].title}${todo.length > 1 ? ` (${k + 1} of ${todo.length})` : ""}… about ${NOVEL_WORDS[n.length] || 1600} words, three to six minutes a chapter.`;
      show();
      const r = await post("/lora-lab/novel/chapter", { novel: n, index: i, model: $("llmModel").value });
      n.chapters[i].text = r.text;
      await post("/lora-lab/novel", n);
      job.key = "";
    }
    if (!job.stop) toast(typeof only === "number" ? "Rewritten" : only === "outline" ? "New plan written" : `"${n.title}" is written: ${novelWords(n).toLocaleString()} words. ⬇ Download saves it as one text file.`, true);
  } catch (err) { failed = novelError(err, "Writing stopped") + (only === undefined ? " — press ✍ Write missing chapters to go on." : ""); toast(failed); }
  finally {
    novelJob = null;
    show();
    if (novelCur === n && $("nvNote")) $("nvNote").textContent = failed;
  }
}
function renderNovelView() {
  const n = novelCur, box = $("nvView"); if (!n) return;
  const job = novelJob && novelJob.n === n ? novelJob : null, written = novelWritten(n);
  box.innerHTML = "";
  box.append(el("div", { class: "sthead" },
    el("button", { class: "btn sm", text: "← Novels", onclick: closeNovel }),
    el("input", { type: "text", class: "sttitle", value: n.title, maxlength: "120", onchange: (ev) => { n.title = ev.target.value.trim() || n.title; saveNovelSoon(); } }),
    el("div", { class: "stinfo", text: [n.genre, n.tone, `${n.pov === "first" ? "first" : "third"} person`, `${written}/${n.chapters.length} chapters written`,
      `${novelWords(n).toLocaleString()} words`].filter(Boolean).join(" · ") }),
    (n.cast || []).length ? el("div", { class: "stinfo", text: "" + n.cast.map(c => c.name + (c.player ? " (main character)" : "")).join(", ") }) : null,
    n.idea ? el("div", { class: "stinfo hint", text: n.idea }) : null,
    el("div", { class: "inline stbtns" },
      !job && (!n.chapters.length || written < n.chapters.length) ? el("button", { class: "btn primary", text: n.chapters.length ? "Write missing chapters" : "Write novel", onclick: () => writeNovel() }) : null,
      job ? el("button", { class: "btn", text: job.stop ? "Stopping after this chapter…" : "⏹ Stop", disabled: job.stop ? "" : null, onclick: () => { job.stop = true; renderNovelView(); } }) : null,
      written ? el("button", { class: "btn", text: "Copy all", onclick: () => copyGameText(novelMarkdown(n)) }) : null,
      written ? el("button", { class: "btn", text: "⬇ Download", title: "The novel as one Markdown (.md) text file", onclick: downloadNovel }) : null,
      el("button", { class: "btn danger", text: "Delete", onclick: deleteNovel }))),
    el("div", { class: "hint", id: "nvNote", style: "margin-bottom:12px", text: job ? job.note : "" }));

  const busy = (key) => job && job.key === key;
  const outline = el("textarea", { text: n.outline, readonly: busy("outline") ? "" : null, placeholder: busy("outline") ? "Being written…" : "Not written yet.",
    oninput: () => { n.outline = outline.value; saveNovelSoon(); } });
  box.append(el("div", { class: "card gmpart" }, el("div", { class: "h" }, el("span", { text: "Plan: premise, characters, setting" + (busy("outline") ? " · ✍ being written…" : "") }),
    el("span", { class: "inline" },
      el("button", { class: "btn sm", text: "Copy", onclick: () => copyGameText(outline.value) }),
      job || written ? null : el("button", { class: "btn sm", text: n.outline ? "↻ Rewrite plan" : "Write plan", title: "A new plan and chapter list (only before any chapter is written)",
        onclick: () => { if (!n.outline.trim() || confirm("Write a new plan? The plan and the chapter list are replaced.")) writeNovel("outline"); } }))), outline));
  n.chapters.forEach((c, i) => box.append(novelChapterCard(n, c, i, job)));
  if (n.chapters.length) box.append(el("button", { class: "btn", text: "＋ Add chapter", disabled: job ? "" : null,
    onclick: () => { n.chapters.push({ title: `Chapter ${n.chapters.length + 1}`, summary: "", text: "" }); saveNovelSoon(); renderNovelView(); } }));
  for (const ta of box.querySelectorAll(".gmpart textarea.big, .gmpart > textarea")) ta.style.height = Math.min(640, ta.scrollHeight + 2) + "px";
}
function novelChapterCard(n, c, i, job) {
  const busy = job && job.key === i, words = c.text.trim() ? c.text.trim().split(/\s+/).length : 0;
  const text = el("textarea", { class: "big", text: c.text, readonly: busy ? "" : null, placeholder: busy ? "Being written…" : "Not written yet.",
    oninput: () => { c.text = text.value; saveNovelSoon(); } });
  return el("div", { class: "card gmpart" },
    el("div", { class: "h" }, el("span", { class: "inline", style: "flex:1;gap:6px" }, el("b", { text: `${i + 1}.` }),
        el("input", { type: "text", class: "nvctitle", value: c.title, maxlength: "160", onchange: (ev) => { c.title = ev.target.value.trim() || c.title; saveNovelSoon(); } }),
        el("span", { class: "hint", text: busy ? "being written…" : words ? `${words.toLocaleString()} words` : "" })),
      el("span", { class: "inline" },
        el("button", { class: "btn sm", text: "Copy", onclick: () => copyGameText(text.value) }),
        job ? null : el("button", { class: "btn sm", text: c.text ? "↻ Rewrite" : "Write", title: "The AI writes this chapter (again), following the plan and the chapter before",
          onclick: () => { if (!text.value.trim() || confirm(`Rewrite chapter ${i + 1}? Its current text is replaced.`)) writeNovel(i); } }),
        job || c.text.trim() ? null : el("button", { class: "btn sm", text: "🗑", title: "Remove this chapter from the plan",
          onclick: () => { n.chapters.splice(i, 1); saveNovelSoon(); renderNovelView(); } }))),
    el("textarea", { class: "nvsum", rows: "2", text: c.summary, placeholder: "What happens in this chapter (the writer follows it)",
      oninput: (ev) => { c.summary = ev.target.value; saveNovelSoon(); } }),
    text);
}
function downloadNovel() {
  const n = novelCur, a = el("a", { href: URL.createObjectURL(new Blob([novelMarkdown(n)], { type: "text/markdown" })), download: `${n.title.replace(/[\\/:*?"<>|]+/g, "_")}.md` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function deleteNovel() {
  const n = novelCur;
  if (novelJob && novelJob.n === n) return toast("It is still being written: press ⏹ Stop and wait for the chapter to finish.");
  if (!confirm(`Delete the novel "${n.title}"?`)) return;
  clearTimeout(novelSaveTimer); novelSaveTimer = null;
  try { await post("/lora-lab/novel/delete", { id: n.id }); } catch (err) { return toast(novelError(err, "Couldn't delete")); }
  novelCur = null; renderNovelTab();
}
$("nvNew").onclick = () => { $("nvStatus").textContent = ""; $("nvForm").style.display = ""; renderCastPicker("nv"); $("nvIdea").focus(); };
$("nvCancel").onclick = () => { $("nvForm").style.display = "none"; };
$("nvWrite").onclick = newNovel;

// ---------- character chat ----------
// Talk to a character. Each one has a sheet (how they act and what they like, an optional first message, what they
// call you, and optionally one of your characters for their picture, look and memory) and any number of chats. The
// writer learns from the chats: new messages are folded into "What they remember" (when you leave a chat, start a new
// one, every CHAT_LEARN_EVERY messages, or with 🧠 Learn now), and every chat starts from that memory. Saved on the
// ComfyUI PC (user/default/lora-lab-chat); the server adds the messages, the page only edits the sheet.
let chatChars = [], chatCur = null, chatOpen = "", chatJob = null, chatLearning = "", chatSaveTimer = null;   // chatJob: { c, chat, ctrl, text }
const CHAT_LEARN_EVERY = 20;
const chatError = (err, what) => ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable Chat." : `${what}: ${err.message}`;
const chatOwn = (c) => c && c.charId ? chars.find(x => x.id === c.charId) : null;
const chatThumb = (c) => { const own = chatOwn(c); return own ? el("img", { src: charThumb(own), alt: "" }) : el("div", { class: "chatav", text: (c.name || "?").trim().charAt(0).toUpperCase() || "?" }); };
const chatOf = (c) => c && c.chats.find(x => x.id === chatOpen);
const chatSheet = (c) => ({ id: c.id, workspace: c.workspace, name: c.name, charId: c.charId, persona: c.persona, greeting: c.greeting, you: c.you });
const saveChatChar = (body) => post("/lora-lab/chat/character", body).catch((err) => toast(chatError(err, "Couldn't save the character")));
function saveChatSoon() {
  const c = chatCur;
  clearTimeout(chatSaveTimer);
  chatSaveTimer = setTimeout(() => { chatSaveTimer = null; saveChatChar(chatSheet(c)); }, 800);
}
async function loadChatChars() {
  try { chatChars = await api("/lora-lab/chat/characters?workspace=" + mode); }
  catch (err) { chatChars = []; return $("ctList").replaceChildren(el("div", { class: "hint", text: chatError(err, "Couldn't load the chat characters") })); }
  renderChatList();
}
function renderChatTab() {
  $("ctView").style.display = chatCur ? "" : "none";
  $("ctList").style.display = chatCur ? "none" : "";
  $("ctNew").style.display = chatCur ? "none" : "";
  if (chatCur) renderChatView(); else loadChatChars();
}
function renderChatList() {
  const box = $("ctList"); box.innerHTML = "";
  if (!chatChars.length) box.append(el("div", { class: "hint", text: "No chat characters yet. Press ＋ New character, say how they act and what they like, and start talking." }));
  for (const c of chatChars) box.append(el("div", { class: "card gmcard", onclick: () => openChatChar(c.id) },
    el("div", { class: "chathead" }, chatThumb(c), el("div", { style: "min-width:0" }, el("b", { text: c.name }),
      el("div", { text: `${c.chats} chat${c.chats === 1 ? "" : "s"} · ${new Date(c.updated).toLocaleDateString()}` }))),
    c.persona ? el("p", { text: c.persona }) : null, c.last ? el("p", { class: "chatlast", text: "“" + c.last + "”" }) : null));
}
async function openChatChar(id, chatId, view) {
  if (chatJob && chatJob.c.id === id) chatCur = chatJob.c;   // still replying: keep the same object, so the reply shows up
  else try { chatCur = await api("/lora-lab/chat/character?id=" + encodeURIComponent(id)); }
  catch (err) { return toast(chatError(err, "Couldn't open the character")); }
  const newest = [...chatCur.chats].sort((a, b) => b.updated - a.updated)[0];
  chatOpen = chatId || (newest ? newest.id : "");
  chatView = view || "chat";
  $("ctForm").style.display = "none";
  renderChatTab();
  if (!chatCur.chats.length) newChat();
}
// Leaving a chat: save the sheet, and learn from what was said if there is something new.
async function leaveChat() {
  const c = chatCur;
  if (!c) return;
  if (chatSaveTimer) { clearTimeout(chatSaveTimer); chatSaveTimer = null; await saveChatChar(chatSheet(c)); }
  if (c.pending >= 2) learnChat(c, true);
}
async function closeChatChar() {
  await leaveChat();
  chatCur = null; chatOpen = "";
  renderChatTab();
}
async function newChatChar() {
  const name = $("ctName").value.trim(), own = chars.find(x => x.id === $("ctBase").value);
  if (!name && !own) { $("ctStatus").textContent = "Give them a name (or pick one of your characters)."; return $("ctName").focus(); }
  try {
    const c = await post("/lora-lab/chat/character", { workspace: mode === "general" ? "general" : "adult", name: name || own.name, charId: own ? own.id : "",
      persona: $("ctPersona").value, greeting: $("ctGreeting").value, you: $("ctYou").value });
    for (const f of ["ctName", "ctPersona", "ctGreeting"]) $(f).value = "";
    await openChatChar(c.id);
  } catch (err) { $("ctStatus").textContent = chatError(err, "Couldn't make the character"); }
}
function fillChatBase(sel, value) {
  sel.replaceChildren(el("option", { value: "", text: "— none —" }), ...wsChars().map(x => el("option", { value: x.id, text: x.name })));
  sel.value = wsChars().some(x => x.id === value) ? value : "";
}
async function newChat() {
  const c = chatCur;
  await leaveChat();
  try {
    const chat = await post("/lora-lab/chat/new", { id: c.id });
    c.chats.push(chat); chatOpen = chat.id;
  } catch (err) { return toast(chatError(err, "Couldn't start a chat")); }
  if (chatCur === c) renderChatView();
  if (chatCur === c && !chatOf(c).messages.length) $("ctInput").focus();
}
async function learnChat(c, quiet) {
  if (chatLearning) { if (!quiet) toast("Still learning from the chats; wait a moment."); return; }
  chatLearning = c.id;
  if (chatCur === c) renderChatMemory();
  try {
    const r = await post("/lora-lab/chat/learn", { id: c.id, model: $("llmModel").value });
    c.learned = r.learned; c.pending = r.pending;
    if (!quiet) toast(`${c.name} remembers what you talked about`, true);
  } catch (err) { if (!quiet || !/already learning/i.test(err.message)) toast(chatError(err, `${c.name} couldn't learn from the chats`)); }
  finally { chatLearning = ""; if (chatCur === c) renderChatMemory(); }
}
function renderChatView() {
  const c = chatCur, box = $("ctView"); if (!c) return;
  const chat = chatOf(c);
  box.innerHTML = "";
  const field = (label, node, hint) => [el("label", {}, label, hint ? el("span", { class: "hint", style: "display:inline", text: " " + hint }) : null), node];
  const base = el("select", { onchange: () => { c.charId = base.value; saveChatSoon(); renderChatView(); } });
  fillChatBase(base, c.charId);
  const sheet = el("div", { class: "card" },
    el("div", { class: "chathead" }, chatThumb(c),
      el("input", { type: "text", class: "sttitle", value: c.name, maxlength: "60", onchange: (ev) => { c.name = ev.target.value.trim() || c.name; saveChatSoon(); } })),
    ...field("How they act and what they like", el("textarea", { rows: "7", maxlength: "4000", placeholder: "e.g. Mira is a sarcastic but warm barista who loves rainy days, old sci-fi films and teasing people she likes. She talks in short, playful lines, hates being rushed, and secretly writes poetry…",
      text: c.persona, oninput: (ev) => { c.persona = ev.target.value; saveChatSoon(); } })),
    ...field("First message", el("textarea", { rows: "2", maxlength: "2000", placeholder: "What they say when a new chat starts (optional)",
      text: c.greeting, oninput: (ev) => { c.greeting = ev.target.value; saveChatSoon(); } }), "(optional)"),
    el("div", { class: "row" },
      el("div", {}, ...field("They call you", el("input", { type: "text", maxlength: "60", value: c.you || "", placeholder: "your name",
        onchange: (ev) => { c.you = ev.target.value.trim(); saveChatSoon(); } }))),
      el("div", {}, ...field("Picture and look from", base))),
    el("div", { class: "hint", text: "Changes count from the next message on." }));
  const memory = el("div", { class: "card", id: "ctMemory" });
  const list = el("div", { class: "card" }, el("div", { class: "h" }, el("span", { text: "Chats" }), el("button", { class: "btn sm primary", text: "＋ New chat", onclick: newChat })),
    el("div", { class: "charlist" }, [...c.chats].sort((a, b) => b.updated - a.updated).map(x => el("div", { class: "charitem" + (x.id === chatOpen ? " on" : ""),
      onclick: async () => { if (x.id === chatOpen) return; await leaveChat(); chatOpen = x.id; renderChatView(); } },
      el("div", { style: "min-width:0" }, el("b", { text: x.title }),
        el("div", { class: "hint", text: `${x.messages.length} messages` + (x.messages.length ? " · " + new Date(x.updated).toLocaleDateString() : "") }))))));
  const side = el("div", { class: "chatside" }, sheet, memory, list,
    el("button", { class: "btn danger", text: "Delete character", onclick: deleteChatChar }));
  const talk = el("div", { class: "card chatbox" });
  box.append(el("div", { class: "sthead" }, el("button", { class: "btn sm", text: "← Characters", onclick: closeChatChar })),
    el("div", { class: "chatwrap" }, side, talk));
  renderChatMemory();
  if (!chat) return talk.append(el("div", { class: "hint", text: "Press ＋ New chat to start talking." }));
  const story = chatView === "story";
  talk.append(el("div", { class: "chattop" },
      el("input", { type: "text", class: "chattitle", value: chat.title, maxlength: "80", title: "Rename this chat",
        onchange: (ev) => { chat.title = ev.target.value.trim() || chat.title; post("/lora-lab/chat/edit", { id: c.id, chat: chat.id, title: chat.title }).catch(() => {}); } }),
      el("button", { class: "btn sm" + (story ? "" : " primary"), text: story ? "Back to chat" : "Picture story",
        title: "Turn this chat into a short story with pictures", onclick: () => showChatStory(!story) }),
      el("button", { class: "btn sm danger", text: "Delete chat", onclick: deleteChat })),
    ...(story ? [el("div", { class: "csstory", id: "ctStory" })] : [el("div", { class: "chatlog", id: "ctLog" }),
      el("div", { class: "chatsend" },
        el("textarea", { id: "ctInput", rows: "2", maxlength: "8000", placeholder: `Message ${c.name}…  (Enter sends, Shift+Enter makes a new line)`,
          onkeydown: (ev) => { if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); sendChat(); } } }),
        el("div", { class: "chatbtns", id: "ctBtns" }))]));
  if (story) renderChatStory(); else renderChatLog(true);
}
function renderChatMemory() {
  const c = chatCur, box = $("ctMemory"); if (!c || !box) return;
  const busy = chatLearning === c.id;
  const text = el("textarea", { rows: "8", maxlength: "6000", placeholder: "Nothing yet. As you chat, they write down what they learn about you here.",
    text: c.learned || "", disabled: busy ? "" : null,
    oninput: () => { c.learned = text.value; clearTimeout(text._t); text._t = setTimeout(() => saveChatChar({ id: c.id, learned: c.learned, ...chatSheet(c) }), 800); } });
  box.replaceChildren(el("div", { class: "h" }, el("span", { text: "What they remember" }),
      el("span", { class: "inline" },
        el("button", { class: "btn sm", text: busy ? "Learning…" : "Learn now", disabled: busy || !c.pending ? "" : null,
          title: "Read the new messages of every chat and update the memory", onclick: () => learnChat(c) }),
        el("button", { class: "btn sm", text: "Forget", disabled: busy || !c.learned ? "" : null, title: "Clear the memory (the chats stay)",
          onclick: () => { if (confirm(`Make ${c.name} forget everything they learned? The chats stay.`)) { c.learned = ""; saveChatChar({ ...chatSheet(c), learned: "" }); renderChatMemory(); } } }))),
    text,
    el("div", { class: "hint", text: busy ? "Reading the chats… (runs on this PC; up to a minute or two)"
      : (c.pending ? `${c.pending} new message${c.pending === 1 ? "" : "s"} to learn from: they learn when you leave the chat, start a new one, or every ${CHAT_LEARN_EVERY} messages.`
        : "Every chat with them starts from this. You can edit it.") }));
}
// *actions* in italics; everything else as typed.
function chatText(text) {
  return text.split(/(\*[^*\n]+\*)/).filter(Boolean).map(s => /^\*[^*\n]+\*$/.test(s) ? el("em", { text: s.slice(1, -1) }) : document.createTextNode(s));
}
function chatBubble(c, chat, m, i) {
  const live = i < 0;
  return el("div", { class: "chatmsg " + (m.role === "user" ? "me" : "them") },
    m.role === "user" ? null : chatThumb(c),
    el("div", { class: "chatbub" + (live ? " live" : "") }, live && !m.text ? el("span", { class: "hint", text: `${c.name} is typing…` }) : chatText(m.text),
      live ? null : el("button", { class: "chatx", text: "✕", title: "Delete this message and everything after it",
        onclick: () => cutChat(i, `Delete this message${i < chat.messages.length - 1 ? " and the " + (chat.messages.length - 1 - i) + " after it" : ""}?`) })));
}
function renderChatLog(jump) {
  const c = chatCur, chat = chatOf(c), log = $("ctLog"); if (!chat || !log) return;
  const near = jump || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const job = chatJob && chatJob.chat === chat ? chatJob : null;
  log.replaceChildren(...chat.messages.map((m, i) => chatBubble(c, chat, m, i)), ...(job ? [chatBubble(c, chat, { role: "char", text: job.text }, -1)] : []));
  if (!chat.messages.length && !job) log.append(el("div", { class: "hint chatempty", text: `Say something to ${c.name}, or press 💬 Let them talk.` }));
  if (near) log.scrollTop = log.scrollHeight;
  const last = chat.messages[chat.messages.length - 1], other = chatJob && !job;
  $("ctBtns").replaceChildren(...[
    job ? el("button", { class: "btn", text: "⏹ Stop", title: "Stop the reply here (what's written so far is kept)", onclick: () => job.ctrl.abort() }) : null,
    !job && last && last.role === "char" && chat.messages.length > 1 ? el("button", { class: "btn", text: "↻ Retry", title: "Write the last reply again", onclick: retryChat, disabled: other ? "" : null }) : null,
    !job ? el("button", { class: "btn", text: "Let them talk", title: `${c.name} writes the next message`, onclick: () => sendChat(true), disabled: other ? "" : null }) : null,
    el("button", { class: "btn primary", text: "Send", onclick: () => sendChat(), disabled: job || other ? "" : null })].filter(Boolean));
}
async function sendChat(them) {
  const c = chatCur, chat = chatOf(c), input = $("ctInput");
  if (!chat) return;
  if (chatJob) return toast(chatJob.chat === chat ? "Still replying…" : `${chatJob.c.name} is still replying in another chat.`);
  const text = them ? "" : input.value.trim();
  if (!them && !text) return input.focus();
  const job = chatJob = { c, chat, ctrl: new AbortController(), text: "" };
  if (text) { chat.messages.push({ role: "user", text, time: Date.now() }); input.value = ""; }
  const show = (jump) => { if (chatOf(chatCur) === chat) renderChatLog(jump); };
  show(true);
  let done = null;
  try {
    const r = await fetch("/lora-lab/chat/send", { method: "POST", headers: { "Content-Type": "application/json" }, signal: job.ctrl.signal,
      body: JSON.stringify({ id: c.id, chat: chat.id, text, model: $("llmModel").value }) });
    if (!r.ok) { const b = await r.json().catch(() => null); throw new Error((b && b.error) || r.statusText); }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: end } = await reader.read();
      buf += dec.decode(value || new Uint8Array(), { stream: !end });
      let n;
      while ((n = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, n).trim(); buf = buf.slice(n + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.error) throw new Error(m.error);
        if (m.t) { job.text += m.t; show(); }
        if (m.done) done = m;
      }
      if (end) break;
    }
  } catch (err) { if (err.name !== "AbortError") toast(chatError(err, "No reply")); }
  chatJob = null;
  // The server keeps a reply that was stopped or cut off too, so the page shows it the same way.
  const reply = done && done.message ? done.message : job.text.trim() ? { role: "char", text: job.text.trim(), time: Date.now() } : null;
  if (reply) { chat.messages.push(reply); chat.updated = reply.time; }
  if (done) c.pending = done.pending; else if (reply) c.pending = (c.pending || 0) + (text ? 2 : 1);
  if (chatCur === c) { show(); renderChatMemory(); }
  if (done && done.pending >= CHAT_LEARN_EVERY) learnChat(c, true);
}
async function cutChat(keep, question) {
  const c = chatCur, chat = chatOf(c);
  if (chatJob && chatJob.chat === chat) return toast("Still replying: press ⏹ Stop first.");
  if (question && !confirm(question)) return;
  try { chat.messages = (await post("/lora-lab/chat/cut", { id: c.id, chat: chat.id, keep })).messages; }
  catch (err) { toast(chatError(err, "Couldn't change the chat")); return false; }
  c.pending = c.chats.reduce((s, x) => s + Math.max(0, x.messages.length - (x.learned || 0)), 0);
  renderChatLog(); renderChatMemory();
  return true;
}
async function retryChat() {
  const chat = chatOf(chatCur);
  if (await cutChat(chat.messages.length - 1)) sendChat(true);
}
async function deleteChat() {
  const c = chatCur, chat = chatOf(c);
  if (chatJob && chatJob.chat === chat) return toast("Still replying: press ⏹ Stop first.");
  if (!confirm(`Delete the chat "${chat.title}"?` + (c.pending ? ` ${c.name} learns from it first.` : ""))) return;
  if (c.pending) await learnChat(c, true);   // what they learned from it stays
  try { await post("/lora-lab/chat/edit", { id: c.id, chat: chat.id, delete: true }); } catch (err) { return toast(chatError(err, "Couldn't delete")); }
  c.chats = c.chats.filter(x => x !== chat);
  const newest = [...c.chats].sort((a, b) => b.updated - a.updated)[0];
  chatOpen = newest ? newest.id : "";
  if (chatCur === c) renderChatView();
}
async function deleteChatChar() {
  const c = chatCur;
  if (chatJob && chatJob.c === c) return toast("Still replying: press ⏹ Stop first.");
  if (!confirm(`Delete ${c.name} and all ${c.chats.length} of their chats? What they learned is lost too.`)) return;
  clearTimeout(chatSaveTimer); chatSaveTimer = null;
  try { await post("/lora-lab/chat/character/delete", { id: c.id }); } catch (err) { return toast(chatError(err, "Couldn't delete")); }
  chatCur = null; chatOpen = ""; renderChatTab();
}
$("ctNew").onclick = () => { $("ctStatus").textContent = ""; $("ctForm").style.display = ""; fillChatBase($("ctBase"), ""); $("ctName").focus(); };
$("ctCancel").onclick = () => { $("ctForm").style.display = "none"; };
$("ctMake").onclick = newChatChar;

// ---------- picture story: a chat retold as illustrated scenes ----------
// 🎬 in a chat: the writer reads the chat and plans a few scenes (a story caption and a picture idea each, plus how
// everyone looks), writes an image prompt per scene and they are drawn like a story: one results batch with the model,
// LoRAs and settings  on the right, and the character's own look, LoRAs and face when the chat character is
// linked to one of your characters. Each finished picture is saved into the chat (chat.story on the server).
let chatView = "chat", chatStoryJob = null;   // chatStoryJob: { c, chat, key, note, stop } while the writer plans or writes prompts
const CHAT_STORY_SIZE = [1216, 832], CHAT_STORY_NEG = "text, watermark, speech bubble, comic panels, multiple views";
const chatStoryOf = (chat) => chat.story || (chat.story = { style: "", looks: "", scenes: [] });
const chatStoryPick = (s) => s.images.length ? s.images[Math.min(s.pick || 0, s.images.length - 1)] : null;
const chatStoryPending = (chat, key) => batches.filter(b => b.chat && b.chat.chat === chat.id).flatMap(b => b.cells)
  .filter(x => x.chat && (!key || x.chat.key === key) && !x.image && x.pid && (x.status === "queued" || x.status === "running")).length;
const chatStoryBusy = () => chatStoryJob ? `The picture story of "${chatStoryJob.chat.title}" is still being written` : "";
const saveChatStory = (c, chat, body) => post("/lora-lab/chat/story/save", { id: c.id, chat: chat.id, ...body }).catch((err) => toast(chatError(err, "Couldn't save the story")));
function showChatStory(on) { chatView = on ? "story" : "chat"; renderChatView(); }

// 📖 Plan: the writer retells the chat as scenes (replaces the scenes there were; their pictures stay in the Images tab).
async function planChatStory(c, chat) {
  const job = chatStoryJob = { c, chat, key: "", note: "Reading the chat and planning the story… (runs on this PC; about a minute)", stop: false };
  if (chatOf(chatCur) === chat) renderChatStory();
  try {
    chat.story = await post("/lora-lab/chat/story/plan", { id: c.id, chat: chat.id, scenes: +store.get("chatStoryScenes", 6), style: chatStoryOf(chat).style, model: $("llmModel").value });
    return true;
  } catch (err) { toast(chatError(err, "Couldn't plan the story")); return false; }
  finally { if (chatStoryJob === job) chatStoryJob = null; if (chatOf(chatCur) === chat) renderChatStory(); }
}
// What the prompt writer gets for one scene: the style, the scene, and how everyone looks (the linked character's
// look comes from their tags, so their line is left out).
function chatStoryIdea(c, chat, s) {
  const st = chatStoryOf(chat), own = chatOwn(c), first = (c.name || "").split(/\s+/)[0].toLowerCase();
  const looks = st.looks.split("\n").filter(l => l.trim() && !(own && l.replace(/^[-*•\s]+/, "").toLowerCase().startsWith(first)));
  // The writer often leaves the character out of the looks; their sheet says how they look then.
  if (!own && c.persona && !looks.some(l => l.replace(/^[-*•\s]+/, "").toLowerCase().startsWith(first))) looks.unshift(`- ${c.name}: ${c.persona.slice(0, 400)}`);
  // Tag models get the look tags straight into the prompt (chatStoryGraph); the writer repeating them only adds clashes.
  const tagged = !isPhotoEngine(S.engine) && (own || chatStoryLookTags(c, chat, s));
  return [st.style ? `Art style: ${st.style}.` : "", `Scene: ${s.idea || s.caption}`, s.count ? `People in the picture: ${s.count}.` : "",
    tagged ? "Their hair, eyes, body and clothes are added automatically, so do not describe them." : looks.length ? "How the people in it look:\n" + looks.join("\n") : ""].filter(Boolean).join("\n\n");
}
// ✍ Prompts: every scene without one (or only one scene), one prompt-writer call each.
async function writeChatStoryPrompts(c, chat, only) {
  if (chatStoryBusy()) return toast(chatStoryBusy() + "; wait for it to finish.");
  const st = chatStoryOf(chat), todo = st.scenes.filter(s => only ? s.key === only : !s.prompt.trim());
  if (!todo.length) return true;
  const job = chatStoryJob = { c, chat, key: "", note: "", stop: false }, own = chatOwn(c);
  let failed = "";
  try {
    for (const [i, s] of todo.entries()) {
      if (job.stop) break;
      job.key = s.key;
      job.note = `✍ Writing the prompt for scene ${st.scenes.indexOf(s) + 1}${todo.length > 1 ? ` (${i + 1} of ${todo.length})` : ""}…`;
      if (chatOf(chatCur) === chat) renderChatStory();
      // Tag models: the writer picks the key tags and TIPO fills in the rest (/llm/scene); an older server has no such route.
      // Looks and clothes come from the look tags (chatStoryGraph), so the tag writer drops its own guesses then.
      const scene = isPhotoEngine(S.engine) ? null : await post("/lora-lab/llm/scene", { idea: (st.style ? `Art style: ${st.style}. ` : "") + (s.idea || s.caption),
        people: s.count || "", target: dolphinTarget(), model: $("llmModel").value, sfw: c.workspace !== "adult", drop_looks: !!(own || chatStoryLookTags(c, chat, s)) })
        .catch(err => { if (ROUTE_MISSING.test(err.message)) return null; throw err; });
      const r = scene || await post("/lora-lab/llm", { idea: chatStoryIdea(c, chat, s), target: dolphinTarget(), model: $("llmModel").value, sfw: c.workspace !== "adult",
        character: own ? { name: own.name, memory: own.memory || "" } : null });
      s.prompt = (r && r.text || "").trim();
      await saveChatStory(c, chat, { scenes: [{ key: s.key, prompt: s.prompt }] });
    }
  } catch (err) { failed = ROUTE_MISSING.test(err.message) ? dolphinError(err) : chatError(err, "The prompt writer stopped"); toast(failed); }
  finally { chatStoryJob = null; if (chatOf(chatCur) === chat) renderChatStory(); }
  return !failed && !job.stop;
}
// The look tags of the people in a scene (from "How everyone looks"), for tag engines; the linked character's look
// comes from their own tags. Lines that aren't tags (an older plan, or typed as a sentence) are left to the writer.
function chatStoryLookTags(c, chat, s) {
  const own = chatOwn(c), text = `${s.idea} ${s.caption}`.toLowerCase(), out = [];
  for (const line of chatStoryOf(chat).looks.split("\n")) {
    const m = line.replace(/^[-*•\s]+/, "").match(/^([^:]{1,60}):\s*(.+)$/);
    if (!m) continue;
    const name = m[1].trim(), first = name.split(/\s+/)[0].toLowerCase(), tags = splitTags(m[2]);
    if (!first || !text.includes(first) || (own && first === own.name.split(/\s+/)[0].toLowerCase())) continue;
    if (tags.length < 3 || tags.some(t => t.split(/\s+/).length > 4)) continue;
    out.push(tags.filter(t => !COUNT_TAG.test(normTag(t))).join(", "));
  }
  return joinTags(out);
}
function chatStoryGraph(c, chat, s, seed, prefix) {
  const own = chatOwn(c), [w, h] = CHAT_STORY_SIZE;
  const keep = { charId: S.charId, charUse: S.charUse, w: S.w, h: S.h };
  Object.assign(S, { charId: own ? own.id : "", charUse: { appearance: true, outfit: false, loras: true, ref: false, face: true }, w, h });
  plainGraph = true;
  try {
    const extra = selectedLoras().map(n => ({ name: n, strength: loraStrength(n) }));
    // Who is in the picture comes from the story plan (the writer tends to add "solo" to two people).
    const photo = isPhotoEngine(S.engine), people = splitTags(s.count || "").map(normTag);
    const prompt = s.count && !photo
      ? joinTags([s.count, people.includes("1girl") && people.includes("1boy") ? "couple" : "", chatStoryLookTags(c, chat, s),
          splitTags(s.prompt).filter(t => !COUNT_TAG.test(normTag(t)) && !/^(male|female) focus$/.test(normTag(t))).join(", ")]) : s.prompt;
    return buildGraph(null, seed, prefix, { prompt, newLook: false, extraLoras: extra,
      neg: joinTags([CHAT_STORY_NEG, c.workspace !== "adult" ? STORY_NEG.safe : ""]) }).graph;
  } finally { Object.assign(S, keep); plainGraph = false; }
}
// ▶ Draw: every scene that has a prompt and no picture yet, or one more version of one scene.
async function drawChatStory(c, chat, only) {
  const e = E(), st = chatStoryOf(chat);
  if (!e.model) return toast("No model selected ( on the right).");
  const todo = st.scenes.filter(s => s.prompt.trim() && (only ? s.key === only : !s.images.length && !chatStoryPending(chat, s.key)));
  if (!todo.length) return toast(only ? "Write its prompt first (✍)." : "Every scene already has a picture. Use ↻ on a scene for another version.", true);
  const [w, h] = CHAT_STORY_SIZE;
  await post("/lora-lab/llm/unload", {}).catch(() => {});   // the chat and prompt writer would otherwise share the GPU with the pictures
  const batch = { id: Date.now(), engine: S.engine, model: e.model, prompt: `💬 ${c.name}: ${chat.title}`, chat: { id: c.id, chat: chat.id, name: c.name }, w, h,
    steps: e.steps, cfg: e.cfg, sampler: e.sampler, scheduler: e.scheduler, seed: 0, count: 1, mode,
    cols: Array.from({ length: Math.min(6, todo.length) }, () => ({ lora: null })), cells: [] };
  for (const s of todo) batch.cells.push({ lora: null, status: "queued", seed: rand(), chat: { key: s.key, label: `Scene ${st.scenes.indexOf(s) + 1}` } });
  batches.unshift(batch);
  renderResults(); renderChatStory();
  for (const [idx, cell] of batch.cells.entries()) {
    const graph = chatStoryGraph(c, chat, todo[idx], cell.seed, `LoRA-Lab/chats/${safe(c.name)}/${safe(chat.title)}`);
    try {
      const res = await post("/prompt", { prompt: graph, client_id: clientId });
      cell.pid = res.prompt_id; jobs.set(res.prompt_id, { batchId: batch.id, idx });
    } catch (err) {
      cell.status = "error"; cell.error = nodeErrorText(err.body) || err.message;
      if (idx === 0) { toast("ComfyUI rejected the job:\n" + cell.error); batch.cells.forEach((x, j) => { if (j) { x.status = "error"; x.error = "Skipped"; } }); break; }
    }
  }
  saveBatches(); updateProgress(); renderChatStory();
  toast(`${todo.length} picture${todo.length === 1 ? "" : "s"} queued for the story`, true);
}
// 🎬 Make picture story: plan it (if there are no scenes yet), write the missing prompts, draw the missing pictures.
async function makeChatStory(c, chat) {
  if (chatStoryBusy()) return toast(chatStoryBusy() + "; wait for it to finish.");
  if (!E().model) return toast("Pick an image model first ( on the right).");
  if (!chatStoryOf(chat).scenes.length && !await planChatStory(c, chat)) return;
  if (!await writeChatStoryPrompts(c, chat)) return;
  await drawChatStory(c, chat);
}
async function stopChatStory(c, chat) {
  if (chatStoryJob && chatStoryJob.chat === chat) { chatStoryJob.stop = true; renderChatStory(); }
  const ids = [...jobs.entries()].filter(([, j]) => { const b = batches.find(x => x.id === j.batchId); return b && b.chat && b.chat.chat === chat.id; }).map(([pid]) => pid);
  if (!ids.length) return;
  try {
    await post("/queue", { delete: ids.filter(id => id !== runningId) });
    if (ids.includes(runningId)) await post("/interrupt", { prompt_id: runningId });
  } catch (e) { return toast("Stop failed: " + e.message); }
  for (const id of ids) { const f = findJob(id); if (f && !f.c.image) { f.c.status = "cancelled"; updateCell(f.b, f.idx); } jobs.delete(id); }
  saveBatches(); renderChatStory(); toast("Stopped", true);
}
// A finished picture goes into the chat as one more version of its scene.
function chatStoryImageDone(b, cell) {
  if (cell.chatPosted || !cell.image || !cell.chat) return;
  cell.chatPosted = true;
  post("/lora-lab/chat/story/image", { id: b.chat.id, chat: b.chat.chat, key: cell.chat.key, image: cell.image, seed: cell.seed })
    .then((scene) => {
      for (const c of new Set([chatCur, chatStoryJob && chatStoryJob.c])) {
        const chat = c && c.id === b.chat.id && c.chats.find(x => x.id === b.chat.chat), s = chat && chatStoryOf(chat).scenes.find(x => x.key === scene.key);
        if (s) { s.images = scene.images; s.pick = scene.pick; }
      }
      renderChatStory();
    })
    .catch(() => { cell.chatPosted = false; });
}
async function dropChatStoryImage(c, chat, s) {
  if (!confirm("Delete this version of the picture? (The image file stays in the Images tab.)")) return;
  try { const r = await post("/lora-lab/chat/story/drop", { id: c.id, chat: chat.id, key: s.key, index: s.pick || 0 }); s.images = r.images; s.pick = r.pick; }
  catch (err) { return toast(chatError(err, "Couldn't delete")); }
  renderChatStory();
}
// ⬇ Download: the story as one web page (pictures inside), to open in any browser or send to someone.
async function downloadChatStory(c, chat) {
  const st = chatStoryOf(chat), esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  toast("Packing the story…", true);
  const parts = [];
  for (const s of st.scenes) {
    const im = chatStoryPick(s);
    let src = "";
    if (im) try {
      const blob = await (await fetch(imgUrl(im))).blob();
      src = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
    } catch {}
    parts.push(`<figure>${src ? `<img src="${src}" alt="">` : ""}<figcaption>${esc(s.caption)}</figcaption></figure>`);
  }
  const title = `${c.name}: ${chat.title}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;background:#111;color:#eee;font:18px/1.6 Georgia,serif}main{max-width:900px;margin:0 auto;padding:24px 16px 60px}h1{font-weight:normal;text-align:center}
figure{margin:0 0 36px}img{width:100%;border-radius:10px;display:block}figcaption{padding:12px 4px 0}</style></head>
<body><main><h1>${esc(title)}</h1>${parts.join("\n")}</main></body></html>`;
  const a = el("a", { href: URL.createObjectURL(new Blob([html], { type: "text/html" })), download: `${title.replace(/[\\/:*?"<>|]+/g, "_")}.html` });
  document.body.append(a); a.click(); a.remove();
}
function renderChatStory() {
  const c = chatCur, chat = chatOf(c), box = $("ctStory"); if (!chat || !box) return;
  const st = chatStoryOf(chat), job = chatStoryJob && chatStoryJob.chat === chat ? chatStoryJob : null, pend = chatStoryPending(chat), other = chatStoryJob && !job;
  const drawn = st.scenes.filter(s => s.images.length).length, prompted = st.scenes.filter(s => s.prompt.trim()).length;
  const scenesSel = el("label", { class: "inline", style: "margin:0;gap:6px", title: "How many pictures the story gets (1-30)" }, "Pictures",
    el("input", { type: "number", min: "1", max: "30", step: "1", value: store.get("chatStoryScenes", 6), style: "flex:none;width:64px",
      onchange: (ev) => { const n = Math.max(1, Math.min(30, Math.round(+ev.target.value) || 6)); ev.target.value = n; store.set("chatStoryScenes", n); } }));
  box.replaceChildren(
    el("div", { class: "inline", style: "flex-wrap:wrap;gap:6px" },
      el("button", { class: "btn primary", text: st.scenes.length ? "Draw missing" : "Make picture story", disabled: job || other || chat.messages.length < 2 ? "" : null,
        title: "Reads the chat, plans the scenes, writes their prompts and draws them with the  on the right", onclick: () => makeChatStory(c, chat) }),
      st.scenes.length ? el("button", { class: "btn", text: "Plan again", disabled: job || other ? "" : null, title: "Read the chat again and plan new scenes (for a chat that went on, or another number of scenes)",
        onclick: () => { if (confirm("Plan the story again? The scenes are replaced (their pictures stay in the Images tab).")) planChatStory(c, chat); } }) : null,
      st.scenes.length && prompted < st.scenes.length ? el("button", { class: "btn", text: "Write prompts", disabled: job || other ? "" : null, onclick: () => writeChatStoryPrompts(c, chat) }) : null,
      job || pend ? el("button", { class: "btn", text: "⏹ Stop", onclick: () => stopChatStory(c, chat) }) : null,
      drawn ? el("button", { class: "btn", text: "⬇ Download", title: "The story as one web page with the pictures in it", onclick: () => downloadChatStory(c, chat) }) : null,
      el("span", { style: "flex:1" }), scenesSel),
    el("div", { class: "inline", style: "gap:8px;margin-top:8px" }, el("label", { for: "csStyle", style: "margin:0", text: "Art style" }),
      el("input", { type: "text", id: "csStyle", value: st.style, maxlength: "200", placeholder: "e.g. anime, soft watercolour, cinematic photo", style: "flex:1",
        onchange: (ev) => { st.style = ev.target.value.trim(); saveChatStory(c, chat, { style: st.style }); } })),
    el("div", { class: "hint", text: job ? job.note || "" : pend ? `🎨 ${pend} picture${pend === 1 ? "" : "s"} being drawn… (see Image Generation for progress)`
      : st.scenes.length ? `${drawn}/${st.scenes.length} drawn · Pictures use the model, LoRAs and settings  on the right` + (chatOwn(c) ? ` and ${chatOwn(c).name}'s look, LoRAs and face.` : ". Link a character (Picture and look from) so they look the same in every picture.")
        : `The writer retells this chat as a short story with pictures. Pick an image model on the left first.` }));
  if (!st.scenes.length) return;
  box.append(el("details", { class: "cslooks" }, el("summary", { text: "How everyone looks" }),
    el("textarea", { rows: "4", maxlength: "2000", text: st.looks, placeholder: "- Name: 1girl, long red hair, green eyes, black apron",
      onchange: (ev) => { st.looks = ev.target.value; saveChatStory(c, chat, { looks: st.looks }); } }),
    el("div", { class: "hint", text: "Used for every prompt written after you change it (✍ on a scene writes its prompt again)." })));
  st.scenes.forEach((s, i) => {
    const cur = chatStoryPick(s), p = chatStoryPending(chat, s.key), writing = job && job.key === s.key;
    box.append(el("div", { class: "csscene" },
      el("div", { class: "gaimg" }, cur ? el("img", { src: thumbUrl(cur, 768), loading: "lazy", alt: "", title: "Open full size", onclick: () => window.open(imgUrl(cur), "_blank") })
        : el("div", { class: "stph", text: p ? "Drawing…" : writing ? "Writing prompt…" : s.prompt ? "Not drawn yet" : "No prompt yet" })),
      s.images.length > 1 ? el("div", { class: "stvars" }, ...s.images.map((im, j) => el("button", { class: "stvar" + (j === (s.pick || 0) ? " on" : ""), title: "Use this version",
        style: `background-image:url("${thumbUrl(im, 256)}")`, onclick: () => { s.pick = j; saveChatStory(c, chat, { scenes: [{ key: s.key, pick: j }] }); renderChatStory(); } }))) : null,
      el("div", { class: "csnum", text: `Scene ${i + 1}` }),
      el("textarea", { class: "cscap", rows: "2", maxlength: "600", text: s.caption, title: "The story text under the picture",
        onchange: (ev) => { s.caption = ev.target.value; saveChatStory(c, chat, { scenes: [{ key: s.key, caption: s.caption }] }); } }),
      el("details", {}, el("summary", { text: "Picture idea and prompt" }),
        el("textarea", { rows: "2", maxlength: "800", text: s.idea, title: "What the picture shows (✍ writes the prompt from it)",
          onchange: (ev) => { s.idea = ev.target.value; saveChatStory(c, chat, { scenes: [{ key: s.key, idea: s.idea }] }); } }),
        el("label", { class: "hint", style: "display:flex;gap:6px;align-items:center;margin:4px 0" }, "People:",
          el("input", { type: "text", value: s.count || "", maxlength: "60", placeholder: "e.g. 1girl, 1boy", style: "flex:1", title: "Who is in the picture, as image tags (put first in the prompt)",
            onchange: (ev) => { s.count = ev.target.value.trim(); saveChatStory(c, chat, { scenes: [{ key: s.key, count: s.count }] }); } })),
        el("textarea", { rows: "3", maxlength: "3000", text: s.prompt, placeholder: "The image prompt", style: "margin-top:4px",
          onchange: (ev) => { s.prompt = ev.target.value; saveChatStory(c, chat, { scenes: [{ key: s.key, prompt: s.prompt }] }); } })),
      el("div", { class: "inline" },
        el("button", { class: "btn sm", text: "↻ Draw again", disabled: s.prompt.trim() ? null : "", onclick: () => drawChatStory(c, chat, s.key) }),
        el("button", { class: "btn sm", text: "New prompt", disabled: job || other ? "" : null,
          onclick: () => { if (!s.prompt.trim() || confirm(`Write the prompt of scene ${i + 1} again?`)) writeChatStoryPrompts(c, chat, s.key); } }),
        cur ? el("button", { class: "btn sm", text: "🗑", title: "Delete this version", onclick: () => dropChatStoryImage(c, chat, s) }) : null,
        p ? el("span", { class: "hint", text: `${p} in progress` }) : null)));
  });
}
$("ctBase").onchange = () => { const own = chars.find(x => x.id === $("ctBase").value); if (own && !$("ctName").value.trim()) $("ctName").value = own.name; };

// ---------- game art ----------
// The story read back into its pictures: a title screen, a portrait per character, a background per place and an
// image per dialogue scene. The prompt writer turns each one's idea into a prompt for the selected engine, and they
// are drawn like a story: one results batch, each finished image saved into the game (and used by 🔨 Build).
const GAME_ART_KINDS = [["title", "Title screen"], ["cast", "Characters"], ["place", "Places"], ["scene", "Scenes"]];
const GAME_ART_SIZE = { title: [1216, 832], cast: [1024, 1024], place: [1216, 832], scene: [1216, 832] };
const GAME_ART_NEG = { title: "text, title, logo, watermark, signature", cast: "multiple views, text, watermark",
  place: "1girl, 1boy, people, person, crowd, text, watermark", scene: "text, watermark" };
let gameArtJob = null;   // { g, key, stop } while the prompt writer is busy with a game's pictures
const gameArtPick = (a) => a.images && a.images.length ? a.images[Math.min(a.pick || 0, a.images.length - 1)] : null;
const gameArtPending = (gid, key) => batches.filter(b => b.game && b.game.id === gid).flatMap(b => b.cells)
  .filter(c => c.game && (!key || c.game.key === key) && !c.image && c.pid && (c.status === "queued" || c.status === "running")).length;
const gameBusy = () => gameJob ? `"${gameJob.g.title}" is still being written` : gameArtJob ? `The prompts of "${gameArtJob.g.title}" are still being written` : "";
async function flushGameSave(g) {
  if (gameSaveTimer) { clearTimeout(gameSaveTimer); gameSaveTimer = null; await saveGame(g); }
}

// 📖 Read the story: (re)makes the list of pictures; pictures still in the story keep their prompt and images.
async function planGameArt(g, quiet) {
  await flushGameSave(g);
  try { const r = await post("/lora-lab/game/art/plan", { id: g.id }); g.art = r.art; }
  catch (err) { toast(gameError(err, "Couldn't read the story")); return false; }
  if (!quiet) toast(`${g.art.length} pictures in "${g.title}"`, true);
  if (gameCur === g) renderGameArt();
  return true;
}
// ✍ Prompts: every picture without one (or only one picture), one prompt-writer call each.
async function writeGameArtPrompts(g, only) {
  if (gameBusy()) return toast(gameBusy() + "; wait for it to finish.");
  if (!(g.art || []).length && !await planGameArt(g, true)) return;
  const todo = g.art.filter(a => only ? a.key === only : !a.prompt.trim());
  if (!todo.length) return;
  const job = gameArtJob = { g, key: "", stop: false };
  let failed = "";
  try {
    for (const [i, a] of todo.entries()) {
      if (job.stop) break;
      job.key = a.key;
      job.note = `✍ Writing the prompt for ${a.name}${todo.length > 1 ? ` (${i + 1} of ${todo.length})` : ""}…`;
      if (gameCur === g) renderGameArt();
      const ch = a.charId && chars.find(c => c.id === a.charId);
      const r = await post("/lora-lab/llm", { idea: a.idea, target: dolphinTarget(), model: $("llmModel").value, sfw: g.workspace !== "adult",
        character: ch ? { name: ch.name, memory: ch.memory || "" } : null });
      a.prompt = (r && r.text || "").trim();
      await saveGame(g);
    }
  } catch (err) { failed = ROUTE_MISSING.test(err.message) ? dolphinError(err) : gameError(err, "The prompt writer stopped"); toast(failed); }
  finally {
    gameArtJob = null;
    if (gameCur === g) { renderGameArt(); if (failed) $("gaNote").textContent = failed; }
  }
  return !failed && !job.stop;
}
function gameGraph(g, a, seed, prefix) {
  const ch = a.charId ? chars.find(c => c.id === a.charId) : null, [w, h] = GAME_ART_SIZE[a.kind] || [1216, 832];
  const keep = { charId: S.charId, charUse: S.charUse, w: S.w, h: S.h };
  Object.assign(S, { charId: ch ? ch.id : "", charUse: { appearance: true, outfit: true, loras: true, ref: false, face: true }, w, h });
  plainGraph = true;
  try {
    let prompt = a.prompt;
    // Backgrounds stay empty, so the characters can walk over them in the game.
    if (a.kind === "place" && !isPhotoEngine(S.engine)) prompt = joinTags(["no humans, scenery", splitTags(prompt).filter(t => !COUNT_TAG.test(normTag(t))).join(", ")]);
    // Who is in the picture comes from the story (the writer tends to put 1girl on everyone).
    else if (a.count && !isPhotoEngine(S.engine) && !a.charId) prompt = joinTags([a.count, a.kind === "cast" ? "solo" : "", splitTags(prompt).filter(t => !COUNT_TAG.test(normTag(t))).join(", ")]);
    const extra = selectedLoras().map(n => ({ name: n, strength: loraStrength(n) }));
    return buildGraph(null, seed, prefix, { prompt, newLook: false, extraLoras: extra,
      neg: joinTags([GAME_ART_NEG[a.kind], g.workspace !== "adult" ? STORY_NEG.safe : ""]) }).graph;
  } finally { Object.assign(S, keep); plainGraph = false; }
}
// ▶ Draw: every picture that has a prompt and no image yet, or one more version of one picture.
async function drawGameArt(g, only) {
  const e = E();
  if (!e.model) return toast("No model selected (Model panel).");
  const todo = (g.art || []).filter(a => a.prompt.trim() && (only ? a.key === only : !a.images.length && !gameArtPending(g.id, a.key)));
  if (!todo.length) return toast(only ? "Write its prompt first (✍)." : "Every picture with a prompt already has an image. Use ↻ on a picture for another version.", true);
  const batch = { id: Date.now(), engine: S.engine, model: e.model, prompt: `🎮 ${g.title}`, game: { id: g.id, title: g.title }, w: GAME_ART_SIZE[todo[0].kind][0], h: GAME_ART_SIZE[todo[0].kind][1],
    steps: e.steps, cfg: e.cfg, sampler: e.sampler, scheduler: e.scheduler, seed: 0, count: 1, mode,
    cols: Array.from({ length: Math.min(6, todo.length) }, () => ({ lora: null })), cells: [] };
  for (const a of todo) batch.cells.push({ lora: null, status: "queued", seed: rand(), game: { key: a.key, label: a.name } });
  batches.unshift(batch);
  renderResults(); renderGameArt();
  for (const [idx, cell] of batch.cells.entries()) {
    const a = todo[idx], graph = gameGraph(g, a, cell.seed, `LoRA-Lab/games/${safe(g.title)}/${a.kind}`);
    try {
      const res = await post("/prompt", { prompt: graph, client_id: clientId });
      cell.pid = res.prompt_id; jobs.set(res.prompt_id, { batchId: batch.id, idx });
    } catch (err) {
      cell.status = "error"; cell.error = nodeErrorText(err.body) || err.message;
      if (idx === 0) { toast("ComfyUI rejected the job:\n" + cell.error); batch.cells.forEach((c, j) => { if (j) { c.status = "error"; c.error = "Skipped"; } }); break; }
    }
  }
  saveBatches(); updateProgress(); renderGameArt();
  toast(`${todo.length} picture${todo.length === 1 ? "" : "s"} queued for "${g.title}"`, true);
}
// 🎨 Make all art: read the story, write the missing prompts, draw the missing pictures.
async function makeAllGameArt(g) {
  if (gameBusy()) return toast(gameBusy() + "; wait for it to finish.");
  if (!await planGameArt(g, true)) return;
  if (g.art.some(a => !a.prompt.trim()) && !await writeGameArtPrompts(g)) return;
  if (gameCur === g || gameCur === null) await drawGameArt(g);
}
async function stopGameArt(g) {
  if (gameArtJob && gameArtJob.g === g) { gameArtJob.stop = true; renderGameArt(); }
  const ids = [...jobs.entries()].filter(([, j]) => { const b = batches.find(x => x.id === j.batchId); return b && b.game && b.game.id === g.id; }).map(([pid]) => pid);
  if (!ids.length) return;
  try {
    await post("/queue", { delete: ids.filter(id => id !== runningId) });
    if (ids.includes(runningId)) await post("/interrupt", { prompt_id: runningId });
  } catch (e) { return toast("Stop failed: " + e.message); }
  for (const id of ids) { const f = findJob(id); if (f && !f.c.image) { f.c.status = "cancelled"; updateCell(f.b, f.idx); } jobs.delete(id); }
  saveBatches(); renderGameArt(); toast("Stopped", true);
}
// A finished picture goes into the game file as one more version of it.
function gameImageDone(b, c) {
  if (c.gamePosted || !c.image || !c.game) return;
  c.gamePosted = true;
  post("/lora-lab/game/art/image", { id: b.game.id, key: c.game.key, image: c.image, seed: c.seed })
    .then((item) => {
      for (const g of new Set([gameCur, gameJob && gameJob.g, gameArtJob && gameArtJob.g])) {
        const a = g && g.id === b.game.id && (g.art || []).find(x => x.key === item.key);
        if (a) { a.images = item.images; a.pick = item.pick; }
      }
      if (gameCur && gameCur.id === b.game.id) renderGameArt();
    })
    .catch(() => { c.gamePosted = false; });
}
async function dropGameArtImage(g, a) {
  if (!confirm(`Delete this version of "${a.name}"? (The image file stays in the Images tab.)`)) return;
  try { const item = await post("/lora-lab/game/art/drop", { id: g.id, key: a.key, index: a.pick || 0 }); a.images = item.images; a.pick = item.pick; }
  catch (err) { return toast(gameError(err, "Couldn't delete")); }
  renderGameArt();
}
function renderGameArt() {
  const g = gameCur, d = $("gm-art"); if (!g || !d) return;
  const art = g.art || [], job = gameArtJob && gameArtJob.g === g ? gameArtJob : null, pend = gameArtPending(g.id);
  const drawn = art.filter(a => a.images.length).length, prompted = art.filter(a => a.prompt.trim()).length;
  d.innerHTML = "";
  d.append(el("div", { class: "h" }, el("span", { text: "Game art" + (art.length ? ` · ${drawn}/${art.length} drawn` : "") }),
    el("span", { class: "inline" },
      el("button", { class: "btn sm primary", text: "Make all art", disabled: job || !gameWritten(g) ? "" : null,
        title: "Reads the story, writes the missing prompts and draws the missing pictures with the selected model", onclick: () => makeAllGameArt(g) }),
      el("button", { class: "btn sm", text: "Read the story", disabled: job ? "" : null,
        title: "Lists the pictures this game needs again, after you changed the story (pictures already made are kept)", onclick: () => planGameArt(g) }),
      art.length && prompted < art.length ? el("button", { class: "btn sm", text: "Write prompts", disabled: job ? "" : null, onclick: () => writeGameArtPrompts(g) }) : null,
      prompted ? el("button", { class: "btn sm", text: "▶ Draw missing", onclick: () => drawGameArt(g) }) : null,
      job || pend ? el("button", { class: "btn sm", text: "⏹ Stop", onclick: () => stopGameArt(g) }) : null)));
  d.append(el("div", { class: "hint", text: "Pictures made from the story with the model, LoRAs and settings  on the right. 🔨 Build in the RPG Maker box below puts them in the game: portraits become faces, places become maps, scenes play during the dialogue." }));
  d.append(el("div", { class: "inline", style: "margin:8px 0;gap:8px;align-items:center" }, el("label", { for: "gaStyle", style: "margin:0", text: "Art style" }),
    el("input", { type: "text", id: "gaStyle", value: g.style || "", maxlength: "200", placeholder: "e.g. anime, cel shading, soft colours — then 📖 Read the story", style: "flex:1",
      onchange: (ev) => { g.style = ev.target.value.trim(); saveGameSoon(); } })));
  d.append(el("div", { class: "hint", id: "gaNote", text: job ? job.note || "" : pend ? `🎨 ${pend} picture${pend === 1 ? "" : "s"} being drawn…` : "" }));
  if (!art.length) return d.append(el("div", { class: "hint", text: gameWritten(g) ? "Press 🎨 Make all art (or 📖 Read the story to see the list first)." : "Write the game story first." }));
  for (const [kind, label] of GAME_ART_KINDS) {
    const items = art.filter(a => a.kind === kind);
    if (!items.length) continue;
    d.append(el("div", { class: "gahead", text: label }), el("div", { class: "gagrid" + (kind === "cast" ? " square" : "") }, ...items.map(a => gameArtCard(g, a, job))));
  }
}
function gameArtCard(g, a, job) {
  const cur = gameArtPick(a), pend = gameArtPending(g.id, a.key), writing = job && job.key === a.key;
  return el("div", { class: "gaitem", id: "ga-" + a.key },
    el("div", { class: "gaimg" }, cur ? el("img", { src: thumbUrl(cur, 768), loading: "lazy", alt: "", title: "Open full size", onclick: () => window.open(imgUrl(cur), "_blank") })
      : el("div", { class: "stph", text: pend ? "Drawing…" : writing ? "Writing prompt…" : a.prompt ? "Not drawn yet" : "No prompt yet" })),
    el("b", { text: a.name, title: a.role || a.name }),
    a.images.length > 1 ? el("div", { class: "stvars" }, ...a.images.map((im, i) => el("button", { class: "stvar" + (i === (a.pick || 0) ? " on" : ""), title: "Use this version",
      style: `background-image:url("${thumbUrl(im, 256)}")`, onclick: () => { a.pick = i; saveGameSoon(); renderGameArt(); } }))) : null,
    el("details", {}, el("summary", { text: "Prompt" }),
      el("textarea", { rows: "4", text: a.prompt, placeholder: a.idea, onchange: (ev) => { a.prompt = ev.target.value; saveGameSoon(); } }),
      a.kind !== "place" ? el("label", { class: "hint", style: "display:block;margin-top:4px" }, "Look from character: ",
        el("select", { style: "width:auto", title: "Draw with one of your characters (their look tags, LoRAs and face) so they look the same in every picture",
          onchange: (ev) => { a.charId = ev.target.value; saveGameSoon(); } },
          el("option", { value: "", text: "— none —" }), ...wsChars().map(c => el("option", { value: c.id, text: c.name, selected: c.id === a.charId ? "" : null })))) : null),
    el("div", { class: "inline" },
      el("button", { class: "btn sm", text: "↻", title: "Draw another version", disabled: a.prompt.trim() ? null : "", onclick: () => drawGameArt(g, a.key) }),
      el("button", { class: "btn sm", text: "✍", title: "Write this prompt again", disabled: job ? "" : null,
        onclick: () => { if (!a.prompt.trim() || confirm(`Write the prompt of "${a.name}" again?`)) writeGameArtPrompts(g, a.key); } }),
      cur ? el("button", { class: "btn sm", text: "🗑", title: "Delete this version", onclick: () => dropGameArtImage(g, a) }) : null,
      pend ? el("span", { class: "hint", text: `${pend} in progress` }) : null));
}

// ---------- RPG Maker ----------
// Finds RPG Maker MV / MZ and its projects on the ComfyUI PC. While a game has no project, the list is checked every
// few seconds, so a project made in RPG Maker shows up (and is linked) by itself. 🔨 Build writes the story and its
// art into the linked project; its data folder is backed up first.
let rpgStatus = null, rpgTimer = null, rpgSeen = null, rpgGen = 0, rpgBuilding = false;
const rpgDate = (ms) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
async function loadRpgStatus() {
  try { rpgStatus = await api("/lora-lab/rpg/status"); }
  catch (err) { rpgStatus = { error: gameError(err, "Couldn't look for RPG Maker") }; }
  return rpgStatus;
}
function stopRpgWatch() { rpgGen++; clearTimeout(rpgTimer); rpgTimer = null; rpgSeen = null; }
// Watching: a project that wasn't there on the first look is new, so it's linked to the open game.
function startRpgWatch(g) {
  stopRpgWatch();
  const gen = rpgGen;
  const tick = async () => {
    if (gen !== rpgGen) return;
    if (gameCur !== g || tab !== "game" || (g.rpg && g.rpg.project)) return stopRpgWatch();
    if (!document.hidden) {
      const st = await loadRpgStatus();
      if (gen !== rpgGen || gameCur !== g) return;
      if (!st.error) {
        const fresh = rpgSeen ? st.projects.filter(p => !rpgSeen.has(p.path.toLowerCase()) && !p.linked.length) : [];
        rpgSeen = new Set(st.projects.map(p => p.path.toLowerCase()));
        if (fresh.length === 1) return linkRpg(g, fresh[0].path, true);
      }
      renderGameRpg();
    }
    rpgTimer = setTimeout(tick, 8000);
  };
  tick();
}
async function linkRpg(g, path, found) {
  try { const r = await post("/lora-lab/rpg/link", { id: g.id, project: path }); g.rpg = r.rpg; }
  catch (err) { return toast(gameError(err, "Couldn't link the project")); }
  if (path) { stopRpgWatch(); toast(found ? `Found your new RPG Maker project "${path.split(/[\\/]/).pop()}" and linked it. Close it in RPG Maker, then press 🔨 Build.` : "Linked", true); }
  await loadRpgStatus();
  if (gameCur === g) { renderGameRpg(); if (!path) startRpgWatch(g); }
}
async function buildRpg(g) {
  if (rpgBuilding) return;
  const st = rpgStatus || await loadRpgStatus();
  if (st.running && st.running.length && !confirm(`RPG Maker is open. Close the project there first (without saving), or RPG Maker keeps the old data and saves over the build.\n\nBuild anyway?`)) return;
  if (g.rpg.built && !confirm(`Build "${g.title}" into the project again? The maps, people and art Kōbō made last time are replaced (your own maps and changes elsewhere stay; a backup is made first).`)) return;
  await flushGameSave(g);
  rpgBuilding = true; renderGameRpg();
  let note;
  try {
    const r = await post("/lora-lab/rpg/build", { id: g.id }), x = r.result;
    g.rpg = r.game.rpg;
    note = [`✅ Built: ${x.maps} maps, ${x.npcs} people to talk to, ${x.actors} characters, ${x.images} images. The game starts at ${x.start}. Open it in RPG Maker and press Playtest.`,
      ...x.warnings.map(w => "⚠ " + w), `Backup of the project's data before this build: ${x.backup}`].join("\n");
    toast(`"${g.title}" is built into the project`, true);
  } catch (err) { note = gameError(err, "Build failed"); toast(note); }
  finally { rpgBuilding = false; }
  if (gameCur === g) { renderGameRpg(); $("rpgNote").textContent = note; }
}
async function openRpg(g) {
  try { await post("/lora-lab/rpg/open", { project: g.rpg.project }); toast("Opening RPG Maker…", true); }
  catch (err) { toast(gameError(err, "Couldn't open RPG Maker")); }
}
async function saveRpgSettings(body) {
  try { rpgStatus = await post("/lora-lab/rpg/settings", body); toast("Saved", true); }
  catch (err) { return toast(gameError(err, "Couldn't save")); }
  renderGameRpg();
}
function renderGameRpg() {
  const g = gameCur, d = $("gm-rpg"); if (!g || !d) return;
  const st = rpgStatus, rpg = g.rpg || {}, note = $("rpgNote") ? $("rpgNote").textContent : "";
  d.innerHTML = "";
  d.append(el("div", { class: "h" }, el("span", { text: "RPG Maker" }),
    el("span", { class: "inline" }, el("button", { class: "btn sm", text: "↻ Look again", onclick: async () => { await loadRpgStatus(); renderGameRpg(); } }))));
  if (!st) { d.append(el("div", { class: "hint", text: "Looking for RPG Maker…" })); loadRpgStatus().then(renderGameRpg); return; }
  if (st.error) return d.append(el("div", { class: "hint", text: st.error }));
  const installs = st.installs || [];
  d.append(el("div", { class: "hint", text: installs.length
    ? "" + installs.map(i => `RPG Maker ${i.engine.toUpperCase()}: ${i.exe}`).join(" · ")
    : "RPG Maker MV (or MZ) isn't installed on the ComfyUI PC yet. Install it (e.g. on Steam) and make a new project (File → New Project): Kōbō finds it by itself and links it to this game." }));
  if (rpg.project) {
    const p = (st.projects || []).find(x => x.path.toLowerCase() === rpg.project.toLowerCase());
    d.append(el("div", { class: "rpgproj" },
      el("b", { text: `📁 ${rpg.project.split(/[\\/]/).pop()}` }), el("span", { class: "hint", text: ` ${(rpg.engine || "").toUpperCase()} · ${rpg.project}` }),
      el("div", { class: "hint", text: p ? `${p.maps} maps · actors: ${p.actors.join(", ") || "none"}${p.title ? ` · title "${p.title}"` : ""} · changed ${rpgDate(p.modified)}` : "The project isn't in the folders Kōbō looks in (or it was moved)." }),
      el("div", { class: "hint", text: rpg.built ? `Last built ${rpgDate(rpg.built)}` : "Not built yet." })),
      el("div", { class: "inline", style: "margin-top:8px" },
        el("button", { class: "btn primary", text: rpgBuilding ? "Building…" : rpg.built ? "Build again" : "Build game into project", disabled: rpgBuilding || !gameWritten(g) ? "" : null,
          title: "Writes the story and the art into the project: actors with faces, a map per place, people with the quests and dialogue, travel points, the title screen", onclick: () => buildRpg(g) }),
        el("button", { class: "btn", text: "Open in RPG Maker", onclick: () => openRpg(g) }),
        el("button", { class: "btn", text: "Unlink", onclick: () => linkRpg(g, "") })));
  } else {
    const projects = st.projects || [];
    d.append(el("div", { class: "hint", style: "margin-top:6px", text: projects.length
      ? "Link a project to this game (newest first). A project you make now in RPG Maker is found and linked by itself."
      : "No RPG Maker projects found yet. Waiting for one…" }));
    for (const p of projects.slice(0, 8)) {
      const isNew = !p.linked.length && Date.now() - p.created < 864e5;
      d.append(el("div", { class: "rpgproj" },
        el("b", { text: `${isNew ? "🆕 " : ""}📁 ${p.name}` }), el("span", { class: "hint", text: ` ${p.engine.toUpperCase()} · ${p.maps} maps · made ${rpgDate(p.created)}${p.linked.length ? ` · used by "${p.linked[0].title}"` : ""}` }),
        el("div", { class: "hint", text: p.path }),
        el("button", { class: "btn sm", text: "Link", onclick: () => linkRpg(g, p.path) })));
    }
  }
  d.append(el("details", { style: "margin-top:8px" }, el("summary", { class: "hint", text: "Where Kōbō looks" }),
    el("div", { class: "hint", text: "Project folders: " + (st.searched || []).join(" · ") }),
    el("label", { text: "More project folders (one per line)" }),
    el("textarea", { id: "rpgFolders", rows: "2", text: (st.folders || []).join("\n"), placeholder: "D:\\My RPG projects" }),
    el("label", { text: "RPG Maker program (only if it isn't found)" }),
    el("input", { type: "text", id: "rpgExe", value: st.exe || "", placeholder: "D:\\Games\\RPG Maker MV\\RPGMV.exe" }),
    el("button", { class: "btn sm", style: "margin-top:6px", text: "Save", onclick: () => saveRpgSettings({ folders: $("rpgFolders").value.split("\n"), exe: $("rpgExe").value }) })));
  d.append(el("div", { class: "hint", id: "rpgNote", style: "white-space:pre-wrap;margin-top:8px", text: rpgBuilding ? "Building…" : note }));
}

// ---------- Images tab ----------
// Everything under output/LoRA-Lab in folders: ⭐ Favourites, one per character (a new character gets its folder right
// away), stories, pictures made without a character and the rest (upscales, cut-outs, tests). The General workspace
// shows only its own characters and pictures made in it. ☆ on any picture (results, lightbox, here) stars it.
// 🗂 Sets are the user's own named groups (a picture can be in several); General only shows sets made in General.
let pics = [], imFolder = store.get("imFolder", "all"), imSel = null, imShown = 0, imSets = [], imSetsNote = "", imRenaming = null, imUpBusy = false;
const favs = new Set(), IM_PAGE = 120;
const picKey = (im) => `${(im.subfolder || "").replace(/\\/g, "/")}/${im.filename}`;
const picRef = (im) => ({ filename: im.filename, subfolder: im.subfolder || "", type: "output" });
function favBtn(im, big) {
  const b = el("button", { class: big ? "btn sm" : "ibtn fav", "data-fav": picKey(im), onclick: (ev) => { ev.stopPropagation(); toggleFav(im); } });
  paintFav(b, favs.has(picKey(im)));
  return b;
}
function paintFav(b, on) {
  b.classList.toggle("on", on);
  b.textContent = b.classList.contains("ibtn") ? (on ? "★" : "☆") : (on ? "★ Favourite" : "Favourite");
  b.title = on ? "Remove from favourites" : "Add to favourites (Images tab → ⭐ Favourites)";
}
async function toggleFav(im) {
  const k = picKey(im), on = !favs.has(k);
  try { await post("/lora-lab/images/mark", { image: picRef(im), fav: on }); }
  catch (err) { return toast(ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable favourites." : "Couldn't save: " + err.message); }
  if (on) favs.add(k); else favs.delete(k);
  const p = pics.find(x => picKey(x) === k); if (p) p.fav = on;
  for (const b of document.querySelectorAll("[data-fav]")) if (b.dataset.fav === k) paintFav(b, on);
  if (tab === "images") renderImages();
}
async function loadImages() {
  const sets = loadImageSets();
  try { pics = await api("/lora-lab/images"); }
  catch (err) { pics = []; $("imTitle").textContent = ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable the Images tab." : "Couldn't list the images: " + err.message; return; }
  favs.clear();
  for (const p of pics) if (p.fav) favs.add(picKey(p));
  for (const b of document.querySelectorAll("[data-fav]")) paintFav(b, favs.has(b.dataset.fav));
  await sets;
  if (tab === "images") renderImages();
}
async function loadImageSets() {
  try { imSets = await api("/lora-lab/images/sets"); imSetsNote = ""; }
  catch (err) { imSets = []; imSetsNote = ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable image sets." : "Couldn't load the sets: " + err.message; }
}
function picFolders() {
  const general = mode === "general", charKey = (c) => "c:" + safe(c.name).toLowerCase();
  const owner = new Map(), madeHere = new Set(batches.flatMap(b => b.cells.filter(c => c.image).map(c => picKey(c.image))));
  for (const c of chars) for (const e of c.images || []) owner.set(picKey(e.image), c);
  const folders = new Map();
  const add = (id, label, group, extra) => { if (!folders.has(id)) folders.set(id, { id, label, group, items: [], ...extra }); return folders.get(id); };
  add("fav", "Favourites", "", { ico: "⭐" }); add("all", "All images", "", { ico: "🖼" });
  for (const c of chars) if (!general || c.workspace === "general") add(charKey(c), c.name, "Characters", { char: c });
  for (const p of pics) {
    const parts = p.subfolder.split("/"), ch = owner.get(picKey(p));
    let f;
    if (parts[1] === "characters" && parts[2]) f = ["c:" + parts[2].toLowerCase(), parts[2], "Characters"];
    else if (ch) f = [charKey(ch), ch.name, "Characters"];
    else if (parts[1] === "stories" && parts[2]) f = ["s:" + parts[2], parts[2].replace(/_/g, " "), "Stories"];
    else if (/^\d{4}-\d\d-\d\d$/.test(parts[1] || "")) f = ["none", "No character", "Other"];
    else if (/^\d{4}-\d\d$/.test(parts[1] || "")) f = ["m:" + parts[1], new Date(parts[1] + "-15").toLocaleDateString(undefined, { month: "long", year: "numeric" }), "By month"];
    else f = ["o:" + (parts[1] || ""), parts[1] || "LoRA-Lab", "Other"];
    const c = chars.find(x => charKey(x) === f[0]);
    if (general && !(c ? c.workspace === "general" : p.mode === "general" || madeHere.has(picKey(p)))) continue;
    add(f[0], f[1], f[2], { char: c }).items.push(p);
    folders.get("all").items.push(p);
    if (p.fav) folders.get("fav").items.push(p);
  }
  const byKey = new Map(folders.get("all").items.map(p => [picKey(p), p]));
  for (const st of imSets) if (!general || st.mode === "general")
    add("set:" + st.id, st.name, "Sets", { ico: "🗂", set: st }).items.push(...st.images.map(k => byKey.get(k)).filter(Boolean));
  const order = { "": 0, "By month": 1, Characters: 2, Stories: 3, Other: 4, Sets: 5 };
  return [...folders.values()].sort((a, b) => order[a.group] - order[b.group] || (b.id === "none") - (a.id === "none")
    || (a.group === "By month" ? b.id.localeCompare(a.id) : 0));   // newest month first
}
function renderImages() {
  const folders = picFolders();
  const cur = folders.find(f => f.id === imFolder) || folders.find(f => f.id === "all");
  imFolder = cur.id;
  const box = $("imFolders"); box.innerHTML = "";
  let group = null;
  for (const f of folders) {
    if (f.set) continue;   // sets live in the 🗂 Sets panel
    if (f.group !== group) { group = f.group; if (group) box.append(el("div", { class: "imgroup", text: group })); }
    const thumb = f.ico ? null : f.char && f.char.ref ? inputUrl(f.char.ref) : f.items[0] ? thumbUrl(picRef(f.items[0]), 256) : null;
    box.append(el("div", { class: "imfolder" + (f === cur ? " on" : ""), onclick: () => { imFolder = f.id; store.set("imFolder", f.id); if (imSel) imSel.clear(); imShown = 0; renderImages(); } },
      thumb ? el("img", { src: thumb, alt: "", loading: "lazy" }) : el("span", { class: "ico", text: f.ico || "📁" }),
      el("b", { text: f.label }), el("span", { class: "n", text: f.items.length })));
  }
  $("imTitle").textContent = `${cur.ico ? cur.ico + " " : ""}${cur.label} · ${cur.items.length} image${cur.items.length === 1 ? "" : "s"}`;
  const grid = $("imGrid"), list = cur.items; grid.innerHTML = "";
  grid.classList.toggle("selecting", !!imSel);
  imShown = Math.max(imShown, IM_PAGE);
  list.slice(0, imShown).forEach((p, i) => {
    const k = picKey(p);
    grid.append(el("div", { class: "imtile" + (imSel && imSel.has(k) ? " sel" : "") },
      el("img", { src: thumbUrl(picRef(p)), loading: "lazy", alt: "", title: p.filename, draggable: "true", ondragstart: (ev) => {
        ev.dataTransfer.setData("text/x-asa-pics", JSON.stringify(imSel && imSel.has(k) ? [...imSel] : [k])); ev.dataTransfer.effectAllowed = "copy";
      }, onclick: (ev) => {
        if (!imSel) return openLbItems(list.map(x => ({ image: picRef(x), label: cur.label })), i);
        if (imSel.has(k)) imSel.delete(k); else imSel.add(k);
        ev.currentTarget.parentNode.classList.toggle("sel", imSel.has(k)); updateImSel();
      } }),
      favBtn(p),
      el("button", { class: "ibtn del", text: "🗑", title: "Delete this picture", onclick: (ev) => {
        ev.stopPropagation(); if (confirm("Delete this picture? The file is removed from the output folder.")) deletePics([p]);
      } }),
      cur.set ? el("button", { class: "ibtn out", text: "➖", title: "Take out of this set (the file stays)", onclick: (ev) => {
        ev.stopPropagation(); setPics(cur.set, [k], false);
      } }) : null));
  });
  if (!list.length) grid.append(el("div", { class: "hint", style: "grid-column:1/-1;padding:20px 0", text: cur.id === "fav" ? "No favourites yet. Press ☆ on any picture." : "No pictures in this folder yet." }));
  $("imMore").style.display = list.length > imShown ? "" : "none";
  $("imMore").textContent = `Show more (${list.length - imShown} left)`;
  renderImSets(folders, cur);
  updateImSel();
  const todo = favsToUpscale(cur.items);
  $("imUpFav").style.display = cur.id === "fav" && !imSel && (todo.length || imUpBusy) ? "" : "none";
  if (!imUpBusy) $("imUpFav").textContent = `⤢ Upscale all (${todo.length})`;
  $("imDlFav").style.display = cur.id === "fav" && !imSel && cur.items.length ? "" : "none";
}
// Favourites with no upscaled copy yet (an upscale is saved as LoRA-Lab/upscaled/<name>_00001_.png); upscales themselves are skipped.
function favsToUpscale(items) {
  const done = new Set(pics.filter(p => p.subfolder === "LoRA-Lab/upscaled").map(p => p.filename.replace(/_\d+_\.\w+$/, "")));
  return items.filter(p => p.subfolder !== "LoRA-Lab/upscaled" && !done.has(safe(p.filename)) && !done.has("redrawn_" + safe(p.filename)));
}
async function upscaleFavs() {
  const list = favsToUpscale(picFolders().find(f => f.id === "fav").items), btn = $("imUpFav");
  if (!list.length || imUpBusy) return;
  if (!lists.upscale.length) return toast("No upscale model found in models/upscale_models.");
  imUpBusy = btn.disabled = true;
  let ok = 0, failed = 0;
  for (const [i, p] of list.entries()) {   // one at a time, so new pictures you start in between are not stuck behind all of them
    btn.textContent = `Upscaling ${i + 1}/${list.length}…`;
    const g = { "1": { class_type: "LoadImage", inputs: { image: `${p.subfolder}/${p.filename} [output]` } } };
    upscaleGraph(g, p);
    try { await waitForJob((await post("/prompt", { prompt: g, client_id: clientId })).prompt_id); ok++; }
    catch (err) { failed++; console.warn("Upscale failed:", p.filename, nodeErrorText(err.body) || err.message); }
  }
  imUpBusy = btn.disabled = false;
  toast(`Upscaled ${ok} favourite${ok === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}: saved in output/LoRA-Lab/upscaled`, !failed);
  loadImages();
}
function renderImSets(folders, cur) {
  const open = !!store.get("imSetsOpen", false);
  $("imSets").style.display = open ? "" : "none";
  $("imChars").classList.toggle("withsets", open);
  $("imSetsBtn").classList.toggle("primary", open);
  if (!open) return;
  const box = $("imSetList"); box.innerHTML = "";
  if (imSetsNote) return box.append(el("div", { class: "hint", text: imSetsNote }));
  const sets = folders.filter(f => f.set);
  if (!sets.length) box.append(el("div", { class: "hint", text: "No sets yet. Type a name above and press ＋ New." }));
  for (const f of sets) {
    const st = f.set, shown = f.items.slice(0, f.items.length >= 4 ? 4 : 1);
    const card = el("div", { class: "imset" + (f === cur ? " on" : ""), title: "Open this set",
      onclick: () => { if (imRenaming) return; imFolder = f.id; store.set("imFolder", f.id); if (imSel) imSel.clear(); imShown = 0; renderImages(); },
      ondragover: (ev) => { if (!ev.dataTransfer.types.includes("text/x-asa-pics")) return; ev.preventDefault(); card.classList.add("drop"); },
      ondragleave: () => card.classList.remove("drop"),
      ondrop: (ev) => { ev.preventDefault(); card.classList.remove("drop"); setPics(st, JSON.parse(ev.dataTransfer.getData("text/x-asa-pics") || "[]"), true); } },
      el("div", { class: "cov" + (shown.length === 1 ? " one" : "") }, shown.length ? shown.map(p => el("img", { src: thumbUrl(picRef(p), 256), alt: "", loading: "lazy" })) : "🗂"),
      el("div", { style: "min-width:0" },
        imRenaming === st.id ? renameBox(st) : el("b", { text: st.name }),
        el("span", { class: "n", text: `${f.items.length} picture${f.items.length === 1 ? "" : "s"}` }),
        el("div", { class: "acts" },
          el("button", { class: "btn sm primary", "data-add": st.id, style: "display:none", title: "Put the selected pictures in this set",
            onclick: (ev) => { ev.stopPropagation(); setPics(st, [...imSel], true); } }),
          el("button", { class: "btn sm", text: "📤", title: "Export for Patreon: clean copies with no hidden prompt, settings, model or LoRA names",
            onclick: (ev) => { ev.stopPropagation(); exportImSet(st); } }),
          el("button", { class: "btn sm", text: "📝", title: "Clean prompts for Patreon: a text file with each picture's prompt, without artist tags, model tags or LoRA words",
            onclick: (ev) => { ev.stopPropagation(); exportImSet(st, "prompts"); } }),
          el("button", { class: "btn sm", text: "✎", title: "Rename", onclick: (ev) => { ev.stopPropagation(); imRenaming = st.id; renderImages(); } }),
          el("button", { class: "btn sm", text: "🗑", title: "Delete the set (the pictures stay)", onclick: (ev) => { ev.stopPropagation(); deleteImSet(st); } }))));
    box.append(card);
  }
}
function renameBox(st) {
  const done = async (save) => {
    if (imRenaming !== st.id) return;
    imRenaming = null;
    const name = inp.value.trim();
    if (save && name && name !== st.name) { const r = await imSetCall("save", { id: st.id, name }); if (r) putImSet(r); }
    renderImages();
  };
  const inp = el("input", { type: "text", value: st.name, maxlength: "60", onclick: (ev) => ev.stopPropagation(),
    onkeydown: (ev) => { if (ev.key === "Enter") done(true); else if (ev.key === "Escape") done(false); }, onblur: () => done(true) });
  setTimeout(() => { inp.focus(); inp.select(); });
  return inp;
}
async function imSetCall(what, data) {
  try { return await post("/lora-lab/images/sets/" + what, data); }
  catch (err) { toast(ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable image sets." : "Couldn't save the set: " + err.message); return null; }
}
function putImSet(st) { const i = imSets.findIndex(x => x.id === st.id); if (i < 0) imSets.push(st); else imSets[i] = st; }
async function newImSet() {
  const name = $("imSetName").value.trim();
  if (!name) return $("imSetName").focus();
  const st = await imSetCall("save", { name, mode });
  if (!st) return;
  $("imSetName").value = "";
  putImSet(st);
  if (imSel && imSel.size) return setPics(st, [...imSel], true);   // ☑ selected pictures go straight into the new set
  renderImages();
}
async function setPics(st, keys, add) {
  const byKey = new Map(pics.map(p => [picKey(p), p])), list = keys.map(k => byKey.get(k)).filter(Boolean);
  if (!list.length) return;
  const before = st.images.length, r = await imSetCall("images", { id: st.id, images: list.map(picRef), add });
  if (!r) return;
  putImSet(r);
  const n = Math.abs(r.images.length - before);
  toast(add ? (n ? `Added ${n} picture${n === 1 ? "" : "s"} to ${r.name}` : `Already in ${r.name}`) : `Took ${n} picture${n === 1 ? "" : "s"} out of ${r.name}`, true);
  if (imSel) imSel.clear();
  renderImages();
}
// what: "export" = clean copies of the pictures, "prompts" = a text file of their cleaned prompts (same numbers).
async function exportImSet(st, what = "export") {
  if (!st.images.length) return toast(`${st.name} is empty: put some pictures in it first.`);
  toast(what === "prompts" ? `Cleaning the prompts of ${st.name}…` : `Exporting ${st.name}…`, true);
  let r;
  try { r = await post("/lora-lab/images/sets/" + what, { id: st.id }); }
  catch (err) { return toast(ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable Export for Patreon." : "Couldn't export the set: " + err.message); }
  const n = (k) => `${k} picture${k === 1 ? "" : "s"}`;
  // the long toasts: time to read the path
  if (what === "prompts") return toast(`Saved clean prompts for ${n(r.found)}${r.found < r.count ? ` (${r.count - r.found} had no prompt saved)` : ""} to ${r.file}`);
  toast(`Saved ${r.count} clean picture${r.count === 1 ? "" : "s"} (no hidden settings) to ${r.folder}`);
}
async function deleteImSet(st) {
  if (!confirm(`Delete the set "${st.name}"? The pictures stay in your folders.`)) return;
  if (!await imSetCall("delete", { id: st.id })) return;
  imSets = imSets.filter(x => x.id !== st.id);
  if (imFolder === "set:" + st.id) { imFolder = "all"; store.set("imFolder", imFolder); }
  renderImages();
}
function updateImSel() {
  const n = imSel ? imSel.size : 0;
  $("imSelect").textContent = imSel ? "Cancel" : "Select";
  $("imAllBtn").style.display = $("imDelete").style.display = imSel ? "" : "none";
  $("imDelete").textContent = `🗑 Delete selected (${n})`;
  $("imDelete").disabled = !n;
  $("imOut").style.display = imSel && imFolder.startsWith("set:") ? "" : "none";
  $("imOut").textContent = `➖ Take out of set (${n})`;
  $("imOut").disabled = !n;
  for (const b of document.querySelectorAll("#imSetList [data-add]")) { b.style.display = n ? "" : "none"; b.textContent = `＋ Add ${n}`; }
}
// Deleted pictures also leave the results of every workspace, the character galleries and stories.
async function deletePics(list) {
  let gone;
  try { gone = new Set((await post("/lora-lab/images/delete", { images: list.map(picRef) })).deleted); }
  catch (err) { return toast(ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable deleting." : "Delete failed: " + err.message); }
  pics = pics.filter(p => !gone.has(picKey(p)));
  for (const k of gone) { favs.delete(k); if (imSel) imSel.delete(k); }
  for (const st of imSets) st.images = st.images.filter(k => !gone.has(k));
  const drop = (bs) => bs.filter(b => {
    for (const c of b.cells) if (c.image && gone.has(picKey(c.image))) Object.assign(c, { image: null, status: "error", error: "Deleted" });
    return !b.cells.every(c => c.error === "Deleted");
  });
  for (const m of ["general", "adult", "story"]) if (m !== mode) store.set("batches." + m, drop(store.get("batches." + m, [])));
  batches = drop(batches); saveBatches(); renderResults();
  for (const c of chars) if (c.images) c.images = c.images.filter(e => !gone.has(picKey(e.image)));
  if (storyCur) for (const { sc } of storyScenes(storyCur)) if (sc.images) sc.images = sc.images.filter(x => !gone.has(picKey(x.image)));
  toast(`Deleted ${gone.size} picture${gone.size === 1 ? "" : "s"}`, true);
  renderImages();
}
$("imSelect").onclick = () => { imSel = imSel ? null : new Set(); renderImages(); };
$("imUpFav").onclick = upscaleFavs;
$("imDlFav").onclick = () => downloadZip(picFolders().find(f => f.id === "fav").items.map(picRef), $("imDlFav"), "Favourites");
$("imSetsBtn").onclick = () => { store.set("imSetsOpen", !store.get("imSetsOpen", false)); renderImages(); if (store.get("imSetsOpen", false)) $("imSetName").focus(); };
$("imSetsClose").onclick = () => { store.set("imSetsOpen", false); renderImages(); };
$("imSetNew").onclick = newImSet;
$("imSetName").onkeydown = (ev) => { if (ev.key === "Enter") newImSet(); };
$("imOut").onclick = () => { const st = imSets.find(x => "set:" + x.id === imFolder); if (st && imSel.size) setPics(st, [...imSel], false); };
$("imAllBtn").onclick = () => { for (const p of picFolders().find(f => f.id === imFolder).items) imSel.add(picKey(p)); renderImages(); };
$("imDelete").onclick = () => {
  const list = pics.filter(p => imSel.has(picKey(p)));
  if (list.length && confirm(`Delete ${list.length} picture${list.length === 1 ? "" : "s"}? The files are removed from the output folder.`)) deletePics(list);
};
$("imMore").onclick = () => { imShown += IM_PAGE; renderImages(); };

// ---------- workspaces & layout ----------
function applyModeUI() {
  document.body.classList.toggle("adult", mode === "adult");
  document.body.classList.toggle("story", mode === "story");
  for (const b of $("modeSeg").children) b.classList.toggle("on", b.dataset.m === mode);
  $("modeMini").textContent = { adult: "Adult 18+ ⇄", story: "Story ⇄" }[mode] || "General ⇄";
  document.title = { adult: "Kōbō · 18+", story: "Kōbō · Story" }[mode] || "Kōbō";
}
// Re-attach jobs of this workspace that were still running (they finish in the background).
function trackPending() {
  jobs.clear();
  for (const b of batches) b.cells.forEach((c, idx) => {
    if (!c.image && c.pid && c.status !== "error") { c.status = "queued"; jobs.set(c.pid, { batchId: b.id, idx }); }
  });
  for (const pid of jobs.keys()) fetchHistory(pid);
}
function switchMode(m) {
  if (m === mode) return;
  if (queuing) return toast("Wait until the current batch is sent, then switch.");
  // The standalone (sold) app asks once whether the person is an adult before showing anything 18+.
  if (m !== "general" && edition.standalone && !store.get("ageOk", false)) {
    if (!confirm("The Adult 18+ and Story workspaces can make explicit content.\n\nAre you 18 or older (and of legal age where you live)?")) return;
    store.set("ageOk", true);
  }
  if (m === "adult" && !confirm("Switch to the Adult 18+ workspace?\n\nIt has its own prompt, LoRAs, reference images, characters and results, separate from General.")) return;
  if (m === "story" && !confirm("Switch to the Story workspace?\n\nStories can be General or 18+. It has its own model, LoRAs and results, and uses the characters of both workspaces.")) return;
  save(); saveBatches();
  mode = m; store.set("mode", m);
  libSort = null; libSorting = false;
  const next = loadWorkspace(m);
  for (const k of Object.keys(S)) delete S[k];
  Object.assign(S, next);
  batches = store.get("batches." + m, []);
  trackPending();
  refData = null; refDesc = {}; refDescBusy = {}; $("refControls").style.display = "none"; renderRef();
  $("drop").classList.remove("has"); $("refImg").src = ""; $("dropText").textContent = DROP_TEXT; $("refClear").style.display = "none";
  lastCharField = null;
  applyModeUI(); renderSettings(); renderResults(); showStoredRef(); resetTf();
  if (tab === "chars") renderChars();
  if (tab === "3d") render3d();
  dsCur = null; trJobs = [];
  if (tab === "train") renderTrain(); else loadTrainJobs();
  storyCur = null; gameCur = null; novelCur = null; chatCur = null; chatOpen = ""; mangaCur = null;
  showTab(m === "story" ? "story" : tab);
  toast({ adult: "Adult 18+ workspace", story: "Story workspace" }[m] || "General workspace", true);
}
$("modeSeg").addEventListener("click", (ev) => { if (ev.target.dataset.m) switchMode(ev.target.dataset.m); });

// Sidebar sections collapse when you click their header; the layout is shared by both workspaces.
function initCollapsible() {
  const collapsed = new Set(store.get("collapsed", []));
  for (const sec of document.querySelectorAll(".ppane section, .card.collapsible")) {
    const h = sec.querySelector(":scope > .h"); if (!h) continue;
    const key = h.textContent.replace(/^[\d\s·]+/, "").trim().split(/\s/)[0];
    sec.classList.toggle("collapsed", collapsed.has(key));
    h.addEventListener("click", (ev) => {
      if (ev.target.closest("button, input, select, a")) return;
      sec.classList.toggle("collapsed");
      if (sec.classList.contains("collapsed")) collapsed.add(key); else collapsed.delete(key);
      store.set("collapsed", [...collapsed]);
    });
  }
}
function applyAdvanced() {
  const on = !!store.get("advanced", false);
  document.body.classList.toggle("advanced", on);
  $("advanced").checked = on;
}
$("advanced").onchange = () => { store.set("advanced", $("advanced").checked); applyAdvanced(); };

// ---------- sequence: one continuous action over several frames ----------
// Every frame shares the prompt (who, outfit, place), character, LoRA and seed; only its own moment changes.
// "Keep the look of frame 1" (Klein only): once frame 1 is done, every later frame gets it as a reference image.
// Anchoring on frame 1 rather than the previous frame stops small flaws compounding frame by frame.
// SDXL has no equivalent here: a second IP-Adapter next to Keep face washed the colours out on a 6 GB GPU in testing,
// so SDXL/Anima frames stay together through the shared prompt, the same seed, Keep face and the character's tags.
const KLEIN_CARRY_HINT = "This picture continues the scene in the first-frame reference image: same place, lighting, outfit and art style; only the action described here has moved on.";
const seqBeats = () => (S.seq.beats || []).slice(0, S.seq.count).map(t => (t || "").trim()).filter(Boolean);
const seqActive = () => !!S.seq.on && seqBeats().length >= 2;
const carrySupport = () => S.engine === "klein" ? "klein" : null;
const seqCarry = () => seqActive() && !!S.seq.carry && !!carrySupport();
const framePrompt = (raw) => { const p = dropOrientation(S.prompt), beat = dropOrientation(raw); return isPhotoEngine(S.engine) ? `${p.replace(/([^.!?])$/, "$1.")} ${beat}` : joinTags([p, beat]); };
// Resolves with the cell's image once it is done, or null if it failed or was cancelled.
function waitForImage(b, idx) {
  return new Promise((res) => {
    const t = setInterval(() => {
      const c = b.cells[idx];
      if (!batches.includes(b) || !c || c.status === "error" || c.status === "cancelled") { clearInterval(t); res(null); }
      else if (c.image) { clearInterval(t); res(c.image); }
    }, 1000);
  });
}
function renderSeq() {
  for (const c of document.querySelectorAll('.chip[data-go="seq"]')) c.classList.toggle("on", !!S.seq.on);
  $("seqBox").style.display = S.seq.on ? "" : "none";
  if (!S.seq.on) return;
  $("seqCount").value = S.seq.count;
  if (document.activeElement !== $("seqStory")) $("seqStory").value = S.seq.story || "";
  $("seqSameSeed").checked = !!S.seq.sameSeed; $("seqCarry").checked = !!S.seq.carry;
  const sup = carrySupport();
  $("seqCarryHint").textContent = sup === "klein" ? "(later frames use frame 1 as a reference)"
    : `(Klein only; with ${ENGINE_LABEL[S.engine]} the shared prompt, same seed and Keep face hold the frames together)`;
  $("seqCarry").disabled = !sup;
  const box = $("seqFrames");
  if (box.contains(document.activeElement)) return;
  box.innerHTML = "";
  if (!Array.isArray(S.seq.beats)) S.seq.beats = [];
  for (let i = 0; i < S.seq.count; i++) {
    const last = i === S.seq.count - 1;
    box.append(el("div", { class: "seqrow" },
      el("span", { class: "n", text: i === 0 ? "Start" : last ? "End" : String(i + 1) }),
      el("input", { type: "text", value: S.seq.beats[i] || "",
        placeholder: i === 0 ? "e.g. at the park entrance gate, starting to walk" : last ? "e.g. reaching the exit gate at the far end, looking back" : "what happens next",
        oninput: (ev) => { S.seq.beats[i] = ev.target.value; save(); updateSummary(); } })));
  }
}
$("seqCount").addEventListener("change", () => { S.seq.count = Math.max(2, Math.min(8, $("seqCount").value | 0 || 4)); save(); renderSeq(); updateSummary(); });
$("seqStory").addEventListener("input", () => { S.seq.story = $("seqStory").value; save(); });
$("seqStory").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); $("seqPlan").click(); } });
$("seqSameSeed").onchange = () => { S.seq.sameSeed = $("seqSameSeed").checked; save(); };
$("seqCarry").onchange = () => { S.seq.carry = $("seqCarry").checked; save(); updateSummary(); };
$("seqOff").onclick = () => { S.seq.on = false; save(); renderSeq(); updateSummary(); };
$("seqPlan").onclick = async () => {
  const story = $("seqStory").value.trim();
  if (!story) return toast("Describe what happens from start to finish first.");
  const btn = $("seqPlan"), st = $("seqStatus"), t0 = Date.now(), ch = activeChar();
  btn.disabled = true; st.textContent = `Planning ${S.seq.count} frames… on slower PCs this can take a minute or two.`;
  try {
    const r = await post("/lora-lab/llm/sequence", { story, frames: S.seq.count, target: dolphinTarget(), model: $("llmModel").value, sfw: mode === "general",
      character: ch ? { name: ch.name, memory: ch.memory || "" } : null });
    S.seq.beats = r.beats; S.seq.count = Math.max(2, r.beats.length); save();
    $("seqFrames").innerHTML = ""; renderSeq(); updateSummary();
    st.textContent = `Planned in ${Math.round((Date.now() - t0) / 1000)} s. Edit any frame before generating.`;
  } catch (err) { st.textContent = ""; toast(dolphinError(err)); }
  finally { btn.disabled = false; }
};

// ---------- pose & expression sketch ----------
// The active character takes the sketch's pose and expression; their look still comes from tags, LoRAs and Keep face.
// SDXL: a ControlNet (anime line-art model for clean drawings, Union for rough ones). Anima: ControlNet-LLLite.
// Klein: the sketch becomes one more reference image.
// "Only the pose" (SDXL only): SDPose reads the body, hands and face from the picture and draws them as a coloured
// skeleton on black, so the outlines of clothes, hair and background never reach the model; an openpose ControlNet
// follows that. Tested 2026-10-25: Anima ignored the skeleton (anima-lllite-pose-1, or through any-test) and Klein 4B
// turned it into noise as a reference image.
const KLEIN_POSE_HINT = "Use the sketch reference image only for the pose, body position, framing and facial expression; draw a finished, detailed picture, not a sketch.";
function poseNet() {
  const union = lists.controlnet.find(n => /union/i.test(n)), line = lists.controlnet.find(n => /lineart|line_art/i.test(n));
  if (S.poseKind === "pose") { const op = lists.controlnet.find(n => /openpose|dwpose/i.test(n)); return op ? { name: op } : union ? { name: union, type: "openpose" } : null; }
  if (S.poseKind === "rough") return union ? { name: union, type: "hed/pidi/scribble/ted" } : line ? { name: line } : null;
  return line ? { name: line } : union ? { name: union, type: "canny/lineart/anime_lineart/mlsd" } : null;
}
const animaPatch = () => lists.modelPatches.find(n => /anima/i.test(n) && /any-test/i.test(n))
  || lists.modelPatches.find(n => /anima/i.test(n) && /lineart|scribble/i.test(n));
const poseSupport = () => S.poseKind === "pose" && (S.engine !== "sdxl" || !lists.sdpose.length) ? null
  : S.engine === "klein" ? "klein" : S.engine === "sdxl" && poseNet() ? "cn" : S.engine === "anima" && animaPatch() ? "lllite" : null;
const poseActive = () => !plainGraph && !!(S.poseUpload && S.poseOn && poseSupport());
// Rough sketches are followed more gently, or stick-figure lines turn into clothes and hats (tested on Anima: 0.6 for 0.9).
const poseStrength = () => +(Number(S.poseStrength) * (S.poseKind === "rough" ? (S.engine === "anima" ? 0.65 : 0.8) : 1)).toFixed(2);
// The sketch scaled to the output size, with dark lines on light (dark = true) or the other way round.
function poseImage(g, dark) {
  const p = S.poseUpload;
  g["90"] = { class_type: "LoadImage", inputs: { image: p.subfolder ? `${p.subfolder}/${p.name}` : p.name } };
  let img = ["90", 0];
  if (S.poseKind === "pose") {   // the skeleton is drawn light on black, which is what openpose models want either way
    g["92"] = { class_type: "ImageScale", inputs: { image: img, upscale_method: "lanczos", width: S.w, height: S.h, crop: "center" } };
    g["98"] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: lists.sdpose[0] } };
    g["99"] = { class_type: "SDPoseKeypointExtractor", inputs: { model: ["98", 0], vae: ["98", 2], image: ["92", 0], batch_size: 1 } };
    g["100"] = { class_type: "SDPoseDrawKeypoints", inputs: { keypoints: ["99", 0], draw_body: true, draw_hands: true, draw_face: true, draw_feet: true,
      stick_width: 4, face_point_size: 2, score_threshold: 0.3, draw_head: true } };
    return ["100", 0];
  }
  if (dark !== !!S.poseDark) { g["91"] = { class_type: "ImageInvert", inputs: { image: img } }; img = ["91", 0]; }
  g["92"] = { class_type: "ImageScale", inputs: { image: img, upscale_method: "lanczos", width: S.w, height: S.h, crop: "center" } };
  return ["92", 0];
}
// Most sketches are dark pencil on white paper; check so the right side gets inverted.
function lightBackground(blob) {
  return new Promise((res) => {
    const i = new Image(), u = URL.createObjectURL(blob);
    i.onload = () => {
      const c = document.createElement("canvas"); c.width = c.height = 48;
      const x = c.getContext("2d"); x.drawImage(i, 0, 0, 48, 48);
      const d = x.getImageData(0, 0, 48, 48).data; let sum = 0;
      for (let k = 0; k < d.length; k += 4) sum += d[k] * 0.3 + d[k + 1] * 0.59 + d[k + 2] * 0.11;
      URL.revokeObjectURL(u); res(sum / (d.length / 4) > 127);
    };
    i.onerror = () => { URL.revokeObjectURL(u); res(true); };
    i.src = u;
  });
}
async function setPose(file) {
  if (!file || !/^image\//.test(file.type)) return;
  const ext = ((/\.(png|jpe?g|webp|bmp|gif)$/i.exec(file.name || "") || [".png"])[0]).toLowerCase();
  const fd = new FormData();
  fd.append("image", file, `pose_${Date.now()}${ext}`);
  fd.append("type", "input"); fd.append("subfolder", "lora-lab"); fd.append("overwrite", "true");
  try {
    const r = await api("/upload/image", { method: "POST", body: fd });
    S.poseUpload = { name: r.name, subfolder: r.subfolder || "" };
    [S.poseSize, S.poseDark] = await Promise.all([imageSize(file), lightBackground(file)]);
    S.poseOn = true;
    save(); renderPose(); updateSummary();
  } catch (err) { toast("Couldn't upload the sketch: " + err.message); }
}
function renderPose() {
  const has = !!S.poseUpload, sup = poseSupport();
  $("poseDrop").classList.toggle("has", has);
  $("poseImg").src = has ? inputUrl(S.poseUpload) : "";
  $("poseClear").style.display = $("poseOpts").style.display = has ? "" : "none";
  if (!has) return;
  $("poseOn").checked = S.poseOn; $("poseKind").value = S.poseKind; $("poseDark").checked = !!S.poseDark;
  $("poseStrength").value = S.poseStrength; $("poseStrengthV").textContent = Number(S.poseStrength).toFixed(2);
  $("poseKindWrap").style.display = ["sdxl", "anima", "klein"].includes(S.engine) ? "" : "none";
  $("poseCtl").style.display = sup && sup !== "klein" ? "" : "none";
  $("poseDark").parentElement.style.display = S.poseKind === "pose" ? "none" : "";
  const shape = (() => {   // same pixel count as 832×1216 at the sketch's aspect ratio
    const z = S.poseSize; if (!z) return null;
    const a = z.w / z.h, area = 832 * 1216, r64 = (v) => Math.max(512, Math.round(v / 64) * 64);
    return { w: r64(Math.sqrt(area * a)), h: r64(Math.sqrt(area / a)) };
  })();
  $("poseShape").style.display = shape && (shape.w !== S.w || shape.h !== S.h) ? "" : "none";
  if (shape) $("poseShape").textContent = `Match the sketch's shape (${shape.w} × ${shape.h})`;
  const img2img = refActive() && !(S.engine === "klein" && S.kleinRefMode === "reference");
  const onlyPose = S.poseKind === "pose";
  let note = sup === "cn" ? `Using ${stem(poseNet().name)}${onlyPose ? " on the skeleton SDPose finds in the picture" : ""}.`
    : sup === "lllite" ? `Using ${stem(animaPatch())} (Anima ControlNet-LLLite).`
    : sup === "klein" ? "Klein reads the sketch as an extra reference image for the pose and expression."
    : onlyPose && (S.engine === "anima" || S.engine === "klein") ? `${ENGINE_LABEL[S.engine]} can't copy only the pose. Use Illustrious / Pony for that, or pick line art or a rough sketch above.`
    : onlyPose && S.engine === "sdxl" && !lists.sdpose.length ? "Needs sdpose_wholebody_fp16 in models/checkpoints. Restart ComfyUI after adding it."
    : S.engine === "sdxl" ? (onlyPose ? "Needs an openpose or Union ControlNet in models/controlnet." : "Needs a ControlNet model in models/controlnet.") + " Restart ComfyUI after adding one."
    : S.engine === "anima" ? "Needs an Anima LLLite model (e.g. anima-lllite-any-test-like-v2) in models/model_patches."
    : `${ENGINE_LABEL[S.engine]} can't follow a sketch. Use Illustrious / Pony, Anima or Klein.`;
  if (sup && img2img) note += " The reference image is also on, so the picture starts from it; turn it off if the pose doesn't come through.";
  $("poseNote").textContent = note;
}
$("poseDrop").onclick = () => $("poseFile").click();
$("poseDrop").onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); $("poseFile").click(); } };
$("poseFile").onchange = () => { setPose($("poseFile").files[0]); $("poseFile").value = ""; };
for (const t of ["dragenter", "dragover"]) $("poseDrop").addEventListener(t, (ev) => { ev.preventDefault(); $("poseDrop").classList.add("over"); });
for (const t of ["dragleave", "drop"]) $("poseDrop").addEventListener(t, (ev) => { ev.preventDefault(); $("poseDrop").classList.remove("over"); });
$("poseDrop").addEventListener("drop", async (ev) => {
  const f = ev.dataTransfer.files[0];
  if (f) return setPose(f);
  const url = ev.dataTransfer.getData("text/uri-list") || ev.dataTransfer.getData("text/plain");   // dragged from results
  if (!url) return;
  try { const b = await (await fetch(url)).blob(); setPose(new File([b], "sketch.png", { type: b.type })); }
  catch { toast("Couldn't read that image — save it and drop the file instead."); }
});
$("poseClear").onclick = () => { S.poseUpload = null; S.poseSize = null; save(); renderPose(); updateSummary(); };
$("poseOn").onchange = () => { S.poseOn = $("poseOn").checked; save(); updateSummary(); };
$("poseKind").onchange = () => { S.poseKind = $("poseKind").value; save(); renderPose(); };
$("poseDark").onchange = () => { S.poseDark = $("poseDark").checked; save(); };
$("poseStrength").addEventListener("input", () => { S.poseStrength = Number($("poseStrength").value); $("poseStrengthV").textContent = S.poseStrength.toFixed(2); save(); });
$("poseShape").onclick = () => {
  const z = S.poseSize; if (!z) return;
  const a = z.w / z.h, area = 832 * 1216, r64 = (v) => Math.max(512, Math.round(v / 64) * 64);
  S.w = r64(Math.sqrt(area * a)); S.h = r64(Math.sqrt(area / a));
  S.size = [...$("size").options].some(o => o.value === `${S.w}x${S.h}`) ? `${S.w}x${S.h}` : "custom";
  save(); renderSettings();
};

// ---------- PixAI-style shell: history sidebar, model card, settings panel tabs ----------
// Newest finished image of this workspace that matches, for thumbnails.
function latestImage(match) {
  for (const b of batches) if (match(b)) { const c = b.cells.find(x => x.image); if (c) return c.image; }
  return null;
}
const ENGINE_TAGLINE = { sdxl: "Anime & illustration · tag prompts · Keep face", sd15: "Anime · tag prompts · light and fast",
  anima: "Anime · tag prompts · Keep face", klein: "Photoreal · sentences · reference editing", zimage: "Photoreal · sentences · renders text" };
const thumbOrInitials = (box, image, label) => {
  box.innerHTML = "";
  box.append(image ? el("img", { src: thumbUrl(image, 128), alt: "", loading: "lazy" }) : document.createTextNode(label.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase()));
};
function renderEngineThumbs() {
  for (const b of $("engineSeg").children) thumbOrInitials(b.querySelector(".qimg"), latestImage(x => x.engine === b.dataset.e), b.textContent);
  const e = E(), name = e.model ? stem(e.model) : "No model selected";
  $("mcName").textContent = name;
  $("mcEng").textContent = ENGINE_LABEL[S.engine] || S.engine;
  $("mcTag").textContent = ENGINE_TAGLINE[S.engine] || "";
  thumbOrInitials($("mcImg"), latestImage(x => x.model === e.model) || latestImage(x => x.engine === S.engine), name);
  $("heroBadge").textContent = `${ENGINE_LABEL[S.engine] || S.engine} · ${name}`;
}
function renderHistory() {
  const box = $("history"); box.innerHTML = "";
  const q = $("histSearch").value.trim().toLowerCase(), now = Date.now();
  let group = null;
  for (const b of batches) {
    if (q && !`${b.prompt} ${b.charName || ""} ${b.model}`.toLowerCase().includes(q)) continue;
    const age = now - b.id;
    const g = age < 3600e3 ? "Within 1 hour" : age < 86400e3 ? "Today" : age < 7 * 86400e3 ? "This week" : "Earlier";
    if (g !== group) { group = g; box.append(el("div", { class: "hgroup", text: g })); }
    const done = b.cells.filter(c => c.image), busy = b.cells.some(c => !c.image && c.pid && (c.status === "queued" || c.status === "running"));
    box.append(el("div", { class: "htile", title: b.prompt,
      onclick: () => { if (done.length) openLb(b, b.cells.indexOf(done[0])); else { showTab("results"); const n = $("b-" + b.id); if (n) n.scrollIntoView({ behavior: "smooth" }); } } },
      done.length ? el("img", { src: thumbUrl(done[0].image), loading: "lazy", alt: "" }) : el("div", { class: "hph", text: busy ? "Generating…" : "No image" }),
      b.cells.length > 1 ? el("span", { class: "hcount", text: `${done.length}/${b.cells.length}` }) : null));
  }
  if (!box.children.length) box.append(el("div", { class: "hint", style: "grid-column:1/-1", text: batches.length ? "Nothing matches." : "Your images show up here." }));
}
$("histSearch").addEventListener("input", renderHistory);
$("model").addEventListener("change", renderEngineThumbs);

function showPane(p) {
  p = ["model", "char", "settings"].includes(p) ? p : "model"; store.set("pane", p);
  for (const b of $("ptabs").children) b.classList.toggle("on", b.dataset.p === p);
  for (const d of document.querySelectorAll(".ppane")) d.style.display = d.dataset.pane === p ? "" : "none";
}
$("ptabs").addEventListener("click", (ev) => { const b = ev.target.closest("[data-p]"); if (b) showPane(b.dataset.p); });
showPane(store.get("pane", "model"));
// The settings panel drops down from the top-right pull-down instead of taking a whole column.
const paneSel = $("paneSel");
const setPaneOpen = (p) => { paneSel.value = p || ""; document.body.classList.toggle("paneopen", !!p); if (p) showPane(p); };
paneSel.addEventListener("change", () => setPaneOpen(paneSel.value));
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && document.body.classList.contains("paneopen")) setPaneOpen(""); });
document.addEventListener("pointerdown", (ev) => {
  if (document.body.classList.contains("paneopen") && !ev.target.closest("aside.panel, #paneSel, .lb, .modal, dialog")) setPaneOpen("");
});
const openSection = (id) => { const s = $(id); s.classList.remove("collapsed"); s.scrollIntoView({ behavior: "smooth", block: "start" }); };

for (const c of document.querySelectorAll(".chip")) c.onclick = () => {
  const go = c.dataset.go;
  if (go === "lib") { openTags("lib"); $("libSearch").focus({ preventScroll: true }); }
  else if (go === "ref") { showPane("char"); openSection("refSection"); }
  else if (go === "seq") { S.seq.on = !S.seq.on; save(); renderSeq(); updateSummary(); if (S.seq.on) $("seqStory").focus(); }
  else if (go === "pose") { showPane("char"); openSection("poseSection"); if (!S.poseUpload) $("poseFile").click(); }
  else if (go === "idea") { const open = $("composer").classList.toggle("ideaopen"); c.classList.toggle("on", open); if (open) $("idea").focus(); }
  else if (go === "sent") showSentences(true);
  else if (go === "vid") showVideo(true);
};

// 📝 Tags → sentences: the prompt writer turns raw tags into a few flowing sentences (Klein and Z-Image read sentences
// best; any model accepts them). Nothing changes in the prompt until you press Use as prompt.
function showSentences(on) {
  $("sentBox").style.display = on ? "" : "none";
  for (const c of document.querySelectorAll('.chip[data-go="sent"]')) c.classList.toggle("on", on);
  if (on) { if (!$("sentTags").value.trim()) $("sentTags").value = S.prompt; $("sentTags").focus(); }
}
$("sentOff").onclick = () => showSentences(false);
$("sentFromPrompt").onclick = () => { $("sentTags").value = S.prompt; };
$("sentGo").onclick = async () => {
  const tags = $("sentTags").value.trim(), st = $("sentStatus");
  if (!tags) return toast("Paste some tags first");
  $("sentGo").disabled = true; st.textContent = "Writing sentences…";
  try {
    const r = await post("/lora-lab/llm/sentences", { tags, sentences: Number($("sentCount").value) || 4, model: $("llmModel").value, sfw: mode === "general" });
    $("sentOut").value = r.text; st.textContent = "";
  } catch (err) { st.textContent = ROUTE_MISSING.test(err.message) ? "Restart Kōbō once to enable this." : "Failed: " + err.message; }
  finally { $("sentGo").disabled = false; }
};
$("sentUse").onclick = () => {
  if (!$("sentOut").value.trim()) return toast("Make the sentences first");
  S.prompt = $("prompt").value = $("sentOut").value.trim(); save(); updateSummary(); toast("Prompt replaced", true);
};
// execCommand also works over plain http on the LAN, where navigator.clipboard is missing.
$("sentCopy").onclick = () => { $("sentOut").select(); toast(document.execCommand("copy") ? "Copied" : "Select the text and copy it", true); };
// The image tile in the composer stands in for the Reference images section.
function syncComposerRef() {
  const tile = $("composerRef"), own = $("drop").classList.contains("has") && $("refImg").getAttribute("src");
  const ch = activeChar(), charImg = !own && ch && ch.ref && (S.charUse.ref || S.charUse.face !== false) ? inputUrl(ch.ref) : "";
  $("composerRefImg").src = own || charImg || "";
  tile.classList.toggle("has", !!(own || charImg));
  tile.classList.toggle("char", !!charImg);
  tile.title = own ? "Reference image (click to change)" : charImg ? `${ch.name}'s reference image` : "Add a reference image: click, or drop an image here";
}
new MutationObserver(syncComposerRef).observe($("drop"), { attributes: true, subtree: true, attributeFilter: ["src", "class"] });
$("composerRef").onclick = () => { showPane("char"); openSection("refSection"); if (!$("drop").classList.contains("has")) $("refFile").click(); };
for (const t of ["dragenter", "dragover"]) $("composerRef").addEventListener(t, (ev) => { ev.preventDefault(); $("composerRef").classList.add("over"); });
$("composerRef").addEventListener("dragleave", () => $("composerRef").classList.remove("over"));
$("composerRef").addEventListener("drop", (ev) => {
  ev.preventDefault(); $("composerRef").classList.remove("over");
  $("drop").dispatchEvent(new DragEvent("drop", { dataTransfer: ev.dataTransfer, bubbles: true, cancelable: true }));
});
$("openLib").onclick = () => { openTags("lib"); $("libSearch").focus({ preventScroll: true }); };
$("openFinder").onclick = () => { openTags("finder"); $("tfTag").focus({ preventScroll: true }); };
function openTags(which) {
  const d = $("tagDrawer"); d.dataset.show = which; d.classList.add("on");
  $(which === "lib" ? "libCard" : "tfCard").classList.remove("collapsed");
  for (const b of d.querySelectorAll(".tdhead [data-show]")) b.classList.toggle("on", b.dataset.show === which);
}
$("tagDrawer").querySelector(".tdhead").addEventListener("click", (ev) => { const b = ev.target.closest("button[data-show]"); if (b) openTags(b.dataset.show); });
$("tagDrawerClose").onclick = () => $("tagDrawer").classList.remove("on");
$("viewSeg").addEventListener("click", (ev) => { const b = ev.target.closest("[data-v]"); if (b) { resultView = b.dataset.v; store.set("resultView", resultView); renderStage(); } });
document.querySelector(".mixseg").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-mix]"), box = $("loraMix");
  if (b && box.checked !== (b.dataset.mix === "1")) box.click();
});
$("expandPrompt").onclick = () => $("composer").classList.toggle("big");
$("newImage").onclick = () => { showTab("results"); $("canvas").scrollTo({ top: 0, behavior: "smooth" }); $("prompt").focus(); $("prompt").select(); };
const applyNav = () => document.body.classList.toggle("navmin", !!store.get("navmin", false));
$("sideToggle").onclick = () => { store.set("navmin", !store.get("navmin", false)); applyNav(); };
applyNav();
// ↻ Restart: the Kōbō app restarts ComfyUI (server changes), then the page reloads (page changes).
// If ComfyUI wasn't started by the Kōbō app, only the page can be reloaded.
$("restartBtn").onclick = async () => {
  const q = await api("/queue").catch(() => null);
  const busy = q ? q.queue_running.length + q.queue_pending.length : 0;
  if (busy && !confirm(`${busy} job${busy > 1 ? "s are" : " is"} running or waiting and will be stopped. Restart anyway?`)) return;
  const btn = $("restartBtn");
  btn.disabled = true; btn.textContent = "↻ Restarting…";
  try { await post("/lora-lab/restart", {}); }
  catch (err) {
    toast(err.message === "not_launcher" ? "ComfyUI was started outside the Kōbō app, so only the page is reloaded."
      : ROUTE_MISSING.test(err.message) ? "Close and reopen the Kōbō app once to turn on ↻ Restart. Reloading the page for now."
      : "Couldn't restart ComfyUI: " + err.message + ". Reloading the page.");
    return setTimeout(() => location.reload(), 2500);
  }
  // Wait for ComfyUI to go down and come back, then reload.
  const t0 = Date.now();
  let wentDown = false;
  while (Date.now() - t0 < 300000) {
    await new Promise(r => setTimeout(r, 1500));
    const up = await fetch("/system_stats", { cache: "no-store" }).then(r => r.ok, () => false);
    if (!up) wentDown = true;
    else if (wentDown) return location.reload();
  }
  btn.disabled = false; btn.textContent = "↻ Restart";
  toast("ComfyUI didn't come back after 5 minutes. Close and reopen the Kōbō app.");
};
// 📱 Devices: the address (and QR code) other devices on the same Wi-Fi can open.
$("devBtn").onclick = async () => {
  let dlg = $("devDlg");
  if (!dlg) { dlg = el("dialog", { id: "devDlg" }); document.body.append(dlg); dlg.addEventListener("click", (ev) => { if (ev.target === dlg) dlg.close(); }); }
  dlg.replaceChildren(el("h3", { text: "Open Kōbō on another device" }), el("p", { text: "Looking up this computer's address…" }));
  dlg.showModal();
  const info = await api("/lora-lab/devices").catch(() => null);
  const close = el("button", { class: "btn", text: "Close", onclick: () => dlg.close() });
  if (!info) return dlg.replaceChildren(el("h3", { text: "Open Kōbō on another device" }),
    el("p", { text: "This needs the newer Kōbō server. Press ↻ Restart once, then try again." }), close);
  if (!info.lan || !info.urls.length) return dlg.replaceChildren(el("h3", { text: "Open Kōbō on another device" }),
    el("p", { text: info.note ? info.note : info.lan ? "This computer isn't connected to a network right now." : "ComfyUI only accepts this computer at the moment. Start it with --listen 0.0.0.0 (the Kōbō app does this) so phones and other PCs on your Wi-Fi can connect." }), close);
  const url = info.urls[0];
  const qr = el("img", { class: "qr", alt: "QR code for " + url, src: "/lora-lab/devices/qr?text=" + encodeURIComponent(url) });
  qr.onerror = () => qr.remove();
  dlg.replaceChildren(el("h3", { text: "Open Kōbō on another device" }),
    el("p", { text: "Scan with your phone's camera, or type the address into any browser on the same Wi-Fi." }), qr,
    ...info.urls.map(u => el("div", { class: "devurl" }, el("code", { text: u }),
      el("button", { class: "btn sm", text: "Copy", onclick: async () => (await copyText(u)) ? toast("Address copied", true) : toast("Couldn't copy: select the address instead.") }))),
    // On a cloud GPU (Kōbō Cloud, info.note set) other devices go through the PC's SSH tunnel instead of ComfyUI.
    el("ol", {}, el("li", { text: info.note ? "Keep the PC that started the cloud GPU on, with its SSH window open; pictures are still made on the cloud GPU."
        : "Keep this computer on and ComfyUI running; everything still runs on this PC's GPU." }),
      el("li", { text: "On a phone, use the browser menu → Add to Home screen to get a Kōbō app icon." }),
      el("li", { text: info.note ? "If it doesn't load: in Windows Security → Firewall → Allow an app, tick Private for OpenSSH SSH Client (Windows asks the first time), and make sure this Wi-Fi is set to Private."
        : "If it doesn't load: in Windows Security → Firewall → Allow an app, tick Private for Python (ComfyUI), and make sure this Wi-Fi is set to Private." })),
    close);
};
$("themeBtn").onclick = () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  if (dark) document.documentElement.dataset.theme = "dark"; else delete document.documentElement.dataset.theme;
  store.set("theme", dark ? "dark" : "light");
};
$("modeMini").onclick = () => switchMode(mode === "adult" ? "general" : "adult");

// ---------- 📦 Models ----------
// Downloads from modelcatalog.json on the server, one at a time in the background (it keeps going with the window
// closed). The standalone app (edition.standalone) opens this by itself while there's nothing to draw with.
let edition = { standalone: false }, mdlState = null, mdlPicked = null, mdlPolling = false;
const mdlSize = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.max(1, Math.round(n / 1e6)) + " MB";
const hasDrawModel = () => lists.checkpoints.some(n => !is3dCheckpoint(n)) || lists.diffusion_models.length > 0 || lists.unet_gguf.length > 0;
async function mdlPoll() {
  if (mdlPolling) return;
  mdlPolling = true;
  try {
    while (true) {
      const st = await api("/lora-lab/models").catch(() => null);
      const was = mdlState && mdlState.job.state === "running";
      if (st) { mdlState = st; renderModels(); }
      if (!st || st.job.state !== "running") {
        if (was && st) {
          await Promise.all([loadModels(), loadLoras()]).catch(() => {});
          renderSettings(); loadLlmModels();
          toast(st.job.state === "done" ? "Models downloaded and ready" : st.job.state === "cancelled" ? "Download stopped; it carries on from there next time"
            : "Download stopped: " + st.job.error, st.job.state === "done");
        }
        return;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  } finally { mdlPolling = false; }
}
async function openModels(welcome) {
  let dlg = $("mdlDlg");
  if (!dlg) { dlg = el("dialog", { id: "mdlDlg" }); document.body.append(dlg); }
  dlg.welcome = welcome;
  dlg.replaceChildren(el("h3", { text: "Models" }), el("p", { text: "Loading…" }));
  if (!dlg.open) dlg.showModal();
  mdlPicked = null;
  await mdlPoll();
  if (!mdlState) dlg.replaceChildren(el("h3", { text: "Models" }),
    el("p", { text: "This needs the newer Kōbō server. Press ↻ Restart once, then try again." }),
    el("div", { class: "mdlfoot" }, el("span", { class: "grow" }), el("button", { class: "btn", text: "Close", onclick: () => dlg.close() })));
}
function renderModels() {
  const dlg = $("mdlDlg"), st = mdlState;
  if (!dlg || !dlg.open || !st) return;
  const job = st.job, running = job.state === "running";
  if (!mdlPicked) mdlPicked = new Set(st.items.filter(i => i.recommended && !i.installed).map(i => i.id));
  const want = st.items.filter(i => mdlPicked.has(i.id) && !i.installed);
  const total = want.reduce((n, i) => n + i.missing, 0);
  const kids = [el("h3", { text: dlg.welcome ? "Welcome to Kōbō: pick your models" : "Models" }),
    el("p", { text: dlg.welcome ? "Kōbō needs at least one drawing model and the AI writer. The recommended set is ticked; you can add more any time from 📦 Models at the top."
      : "Download drawing models, the AI writer and helpers. Files go into Kōbō's models folder; you can also copy your own .safetensors files there." })];
  if (!st.ollama) kids.push(el("p", { text: "Ollama isn't running, so the AI writer can't be downloaded right now. The Kōbō app starts it; otherwise install it from ollama.com." }));
  if (running) {
    const item = st.items.find(i => i.id === job.current), pct = job.total ? Math.min(100, job.bytes / job.total * 100) : 0;
    kids.push(el("p", { text: `Downloading ${job.done.length + 1} of ${job.ids.length}: ${item ? item.name : ""}${job.file ? " · " + job.file : ""}` }),
      el("div", { class: "mdlbar" }, el("i", { style: `width:${pct.toFixed(1)}%` })),
      el("p", { text: job.total ? `${mdlSize(job.bytes)} of ${mdlSize(job.total)}${job.speed ? ` · ${mdlSize(job.speed)}/s · about ${Math.ceil((job.total - job.bytes) / job.speed / 60)} min left for this file` : ""}` : "Starting…" }));
  } else if (job.state === "error") kids.push(el("p", { text: "The last download stopped: " + job.error }));
  for (const g of st.groups) {
    const items = st.items.filter(i => i.group === g.id);
    if (!items.length) continue;
    kids.push(el("h4", { text: g.name }));
    for (const i of items) {
      const box = el("input", { type: "checkbox", checked: i.installed || mdlPicked.has(i.id) ? "" : null, disabled: i.installed || running ? "" : null,
        "aria-label": i.name, onchange: (ev) => { ev.target.checked ? mdlPicked.add(i.id) : mdlPicked.delete(i.id); renderModels(); } });
      kids.push(el("label", { class: "mdlrow" }, box, el("b", { text: i.name + (i.recommended ? " ★" : "") }),
        i.installed ? el("span", { class: "ok", text: "✓ installed" }) : el("span", { class: "sz", text: mdlSize(i.missing) + (i.vram ? ` · ${i.vram} GB+ GPU` : "") }),
        el("small", { text: i.about }), i.license ? el("small", { class: "lic", text: "License: " + i.license }) : null));
    }
  }
  kids.push(el("div", { class: "mdlfoot" },
    el("span", { class: "sz grow", text: running ? "Downloads keep going if you close this window." : want.length ? `${want.length} to download · ${mdlSize(total)}` : "Nothing ticked" }),
    running ? el("button", { class: "btn", text: "Stop", onclick: () => post("/lora-lab/models/cancel", {}).catch(e => toast(e.message)) })
      : el("button", { class: "btn primary", text: "⬇ Download", disabled: want.length ? null : "", onclick: async () => {
        try { await post("/lora-lab/models/get", { ids: want.map(i => i.id) }); } catch (e) { return toast(e.message); }
        mdlPoll();
      } }),
    el("button", { class: "btn", text: "Close", onclick: () => dlg.close() })));
  const top = dlg.scrollTop;
  dlg.replaceChildren(...kids);
  dlg.scrollTop = top;
}
$("modelsBtn").onclick = () => openModels(false);

// ---------- toolbar ----------
$("generate").onclick = generate;
$("generate2").onclick = generate;
$("variations").onclick = () => generate({ variations: 10 });
$("cancel").onclick = async () => {
  const ids = [...jobs.keys()];
  if (!ids.length) return toast("Nothing queued from Kōbō", true);
  try {
    await post("/queue", { delete: ids.filter(id => id !== runningId) });
    if (runningId && jobs.has(runningId)) await post("/interrupt", { prompt_id: runningId });
  } catch (e) { toast("Cancel failed: " + e.message); }
  for (const id of ids) { const f = findJob(id); if (f && !f.c.image) { f.c.status = "error"; f.c.error = "Cancelled"; updateCell(f.b, f.idx); } jobs.delete(id); }
  saveBatches(); toast("Cancelled", true);
};
$("freeVram").onclick = async () => { try { await post("/free", { unload_models: true, free_memory: true }); toast("Models unloaded from VRAM", true); } catch (e) { toast(e.message); } };
$("clearResults").onclick = () => {
  if (jobs.size) return toast("Wait for the running images to finish (or Cancel) before clearing.");
  batches = []; saveBatches(); renderResults();
};

// ---------- boot ----------
(async () => {
  applyModeUI();
  applyAdvanced();
  initCollapsible();
  bindSettings();
  renderRef();
  // Anything left "in progress" from a previous session can't be tracked any more; re-check it against history.
  for (const b of batches) b.cells.forEach((c, idx) => { if (!c.image && c.pid && c.status !== "error") { c.status = "queued"; jobs.set(c.pid, { batchId: b.id, idx }); } });
  renderResults();
  connect();
  edition = await api("/lora-lab/edition").catch(() => edition);
  try { await Promise.all([loadModels(), loadLoras()]); }
  catch (e) { toast("Couldn't load model lists from ComfyUI: " + e.message); }
  // An 18+ workspace remembered without the age answer (e.g. a copied browser profile) goes back to General.
  if (edition.standalone && mode !== "general" && !store.get("ageOk", false)) switchMode("general");
  if (edition.standalone && !hasDrawModel()) openModels(true);
  renderSettings();
  showStoredRef();
  loadLibrary();
  loadTfSites();
  loadLlmModels();
  showTab(tab);
  if (tab !== "train") loadTrainJobs();
  if (tab !== "images") loadImages();   // which pictures are starred
  loadChars();
})();
})();
