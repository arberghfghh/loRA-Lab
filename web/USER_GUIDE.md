# Kōbō — User Guide

Kōbō is an app that runs on top of your own **ComfyUI**. You write one prompt, pick some LoRAs, and Kōbō makes
one image per LoRA with the same seed, so you can compare them side by side. It also helps you write prompts, keep
characters consistent, start from photos, and clean up images afterwards.

Everything runs on your own computer. Nothing is uploaded anywhere.

---

## 1. Before you start

**You need:**

- **ComfyUI** (recent version), with Kōbō installed in its `custom_nodes` folder. See the README for install steps.
- **At least one model** for the kind of image you want (see [Model types](#4-model-types)). No drawing models or LoRAs
  come with Kōbō: put your own in ComfyUI's model folders.
- **LoRAs** (optional) in ComfyUI's `models/loras` folder.

**Models** (left side) downloads the models Kōbō's tools use: the AI writer and TIPO for Ollama, and the helpers (upscaler, background remover, pose sketch, face
reference, PixAI tagger, Hunyuan3D). Tick what you want and press **⬇ Download**. ★ marks the recommended set, and
each model shows its size, the graphics memory it needs and its **license**. Some licenses don't allow selling the
pictures, for example Anima's. Downloads run one at a time in the background and keep going if you close the
window. **Stop** pauses them, and the next download carries on where it stopped. When they finish, the model lists
update by themselves.

**Open Kōbō:**

- In any browser: `http://127.0.0.1:8188/kobo` (use your ComfyUI port if it isn't 8188 — Comfy Desktop often uses 8000).

The dot at the top left turns **green** when Kōbō is connected to ComfyUI.

---

## 2. The screen at a glance

Tabs are on the left, your picture is in the middle with the prompt docked underneath it, and your setup is on the right.
It starts in dark mode; the moon button at the bottom left switches to light.

**Single and Contact sheet** (top of Image Generation) show your results two ways. **Single** shows one picture large
with the rest of its batch beside it; use the arrows to move between batches, and click the picture for upscale, remove
background, make 3D and image info. **Contact sheet** shows every picture, with columns by LoRA and rows by seed.

**Under the prompt:** **Write with AI** opens the idea box, **Tag library** opens the tags on the right (with TagFinder as
its second tab), and **Reference**, **Pose**, **Sequence** and **Sentences** open those tools.

**Left side** — where you go, grouped as Create, Write, Library and Train:

| Item | What it's for |
|---|---|
| **Image Generation** | The prompt box, **Generate**, the Tag library, TagFinder and your results. |
| **Stories** | Picture stories of 50+ images (Story workspace only; see [The Story workspace](#the-story-workspace)). |
| **Game Story** | The AI writes the story of a game as text: world, characters, quests, dialogue (see [Game Story](#game-story)). |
| **Novel** | The AI plans a novel and writes it chapter by chapter (see [Novel](#novel)). |
| **Chat** | Chat with a character who learns from your chats and remembers it next time (see [Chat](#chat)). |
| **Characters** | Create and edit characters (see [Characters](#9-characters)). |
| **Images** | All your pictures in folders (⭐ Favourites, one per character, stories), with delete (see [The Images tab](#the-images-tab)). |
| **Train LoRA** | Teach a model a character, outfit or style from your own images (see [Train a LoRA](#10-train-a-lora)). |
| **Image to 3D** | Turn an image into a 3D model (see [Turn an image into a 3D model](#turn-an-image-into-a-3d-model)). |
| **Models, Devices, Restart, Guide** | At the bottom left. **Guide** opens this page. |
| **General / Adult 18+ / Story** | Three separate workspaces (see [Workspaces](#12-workspaces-general-adult-18-and-story)). |
| **History** (top of Image Generation) | Every image you've made, newest first, in a drawer on the right. Search by prompt, character or model; click one to open it. |

On a phone the tabs sit in a strip along the bottom, with the images and prompt above and the setup below them.

**Right panel** — your setup, in three tabs:

| Tab | What's in it |
|---|---|
| **Model** | The model type and model file, and the **LoRAs** to compare (each ticked LoRA becomes a column). |
| **Character** | The active character, **Reference images** and the **Pose & expression sketch** (all optional). |
| **Settings** | Size, images per LoRA, seed, and **Sampling**: steps and CFG sliders, sampler and scheduler. |

Click a section's title to fold it away. Kōbō remembers which sections you folded.

**Status bar** (above the prompt) — the connection dot (green = ComfyUI is running), the queue, **↻ Restart** (restarts ComfyUI and reloads
the page, so new models and Kōbō updates are picked up — only works when you started ComfyUI from the Kōbō app)
and the light/dark switch.

**Shortcut chips** under the prompt box jump straight to the Tag library, Tag finder, Reference image, Character,
Pose sketch, Sequence or the AI writer.

---

## 3. Your first image (2 minutes)

1. In the right panel's **Model** tab, click a model type (for example **Illustrious / Pony**) and choose a model file.
2. Under **LoRA**, leave everything unticked for now. "Include a No LoRA image" makes one plain image.
3. In the **Prompt** box, type what you want. For Illustrious/Pony use comma-separated tags:
   `1girl, solo, long silver hair, golden eyes, black kimono, wooden bridge, cherry blossoms, night`
4. Press **Generate** (or **Ctrl+Enter**).
5. Watch the progress bar and live preview. Click the finished image to see it full size.

Now tick two or three LoRAs and press Generate again — they're used together in one image (for example a character
LoRA plus a style LoRA). Untick **Use the ticked LoRAs together** to get one column per LoRA instead, all with the
same seed, to compare them.

---

## 4. Model types

Pick the model type first; Kōbō sets good defaults for each.

| Model type | Best for | How to write prompts | Typical speed on a 6 GB GPU |
|---|---|---|---|
| **Illustrious / Pony** (any SDXL checkpoint) | Anime and illustration; realistic photos with a photo-real SDXL checkpoint | Tags: `1girl, long hair, red dress` | ~20–60 s |
| **SD 1.5** (any Stable Diffusion 1.5 checkpoint, e.g. NovelAI Anime V2) | Older anime and illustration models, SD1.5 LoRAs | Tags | ~15–40 s |
| **Anima** | Anime | Tags | ~40–60 s |
| **Klein** (FLUX.2 Klein 4B / 9B) | Photoreal images, editing photos, combining 2–3 reference images | Sentences: "A woman in a red dress on a balcony at night…" | ~60–120 s |
| **Z-Image** (Z-Image Turbo) | Photoreal ads and posters, readable text in images | Sentences; put text to render in "quotes" | ~60–90 s |

- **Pony** checkpoints are detected automatically and get Pony's quality tags (`score_9, score_8_up, …`).
- **SD 1.5 vs SDXL** checkpoints are told apart automatically (from the file itself), so each only shows up under its own model type. This needs `.safetensors` files.
- **SD 1.5 sizes:** most SD1.5 models want **512 × 768** (or 768 × 512 / 512 × 512, at the bottom of the Size list). NovelAI Anime V2 is the exception and handles up to ~1 MP (832 × 1216 is fine).
- Each model type has its own LoRAs. Kōbō reads each LoRA's built-in info and only lists the ones that fit.
- If a model type says *"No … model found"*, its files aren't in ComfyUI's model folders yet.

### Settings per model

Each model starts with its model type's defaults (see Settings). If you change steps, CFG, sampler or scheduler,
the change is kept **for that model only** and the line says *your settings for this model*; **↺ Recommended** puts
the recommended ones back. LoRA strengths are not changed per model.

### Several models at once

Under **Also generate with**, tick other models of the same type. One Generate then makes a separate result for
each model, with the same prompt, seed, LoRAs and character, each with **that model's own settings**.
The summary shows the total (e.g. *2 columns × 1 image × 3 models = 6 images*).

---

## 5. Comparing LoRAs

Each ticked LoRA becomes a **column**. Every column uses the **same seed**, so the only difference is the LoRA.

On each LoRA card:

- **Tick box** — include it in the next run.
- **Strength** (number box) — how strongly the LoRA applies. 0.6–1.0 is usual; lower is subtler.
- **Badges** — the model type it's for (SDXL, SD1.5, Anima, Klein, Z-Image) and **Pony** if it was trained on Pony.
- **18+** — moves the LoRA to the other workspace (see [Workspaces](#12-workspaces-general-adult-18-and-story)).
- Tick a LoRA to open its details:
  - **Trigger words** — words this LoRA needs. They're added to the start of your prompt for that column only.
  - **Trained tags** — the tags it was trained on. Click one to add it to the trigger words.
- **Switched on by its trigger word** — a LoRA whose file names its trigger word (LoRAs trained in Kōbō, or kohya
  LoRAs with "trigger word: …" in their training comment) is used even when it isn't ticked, whenever that word is in
  your prompt or the character's tags, e.g. `mia, 1girl, smile`. It uses its strength box. The summary under the
  prompt shows 🔑 and the LoRA's name when this happens.
- **Activation word** — your own word for any LoRA. Click 🔑 on its card (or tick it) and type the word, e.g.
  `inko` for inko_style_v2: whenever that word is in your prompt the LoRA is used, ticked or not. Whole words
  only, any capitals (`Inko` works, `pinkout` doesn't). It replaces the file's own trigger word, is saved for every
  workspace and device, and an empty box goes back to the file's word.

Other LoRA options:

- **All / None** — tick or untick every LoRA shown.
- **↻** — rescan the LoRA folder after you add new files.
- **Use the ticked LoRAs together in each image** (on by default) — every ticked LoRA is applied to the same image,
  each at its own strength; the column header lists them all (`style + character`). Off: one column per LoRA, to
  compare them. If two LoRAs fight (faces melt, colours burn), lower their strengths, e.g. 0.6 each.
- **Include a "No LoRA" image** — adds a plain column to compare against.
- **Images per LoRA** (right panel → **Settings**) — more images per column; each extra image uses the next seed.
- **Show LoRAs made for other model types** — shows them greyed out.

LoRAs trained on child-related content are **blocked** and never load. The LoRA section says which ones.

---

## 6. Writing prompts

### The prompt box

- **Tags or sentences?** Illustrious, Pony, SD 1.5 and Anima understand **tags**. Klein and Z-Image understand **sentences**.
- **Artist styles on Anima:** Anima only follows an artist tag written with **@** (`@wlop`). Type artist names as
  usual (`wlop`, `by wlop`, `artist:wlop`, `(wlop:1.2)`): when an Anima model is picked, Kōbō adds the @ to every
  Danbooru artist name before generating, wherever the tag comes from (prompt, character, Tag library, stories).
  The AI prompt writers never add artists on their own.
- **Quality tags & negative prompt** (fold-out under the prompt) — filled in automatically for each model type. Press
  **↺** to reset them. You rarely need to change these.
- **Negative** (box under the prompt) — what you don't want in the picture. It's the same text as the negative prompt in Settings, kept per model type; **↺** puts the model's default back.
- **Extra detail** (Settings, needs the Detail Daemon nodes) — Light, Medium or Strong adds finer detail (hair
  strands, fabric, background) at no extra time. Strong can look busy. Not for Klein.
- **Two people: keep their looks apart** (Settings, needs the Prompt Control nodes; Illustrious / Pony, SD 1.5 and
  Anima) — fill in **Person on the left** and **Person on the right** and put the scene and the people count
  (`1girl, 1boy`) in the prompt: each person's tags only act on their half of the picture, so hair, eyes and clothes
  don't swap or mix. With it ticked, stories, manga panels and game art with your character and one co-star split
  the two by themselves. On Illustrious / Pony a picture takes about twice as long with it (ComfyUI loads the model
  a slower way for it). Anima support is experimental in Prompt Control, and it's off with Keep face on Anima.
- 🔒 Safety terms are always added to the negative prompt; you can't remove them.
- **portrait / landscape** — type either word in the prompt or the idea line ("1girl, beach, landscape", "a knight
  by a campfire in portrait mode") and the image is made in that shape: the size flips to the matching one (832 × 1216
  ↔ 1216 × 832, square becomes 832 × 1216 or 1216 × 832). The word itself isn't sent to the model. For a head-and-shoulders shot use
  `close-up` or `upper body` instead.

### The assistant

The **Ask the assistant** line under the prompt lets you just say what you want: "make 4 pictures of Mia at the
beach at sunset, landscape", "2 more", "same but at night, no character", "write me a prompt for a knight". The local
AI model (the one picked in the Write with AI row) works out what you mean, then Kōbō does it: picks the character,
sets how many pictures and the shape, writes the prompt with the prompt writer and presses **Generate** with your
current model, LoRAs and settings. "Write me a prompt…" only writes the prompt. It remembers the last few things you
said, so "more" and "same but…" work. It takes a few seconds to answer, plus the usual time to write the prompt.

**Named characters.** Characters from anime and games ("Frieren", "Raiden Shogun", "Yor Forger") get their real
Danbooru tag in the prompt. **Genshin Impact** is fully known (every playable character up to 7.2, plus Paimon, in
`genshin.json`): nicknames work (Ayaka, Kazuha, Childe), lowercase works, and when one Genshin character is in the
picture their hair, eyes and features are added — plus their usual outfit unless you describe other clothes. The people
count follows who they are (Childe and Zhongli = 2boys). Characters on the game's child body model (Klee, Nahida, Qiqi,
Sayu…) are only drawn in the General workspace, in safe pictures.

### The AI prompt writer (optional)

Type an idea in the line under the prompt ("a knight resting by a campfire at night") and press **Write**
(or Enter). The AI writes a full prompt in the right style for your model type — tags or sentences. **Undo** brings
your old prompt back.

This needs [Ollama](https://ollama.com) running with a chat model (for example `ollama pull mistral`). On slower PCs
it can take a minute or two. If a character is active, the writer also reads that character's **Memory**.
**Auto** in the writer's model list uses qwen3.5-4b-main (Qwen 3.5 4B abliterated) when it's installed (then the 9B, Stheno, then others).
For anime tag models (Illustrious, Pony, Anima, SD 1.5) and **TIPOv2** installed in Ollama (`tipov2`), tag prompts
are made in two steps: the writer picks the key tags (who, place, action, light, framing), then TIPOv2, a small model
trained on Danbooru, adds the rest around them in about a second. With a character active, its hair, eye and body
guesses (and clothes, unless you asked for a new outfit) are dropped, since the character's own tags are added.

**Tags → sentences** (chip under the prompt) turns raw tags into a prompt written in sentences, for Klein and
Z-Image or anywhere sentences read better. Paste tags (or press **↓ Tags from prompt**), choose how many
**Sentences** (2–8) and press **Make sentences**. Every tag is kept and written as plain English (1girl → a woman);
nothing new is invented. Edit the result if you like, then **Use as prompt** (replaces the prompt) or **Copy**.

### The Tag library

Below the prompt box. Click a tag to add it to the prompt; click it again to remove it. Tags already in your prompt are
highlighted.

- **Categories** — Subject, Hair, Face, Body, Clothing, Pose, Setting, Camera & light, Style… Click **All** to see every tag.
- **Search** — type to filter.
- **Edit** —
  - Add your own tags (comma-separated) to the selected category, or to **My tags** if "All" is selected.
  - **+ From current prompt** saves every tag in your prompt into the category.
  - Click a tag to delete it; **Delete category** removes the whole category.
  - **New category** creates one. Categories you create in the Adult workspace stay in the Adult workspace.
  - **Paste & sort** — paste any amount of tags: prompts, caption files, or a tag list copied from a booru post
    (`long_hair blue_eyes …`). **Sort into categories** has the AI prompt writer's model (needs Ollama) file each new
    tag under the category it fits; tags already in the library are skipped, and tags no category fits go to **My tags**.
    Nothing is saved until you press **Add … tags to the library**. In the preview, click a tag to leave it out — or
    select a category at the top first, then click tags to move them there.

The tag library is saved on the computer running ComfyUI, so every device that opens Kōbō shares it.

### TagFinder

Finds tags that often appear together with a main tag on booru sites (for example *kimono* → *obi*, *floral print*,
*hair flower*). Type a main tag and press **Find**.

- Pick which **sites** to search, which **kind** of tags (general, characters, series) and which post **rating** to learn from.
- Click a tag to add it to the prompt. **🖼** shows example images for that tag; **→** searches that tag instead.
- **+ All to prompt** adds every tag shown; **Save to library** saves them into the selected Tag library category.
- Danbooru and Safebooru need no account. Gelbooru and Rule34 need an API key and user id, entered in the TagFinder app.

### Sequences (storyboards)

Press the **Sequence** chip to make one image per moment of a continuous action, like keyframes of a short film.

1. In the prompt box, describe what stays the same: who, outfit, place and time of day.
2. In the Sequence box, set the number of **Frames** (2–8) and describe what happens from start to finish
   ("she walks through the park from the entrance gate to the exit").
3. Press **Plan frames** — the AI writer splits the action into one line per frame. Edit any line you like.
4. Press **Generate**.

- **Same seed for every frame** keeps the character and lighting closer.
- **Keep the look of frame 1** (Klein only) uses the first finished frame as a reference for the rest.
- With a character, turn on **Keep face** too (see [Characters](#9-characters)).

---

## 7. Reference images

In the right panel's **Character** tab, open **Reference images** and drop a picture on **Image 1** (or paste with Ctrl+V, or click to choose).

### Get prompts from an image

As soon as you add Image 1, Kōbō reads it and writes ready-made prompts for each model type:

- **Copy** copies one; **Use** switches to that model type and puts it in your prompt.
- **Tagger: Kōbō** — one tagger made of **PixAI** and **Haruka** voting together (about 2 s per picture). It was
  the most accurate in tests against Danbooru's own tags, so it's what Kōbō uses unless you tick **Advanced**.
  The same choice is used by **Find tags** (Image info) and **Tags from image** (Characters).
- **Advanced** — pick the image readers yourself (remembered):
  - **WD** — the classic Danbooru tagger (runs on the CPU, ~4 s).
  - **PixAI** — knows about three times as many tags as WD, including ~4,900 artists (GPU, 1008 px, under 1 s after it loads). Its model lives in `models\pixai_tagger\pixai-tagger-v1.0`.
  - **Haruka** — a 2026 tagger with 98,800 tags; finds characters PixAI misses (CPU, ~1.5 s). `models\haruka_tagger`.
  - **e621** — furry-site words (species, creatures). Only for furry or creature pictures: on anime it guesses "anthro" and "fur".
  - **JoyCaption** — an uncensored vision AI that confirms borderline tags (needs the `joycaption-beta-one` model in Ollama). About 15–30 s per image and it didn't change the tags in our tests; better used through **Describe**. It runs alone and frees the GPU after, so avoid it while images are generating.
  - Greyed out = that model isn't installed. When several are ticked, the taggers' votes are averaged (PixAI counts most).
- **Tag threshold** — lower gives more tags, higher gives fewer. 0.35 is the tested default.
- **Most specific tags only** (on by default) — drops a tag that a more specific one already covers, using Danbooru's
  own list of which tags imply which (`bikini` goes when `o-ring bikini` is there, `smile` when `grin` is), and keeps
  only the strongest breast size and hair length. About a fifth fewer tags, same picture. The list is
  `tag_implications.json`; `python build_implications.py` downloads a fresh copy from Danbooru.
- **Include character and series names** with its **Name threshold** (default 0.60) — character and series names have
  their own slider, because a wrong name changes the whole picture. At 0.60 Kōbō kept about two thirds of the
  characters on recent Danbooru posts with almost no wrong names; raise it if a wrong one slips in.
- **Artist style** — PixAI's guesses at whose style the picture is in (up to 8, with a confidence score). Click one to add it to the prompts, click again to take it out; Anima gets it as `@name`, the other model types as the plain name, Klein not at all. PixAI knows about 4,900 well-known Danbooru artists, so treat it as a hint: unknown artists, mixed styles and LoRA styles usually give low scores or nothing. The Kōbō tagger includes PixAI; under Advanced, keep PixAI ticked (WD has no artist tags).
- **Text in the picture** — any writing the picture contains (signs, speech bubbles, captions, watermarks), read by a small OCR model on the CPU (about half a second). It reads English, Japanese, Chinese and most European languages; very stylised lettering may come out wrong. Only shown when there is text. Press **Copy** to copy it.
- **Klein / Z-Image** — press **Describe**: JoyCaption looks at the picture itself (colours, light, framing) and writes sentences, using the tags as hints for names (about half a minute). Without JoyCaption, the AI prompt writer turns the tags into sentences instead.
- **Negative prompt on Turbo (Anima)** — NAG, from the ComfyUI-Anima-NAG pack. The Turbo presets run at CFG 1, where the negative prompt is ignored; NAG brings it back. It is only applied at CFG 1.5 or lower and is on by default.
- **Spectrum (Anima)** — the ComfyUI-Spectrum-KSampler pack. It predicts most steps instead of running the full model on each, so it is faster, at a small cost in detail. It replaces **Speed up (TeaCache)** while it is on. Off by default; compare a picture before you keep it.
- **Anima** — gets its sentences automatically: right after the tags appear, JoyCaption writes 3–4 sentences about the picture and each one goes in among the tags it is about: the opening sentence after the count and character tags, a sentence about her hair after the look tags, the outfit after the clothing tags, and so on (the button says "Looking…" meanwhile). Type something in **Focus on…** and press **Describe again** to redo them.

The WD tagger downloads (about 1.3 GB, once) the first time it's needed: when you tick it, or when PixAI and Haruka aren't installed. LoRA training reads your images with the Kōbō tagger (PixAI is unloaded before training starts, so it doesn't take GPU memory from it); the child-safety check uses whichever model is strictest. Reading the same picture again is instant, because Kōbō remembers the last 16 results.

### Start from the image

Tick **Use the reference images when generating**.

- **How much to change** — 0.3–0.5 stays close to the photo (same pose, colours, layout); 0.6 is balanced;
  0.8–1.0 only follows it loosely.
- **Match the image's shape** — sets the output size to the photo's proportions.
- **Klein mode:**
  - **Reference edit** (default) keeps the person and scene and changes what your prompt says
    ("make her dress blue"). Great for consistent faces.
  - **Image-to-image** works like the other model types.

### Two or three images

Under Image 1 you'll find **Image 2** (and **Image 3** with Klein).

**Klein** combines all the images (best for try-on and mixing a person with clothes or a scene):

- Adding Image 2 while on Klein switches the references on automatically.
- The summary under Generate shows "· 2 reference images" when both will be used.

**Illustrious / Pony** (any SDXL checkpoint) use Image 2 as a **"look like this" reference** through IP-Adapter
(optional: needs the ComfyUI_IPAdapter_plus node pack and its models — see the README):

- **Image 2 copies** — *Look & style* (clothes, colours, mood) or *Face* (keeps a character's face).
- **Strength** — 0.4–0.5 mixes the reference with your prompt; higher copies it more closely.
- It's slower than a normal image, especially on 6 GB GPUs.

**Anima** uses Image 2 through **SnapRef**: it draws the character in Image 2 in your scene (needs the Anima Ref Adapter
node and a `snapref_*.safetensors` in `models/loras`; Image 1 stays optional, as the starting picture):

- **Image 2 copies** — *Character & art style*, or *Character only* (style from the model and prompt).
- **Strength** — 1 is what SnapRef was trained on.
- Describe only the scene, pose and place; hair, eyes and outfit come from Image 2.

**Z-Image** can't use Image 2, and neither can Anima without SnapRef installed; you'll see a yellow note with a
**Switch to Klein** button.

### Pose & expression sketch

Below Reference images in the **Character** tab. Drop a sketch, storyboard frame or stick figure; the character takes
its pose and expression. Tick **Use the sketch when generating**.

- **What to copy**
  - *Only the pose and expression* (the default): drop any picture, even a photo or a finished image. Kōbō finds the
    body, hands and face in it, so the clothes, hair, body shape and background are not copied. Illustrious / Pony only.
  - *Clean line art* follows the lines and face closely, including outlines of clothes and hair.
  - *A rough sketch or stick figure* follows the pose loosely.
- **How closely to follow** — lower if the result looks stiff or copies the sketch's lines.
- **Dark lines on a light background** — tick for normal pencil drawings.
- **Match the sketch's shape** sets the image size to the sketch's proportions.

What each model type needs:

| Model type | Needs |
|---|---|
| Illustrious / Pony | A ControlNet model in `models/controlnet` (restart ComfyUI after adding one). *Only the pose* also needs `sdpose_wholebody_fp16` in `models/checkpoints` and an openpose ControlNet (`noob-sdxl-controlnet-openpose`, or the Union one). |
| Anima | An Anima LLLite model (for example `anima-lllite-any-test-like-v2`) in `models/model_patches`. Line art and rough sketches only. |
| Klein | Nothing — it reads the sketch as an extra reference image. Line art and rough sketches only. |
| SD 1.5, Z-Image | Can't follow a sketch. |

If a Reference image is also on, the picture starts from it; turn it off if the pose doesn't come through.

---

## 8. Recipes

### Virtual try-off (garment on white, "invisible mannequin")

1. Download the fal **virtual try-off** LoRA for Klein 9B into `models/loras`.
2. Model type **Klein**, model **Klein 9B**. Tick the try-off LoRA — its "TRYOFF…" text is filled in for you.
3. Drop a photo of someone wearing the outfit on **Image 1**, tick **Use the reference images**, Klein mode **Reference edit**.
4. Prompt: name the garment, e.g. `the red satin evening dress`. Generate.
5. In the viewer, press **Remove background** for a transparent PNG.

### Virtual try-on (person + top + bottom)

1. Put a virtual try-on LoRA for Klein 9B in `models/loras`. Model type **Klein**, model **Klein 9B**, tick the LoRA and
   type its trigger words.
2. **Image 1** = the person, **Image 2** = the top, **Image 3** = the bottom.
3. Prompt: describe the person and the clothes, e.g. `young woman with long dark hair, black oversized t-shirt and blue jeans`.

### An ad with headline text

1. Model type **Z-Image**.
2. Prompt in sentences, with the text in quotes:
   `Studio product shot of a white sneaker on a pastel podium, soft shadows, bold headline text "RUN LIGHTER"`.
3. Upscale the result with **⤢ Upscale 4×** for print sizes.

### Find the best style LoRA

Untick **Use the ticked LoRAs together**, tick 4–6 style LoRAs, tick **Include a No LoRA image**, set **Images per LoRA** to 2, and Generate. You get a grid with
two seeds per LoRA plus a plain baseline.

### Keep a character consistent

Create a character with a reference image and appearance tags (see the next section), then use **Klein → Reference edit**
with the character's reference image, or Illustrious/Pony with the character's LoRA.

> Licenses: Klein 9B is **non-commercial**. For paid work use Klein 4B, Z-Image or another model whose license allows it.

---

## 9. Characters

Characters save everything that makes a person look the same in every image.

### Create one

Go to the **Characters** tab → **+ New character**. Everything saves automatically.

| Field | What it does |
|---|---|
| **Reference image** | Drop or paste a picture. The first one also fills in Appearance and Outfit automatically. |
| **Name** and **Made for** | Name, and which model type the character is meant for. |
| **Name tag / trigger words** | A LoRA trigger word or a known character tag. |
| **Appearance** | Hair, eyes, body — things that don't change. |
| **Outfit** | Clothes — change this to change their outfit. |
| **Character LoRAs** | LoRAs added to every image of this character (each with its own strength). |
| **Extra negative tags** | Things to avoid for this character. |
| **Memory** | Personality, backstory, rules about how they look. The AI prompt writer reads this. |
| **Notes** | Your own notes. |

- **Tags from image** reads the reference image again and adds appearance and outfit tags.
- **Learn this character** trains a LoRA from their gallery so they look the same in any outfit and pose. Untick
  images where they don't look right (30 or more images works best), pick an Illustrious / Pony or Anima model to train on and
  press **Start learning**. When it's done, the LoRA is added to their **Character LoRAs** and its trigger word to
  their name tag.
- Tip: click into **Appearance** or **Outfit**, then click tags in the **Tag library** — they go into that field.

### Use one

In the right panel's **Character** tab, pick the character (or press **Use this character** in the editor). Then tick
what to use:

- **Appearance / Outfit** — added before your prompt, so your prompt only needs the scene ("sitting on a bridge, night").
- **Their LoRAs** — stacked under every column's LoRA, so you can still compare style LoRAs on top.
- **Reference image** — the character's image is used as the reference.
- **Keep face** — copies the face from their reference image, whatever the prompt or seed:
  - **Illustrious / Pony** — through IP-Adapter (needs the IP-Adapter node pack with `ip-adapter-plus-face_sdxl_vit-h`
    and a ViT-H CLIP vision model). **Face strength** 0.5 is a good start; higher copies more closely but can wash out colours.
  - **Klein** — reads the reference image directly.
  - **Anima** — draws the character beside the reference image and keeps only the new picture, so each image takes about
    twice as long. Paused while a Reference image or pose sketch is in use.
  - **SD 1.5 and Z-Image** can't copy a face; only the character's tags are used.

**With an empty prompt**, Generate gives the character a fresh look every time:

- **New outfit, pose & place, written by AI** (needs the AI prompt writer) or **…from the Tag library** (random tags).
  Their saved outfit is skipped so the clothes don't clash, and the last few looks are remembered so the next one is different.
- **Just the character as saved** — turns this off.
- In the Adult workspace, **Extra 18+ tags for every new look** are added to each new look for this character. The
  **+ category** buttons add a random tag from that Tag library category.
- **Random tags go with these tags** (Adult workspace) — random new-look tags and the **+ category** buttons prefer
  tags that often appear together with your Extra 18+ tags on Danbooru. With `sex`, for example, the Nudity, Sex acts,
  Positions and Face picks lean towards what goes with sex. This works for every category. A category with no related
  tags (often Hair, Clothing or Setting) picks as usual, and a category with only a few related tags uses them about half
  the time so the same tag doesn't repeat. The AI writer gets the closest related tags as suggestions. Each tag is
  looked up once on Danbooru (a few seconds, needs internet) as soon as you type it, so it's usually ready before you
  press Generate, and then remembered in this browser.
- **18+ only: the AI writes an explicit outfit, pose & place** (Adult workspace, AI looks only) — the AI writes a sexy
  outfit (lingerie, fetish wear or half undressed; none if the look is nude), a sexual pose and an intimate place.
- **Tags that make sense together:** new-look tags (random, AI-written or added with **+ category**) must fit your
  Extra 18+ tags, the character's appearance and each other. A look gets one place, one time of day, one pose or sex
  position, one framing, one gaze, one expression and one of each clothing piece. Clashes are left out: beach with a
  coat or snow, indoors with rain, a dress with a skirt, nude with clothes, completely nude with underwear, standing
  with knees up, a close-up with shoes, oral with a penetration position, holding things during sex, a second breast
  size. Objects filed under Setting (cup, weapon, food), "no humans" and hair or eye colours are never picked.
- **Nude looks:** if the extra tags (or your prompt) say `nude`, `naked` or `completely nude`, Kōbō drops every
  clothing tag it would add on its own — from the new look and from their saved Outfit. Underwear (bra, panties, thong,
  g-string, bikini, lingerie), stockings, thighhighs, high heels, sex toys and accessories (jewelry, glasses, hair
  ornaments) stay, except with `completely nude`. Tags you type yourself are never removed.

### Memory

Kōbō remembers, for each character and each workspace:

- **↺ Use last settings** — the model, size, LoRAs and strengths you last used with them.
- **Recent prompts** — your last 20 prompts with them; pick one to reuse it.
- **Gallery** — every image made with them. **★** marks a favourite (favourites come first);
  **⤴** makes that image their reference image. **⬇ Download all** saves the whole gallery as one `.zip`.
- **Rank by likeness** (needs the CCIP model from 📦 Models → Helpers, and a reference image) — sorts the gallery by
  how close each picture's character is to the reference image and marks each one **same**, **close** or
  **off-model**. It's made for anime pictures with one character; with two people in a picture the score is less
  reliable. Runs on the processor (about a third of a second per new picture). **Newest first** goes back.

Characters belong to the workspace you create them in.

---

## 10. Train a LoRA

The **Train LoRA** tab teaches a model a character, an outfit or an art style from 15–40 of your own images, using
ComfyUI's built-in training nodes.

1. Type a name under **New dataset name** and press **+ New**.
2. Set a **Trigger word** — a made-up word that will stand for what you're teaching, e.g. `mychar_v1`. It starts every caption.
3. Drop in your images (or paste, or click). Varied poses, angles, outfits and backgrounds work best.
4. Choose what you're **Teaching** (a character, an outfit or object, an art style) and press **Auto-caption**.
   - **Tag threshold** — lower gives more tags per image.
   - Edit any caption by hand. **Add to all / Remove from all** changes one tag in every caption — for an outfit,
     remove the tags that describe the outfit itself, so the trigger word learns it.
5. Under **Train**, pick the **Model type** (SD 1.5, Illustrious / Pony or Anima), the model to **Train on**, and a **LoRA name**.
   - **Anima** trains on a model from `models/diffusion_models` and uses the text encoder and VAE picked for Anima in the
     **Model** tab (normally `qwen_3_06b_base` and `qwen_image_vae`). The estimate line shows which ones. About 5 s per
     step at 768 px on a 6 GB GPU, so 1,500 steps take around two hours.
6. Press **Start training**. Progress shows under **Training runs**.

- **Steps**, **Size (rank)** and **Learning rate** have sensible defaults; *standard* is right for most characters,
  rank 32 helps detailed styles.
- Training uses the whole GPU, so images you generate meanwhile wait in the queue.
- Finished LoRAs are saved in `output/trained-loras` and appear in the LoRA list with their trigger word filled in.
- Every image is checked by the tagger first; images that look like a child can't be trained on.

To train on a character you've already made images of, use **Learn this character** in the Characters tab instead.

---

## 11. Results and the image viewer

Each Generate run adds a block to **Image Generation** with one column per LoRA (or one column for all of them when they're used together). The block's header shows the model, size,
steps, seed and character.

- **Reuse settings** — load that run's settings back into the right panel.
- **Remove** — delete the block from the list (the image files stay on disk).
- Toolbar: **Thumb size**, **Cancel queued**, **Free VRAM** (unloads models from the GPU), **Clear results**,
  **▶ Generate**.

**Click any image** to open the viewer:

- **← / →** keys move between images; **Esc** closes.
- **Open full size** and **Download**.
- **Fix face** — redraws the largest face at full size with the picture's own model, LoRAs and prompt, then blends it back in, about a minute. Use it when a face in a full-body picture comes out soft or uneven. Press it again on the result for another try. Needs the SDPose model, and doesn't work on Klein pictures. Saved in `output/LoRA-Lab/fixed`.
- **⤢ Upscale 4×** — needs an upscale model in `models/upscale_models`.
- **Upscale + redraw** (needs the Ultimate SD Upscale nodes) — makes the picture 2× bigger, then redraws it in 1024 px
  tiles with the picture's own model, LoRAs and prompt, so it gets real new detail instead of a smoothed blow-up. A few
  minutes. Works on pictures made here (not Klein). Saved in `output/LoRA-Lab/upscaled` as `redrawn_…`.
- **Remove background** — transparent PNG; needs a model in `models/background_removal`.
- **Make 3D** — sends the image to the **Image to 3D** tab.

Upscaled and cut-out images appear right after the original in the viewer and are saved in
`output/LoRA-Lab/upscaled` and `output/LoRA-Lab/cutouts`. Images of a character are saved in
`output/LoRA-Lab/characters/<name>/<date>/`, all others in `output/LoRA-Lab/<date>/`.

**Favourite:** hover over any image (in the results, the viewer or the Images tab) and press **☆** in its top-right
corner. It turns into a gold **★** and the image appears in **⭐ Favourites** in the Images tab. Press it again to
remove it. Favourites are saved on the ComfyUI PC, so they show on every device.

**⤢ Upscale all** (in the ⭐ Favourites folder) upscales every favourite 4× with Real-ESRGAN, one after another,
and skips favourites that already have an upscaled copy. Saved in `output/LoRA-Lab/upscaled`.

**⬇ Download all** (also in the ⭐ Favourites folder) saves every favourite at full size as one `Favourites.zip`.

### The Images tab

**Images** (left side) shows every picture in `output/LoRA-Lab`, newest first, in folders:

- **⭐ Favourites** and **All images**.
- **Characters:** one folder per character, made automatically for every new character (even before it has images).
- **Stories:** one folder per story.
- **Other:** **No character** (images made without a character), upscales, cut-outs and test folders.

Click an image to open it in the viewer. To delete:

- **🗑** on an image (hover over it) deletes that one image.
- **Select**, click the images you want (or **Select all** for the whole folder), then **Delete selected**.

Deleting asks you first and removes the file from disk for good. It also disappears from the results, the character's
gallery and its story. The General workspace only shows General characters and images made in General.

**Sets** (top right) opens the image sets panel: your own named groups of pictures, for example "Best of Yor" or
"Wallpapers". Type a name and press **＋ New**. To put pictures in a set, drag them onto it, or **Select** some and
press **＋ Add** on the set (with pictures selected, **＋ New** puts them straight into the new set). A picture can be in
several sets. Click a set to show its pictures; **➖** on a picture (or **Select** → **Take out of set**) takes it
out again. **✎** renames a set and **🗑** deletes it. Sets only group pictures: the files stay where they are, and a
picture you delete also leaves its sets. The General workspace only shows sets made in General.

**📤 Export for Patreon** on a set saves clean copies of its pictures in `output\Patreon-export\<set name>\`
(`<set name>_01.png`, `_02.png`…) and opens that folder. The copies keep only the picture: no prompt, workflow,
settings, model or LoRA names, and new file names. Upload those, not the originals. Your originals keep their data,
so Fix face, Upscale + redraw and Image Info still work on them. Exporting again replaces the old copies.

**📝 Clean prompts** on a set writes `<set name>_prompts.txt` into the same folder and opens it: each picture's
prompt, numbered like the exported copies. It leaves out what gives away how they were made: artist tags (`@name`,
`artist:`, `by …` and Danbooru artist names), model tags (`score_7`, `newest`, `year 2024`, rating tags,
`very aesthetic`, `absurdres`), your LoRA activation words and trigger words, and `<lora:…>` / `embedding:` syntax.
The subject, outfit, pose and scene stay. Pictures made outside Kōbō may have no prompt saved; the file says so.
Read it once before posting.

### Image Info: how a picture was made

The **Image Info** tab reads what the app that made a picture left inside the file. Drop the picture on it (or click to
choose one), or open any result in the viewer and press **Info**. It shows:

- **Made with:** the app (ComfyUI / Kōbō, AUTOMATIC1111, Forge, Civitai, NovelAI, Fooocus, InvokeAI, SwarmUI,
  Midjourney, or ChatGPT / Firefly / Gemini from their Content Credentials). It also shows any editor that saved it again
  afterwards, such as Photoshop.
- **Model and LoRAs** with their strengths, each marked **✓ you have it** or **not installed**.
- **Prompt, negative prompt, settings** (seed, steps, CFG, sampler, size, hires fix…) and other files it used (VAE, text
  encoder, ControlNet, upscaler). NovelAI pictures also list their **character prompts**.
- **Everything stored in the file** (at the bottom) shows the raw data.

**Use these settings** loads it all into Image Generation: the model and engine (if you have the model), the LoRAs you
have, the prompt, negative, seed, steps, CFG, sampler and size. NovelAI prompts are converted on the way:
`{{tag}}` → `(tag:1.1)`, `1.3::tag::` → `(tag:1.3)`, negative weights move to the negative prompt and `artist:` is
dropped. NovelAI's own model can't be downloaded, so NovelAI pictures keep your current model.

NovelAI also hides a copy of its settings in the picture's transparency, and Image Info reads it even after Photoshop
removed the normal info. Most other pictures lose their info when they're screenshotted, sent through Discord or X, or
copy-pasted from a web page: save the original file and drop that. When there's nothing to read, **Find tags** runs
the image tagger on the picture itself (tags, character, a guess at the artist style, and any text written in the
picture). **Use as prompt** then loads those tags.

### Turn an image into a 3D model

The **Image to 3D** tab turns one image into a coloured 3D model (`.glb`) using ComfyUI's built-in **Hunyuan3D** nodes.

1. Drop, paste or click to choose an image, or press **Make 3D** on any result in the viewer.
2. Optional: add **Back and sides** pictures (left side, back, right side). Drop your own into the three slots, or
   press **Draw them** to have Klein draw them from your picture (about 2 minutes each). With
   **Draw missing side and back views when I press Make 3D** on, it does this for you.
3. Press **Make 3D** (or Ctrl+Enter). The model appears in the viewer. Drag to rotate, scroll to zoom,
   right-drag to pan. Use **⬇ Download .glb** to open it in Blender, Windows 3D Viewer, etc.

- **Best input:** one object or character, fully in frame, facing the camera, on a plain background.
- **Back and sides:** "Left side" means the subject's own left (it faces the left edge of the picture). They fix the
  back of the model: without them the back is guessed, and painted from the nearest visible colours.
- **3D model:** *Auto* picks Hunyuan3D 2.0 MV when there are side/back pictures (it uses them for the shape too),
  otherwise Hunyuan3D 2.1 (best from one picture), otherwise 2.0.
- **Paint it with the picture's colours:** projects the picture (and the side/back views) onto the model.
- **Clean up:** removes the small floating bits Hunyuan leaves around hair and cloth and smooths the shading.
- **Faces** (next to Steps): how many faces (triangles) the 3D file gets. Leave it empty to keep all of them
  (about 300,000 at Normal detail; best quality). A smaller number gives a smaller file; at 150,000 or fewer the
  colours go into a texture. Thin cloth (capes, skirts) can tear when you cut the faces.
- **Mesh detail:** *Draft* is fastest; *High* is slower and needs more VRAM.
- Models are saved in `output/LoRA-Lab/3d/`, drawn views in `output/LoRA-Lab/3d/views/`. **Recent 3D models** lists
  the ones from this workspace; **Use source image** brings back its picture and views.

**Models:** put Hunyuan3D checkpoints in `models/checkpoints/3d/`:

- [hunyuan_3d_v2.1.safetensors](https://huggingface.co/Comfy-Org/hunyuan3D_2.1_repackaged/resolve/main/hunyuan_3d_v2.1.safetensors)
  (7.4 GB, Hunyuan3D 2.1 — best shapes from one picture; works on a 6 GB GPU),
- [hunyuan3d-dit-v2-mv_fp16.safetensors](https://huggingface.co/Comfy-Org/hunyuan3D_2.0_repackaged/resolve/main/split_files/hunyuan3d-dit-v2-mv_fp16.safetensors)
  (4.9 GB, Hunyuan3D 2.0 MV — uses the side and back pictures for the shape),
- [hunyuan3d-dit-v2_fp16.safetensors](https://huggingface.co/Comfy-Org/hunyuan3D_2.0_repackaged/resolve/main/split_files/hunyuan3d-dit-v2_fp16.safetensors)
  (4.9 GB, Hunyuan3D 2.0 — the original).

Drawing the side and back views needs a Klein model (Flux.2 Klein 9B or 4B) with its text encoder and the Flux.2 VAE.
These files are hidden from the SDXL model list. The 3D viewer is loaded from the internet the first time you open
the tab. Without internet you can still download the `.glb`.

---

## 12. Workspaces: General, Adult 18+ and Story

The **General / Adult 18+ / Story** switch at the top left flips between three completely separate workspaces. Each keeps its **own** prompt,
model choice, LoRA selection, reference images, characters and results.

**General:**

- Adult LoRAs are not listed and can't run.
- Adult tag categories are hidden.
- The AI prompt writer is told to keep things safe for work, and tags read from reference images skip explicit tags.

**Adult 18+** (for adults only; switching in asks you to confirm):

- Shows adult LoRAs; tick **Also show General LoRAs** to use General ones too.
- The app turns rose-coloured so you always know where you are.

A LoRA is sorted into Adult automatically when its training tags or name are explicit. If the guess is wrong, press
its **18+** button to move it. Your choice is saved for every device.

### The Story workspace

**Story** (third button of the switch; asks you to confirm) makes picture stories of 50+ images: one character (plus
an optional co-star), told scene by scene, like a comic or photo set. It has its own model, LoRAs and results, and
uses the characters of both other workspaces.

- **Models:** Anima (any Anima model and Anima LoRA) or Illustrious / Pony (any SDXL checkpoint) with every SDXL LoRA.
  LoRAs trained on animal sex are never listed here. A character's own LoRAs still apply.
- **Story from one line:** type the idea, e.g. *date at the beach between mia and leo*, choose the **Type**
  and press **Make story** (or Enter). The characters you name become the cast (the first one is the main character,
  the second the co-star). The AI writes the title, the chapters and every scene, then, with *Draw the images as soon
  as it's written* ticked, all 60 images are queued. To change the number of images, open **＋ New story** once and
  change **Images**; the one-line box uses that number.
- **From video** (in **＋ New story**): pick the character(s) and the **Type** first, then press it and choose a
  video. The page takes 12 frames spread over the video (skipping black screens), JoyCaption describes each one, and
  the prompt writer retells what happens with your characters in **What happens**. Edit it if you like, then press
  **Write story**. It takes 2-4 minutes, whatever the video's length; it only sees pictures, not sound, so it follows
  the main events rather than every moment. Title cards and logos are left out. It stops, without writing anything,
  if the video seems to show anyone under 18 (for 18+ types or sexual videos) or sexual content with an animal.
  Videos Chrome can't play (some MKV/AVI) need converting to MP4 first.
- **＋ New story:** pick the character (and co-star), the **Type**, how many **Images** (20–300) and **Versions per
  scene** (1–4, you pick the best one), then say what happens in a few sentences, or leave it empty.
  - **General**: safe for work.
  - **Explicit 18+**: builds up from teasing to sex; outfits stay on (opened or pulled aside), topless is fine.
  - **Nude 18+**: the same build-up, with the characters nude throughout.
  - **Dressed → nude 18+**: the same build-up, and the clothes come off as it goes: fully dressed for the first
    ~30% of the scenes, then undressing (themselves or their partner takes it off), then underwear or topless, and
    completely nude for the last ~30%. This happens on its own; you don't set anything. To fix one scene, open its
    **Image prompt** and change **Clothes** (👗 Dressed / 👚 Undressing / 👙 Underwear / Nude), then press ↻.
- **Write story:** the AI prompt writer (Ollama, on this PC) plans a title, a cover and chapters of about 10 scenes,
  then writes each chapter: a line of narration and an image prompt per scene. A 60-image story takes a few minutes.
  If it stops, **Write missing chapters** goes on where it left off.
- **▶ Draw all** queues every scene that doesn't have its images yet (cover first) with the Model panel's model and
  ticked LoRAs; progress shows in Image Generation too. **⏹ Stop** cancels what's queued.
- **Each scene:** edit its narration or image prompt, **↻** draws one more version, the small thumbnails pick which
  version the story uses, and **▯ Portrait / ▭ Landscape** sets its shape (with *Mix portrait and landscape* on,
  lying and wide scenes start as landscape).
- **Read** shows the story full screen, one scene per page with its narration (← → keys). **⬇ Download** saves
  the picked images in story order as `001.png, 002.png, …` in one .zip.
- Stories are saved on the ComfyUI PC (`user/default/lora-lab-stories`), so they open on every device; images are
  saved under `output/LoRA-Lab/stories/<title>/` and don't go into the character's gallery.

### Game Story

The **Game Story** tab (left side, every workspace) writes the story of a game you are building, draws its art from
the story (**Game art**) and builds it into an RPG Maker MV or MZ project (**RPG Maker**).

- **＋ New game:** say what the game is about in a line or a few sentences (or leave it empty), type a **Genre**
  (RPG, horror, visual novel…), an optional **Tone** and pick a **Size** (Small, Medium or Large: more places,
  characters and quests). Press **Write game story**.
- **Your characters in the game** (optional): tick any of your characters (from the Characters tab) and they are in
  the story under their own names and looks; **The player plays** picks one of them as the player character (or
  leave it to the AI). In 🎨 Game art their portraits and scenes are drawn with that character (look, LoRAs and face).
- The AI prompt writer (Ollama, on this PC) writes six parts, one after the other, each in line with the ones before:
  **Overview** (title, pitch, the player, story hook), **World** (setting, locations, factions, rules),
  **Characters** (look, personality, wants, secret), **Main story** (three acts, a twist, the endings),
  **Quests** (main and side quests with steps and rewards) and **Dialogue** (key scenes with the player's choices).
  A part takes one to three minutes (a Small game about 10 minutes in all, a Large one longer). It keeps writing when
  you open another tab; **⏹ Stop** stops after the current part and **Write missing parts** goes on later. Don't
  generate images meanwhile: the writer and the image model share the GPU and both slow to a crawl.
- **Each part** is a text box: edit it freely (saved as you type). **↻ Rewrite** has the AI write that part again,
  using your edits to the other parts; **Copy** copies it. A part that stops in the middle of a sentence ran out
  of room: finish it yourself or rewrite it.
- **Copy all** and **⬇ Download** give you the whole story as one Markdown (`.md`) text file, which opens in any
  text editor.
- Games made in the General workspace are kept safe for work and are the only ones General lists; Adult 18+ and Story
  list all of them. They are saved on the ComfyUI PC (`user/default/lora-lab-games`), so they open on every device.

#### 🎨 Game art

Under the parts (or **Art** at the top), the game's pictures, made from the story with the model, LoRAs and
settings selected on the right:

- a **Title screen**, a head-and-shoulders portrait of every **character** (they become the faces in the game's
  dialogue), a background of every **place** (with no people, so characters can walk over it) and an image of every
  **dialogue scene** (shown while the scene plays).
- **Make all art** reads the story, writes a prompt for every picture (the AI prompt writer, plus TIPOv2 for
  anime tag models) and draws every picture that has none yet, in one batch on the
  Results page. **Read the story** only updates the list after you changed the story: pictures that are still in
  it keep their prompt and images.
- **Art style** (e.g. "anime, cel shading, soft colours") goes into every new prompt: type it, then press 📖 Read the
  story and ✍ on the pictures to write again.
- On each picture: **Prompt** (edit it freely), **↻** another version, **✍** write the prompt again, **🗑** delete the
  shown version (the file stays in the Images tab); click a small version to use it. **Look from character** draws it
  with one of your characters (their look, LoRAs and face), so someone looks the same in every picture.
- The man/woman tags (1boy, 1girl) come from the story's descriptions, whatever the writer puts.

#### 🎮 RPG Maker

At the bottom of the game (or **RPG Maker** at the top). Needs RPG Maker **MV** or **MZ** on the ComfyUI PC
(e.g. from Steam).

- **Linking a project:** Kōbō finds RPG Maker and its projects by itself (Documents\Games, the other usual folders,
  Documents and the Desktop). While a game has no project, it looks every few seconds: make a new project in RPG Maker
  (**File → New Project**) and it is linked to the open game automatically. Older projects are listed with **Link**.
  Projects somewhere else: add their folder under **Where Kōbō looks** (also the place to pick RPGMV.exe if it
  isn't found).
- **Close the project in RPG Maker**, then press **Build game into project**. It writes:
  - the **player character** as actor 1 (the only party member), the rest of the cast as more actors, with faces from
    their portraits;
  - a **map per place** with its picture as the background (a parallax locked to the map, on an invisible walkable
    tileset "Kōbō parallax");
  - on each map: an **arrival** text the first time you come (on the first map, the story hook over the title
    picture), a **travel crystal** (or an exit tile) to go to any other place, and the **people** there: the
    dialogue scenes of that place with their choices and scene image, the quests they give, a reminder after that;
  - the **title screen** and the game's **title**, and the start position on the first quest's map.
- Then open it (**Open in RPG Maker**) and press **Playtest**. The maps have no walls yet (you can walk
  everywhere) and the people use RPG Maker's standard sprites: where nobody may walk, paint the second tile of the
  "Kōbō parallax" tileset (tab A5; invisible, but it blocks), and pick sprites, music and battles in RPG Maker as
  usual.
- **Build again** after changing the story or the art: only the maps, actors and tileset Kōbō made are
  replaced, your own maps and other changes stay. Before every build the project's `data` folder is backed up to
  `%LOCALAPPDATA%\Kōbō\rpg-backups\<project>\<date-time>` (the last 10 are kept): copy one back to undo a build.

### Novel

The **Novel** tab (left side, every workspace) writes a novel: text only.

- **＋ New novel:** say what it is about (or leave it empty), type a **Genre** and an optional **Tone**, pick a
  **Length** (Short: 6 chapters, about 7,000 words; Medium: 10, about 16,000; Long: 16, about 32,000) and whether it
  is **Told in** the third person or the first person. Optionally tick **your characters** (as in Game Story) and pick
  **The main character** — in the first person, they tell the story. Press **Write novel**.
- The AI prompt writer (Ollama, on this PC) first writes the **Plan** (premise, characters, setting) and a line or two
  for every chapter (one to three minutes), then the chapters one by one, each following the plan and going on from
  the end of the chapter before (three to six minutes a chapter). It is also given the passages of earlier chapters
  that share the most words with the chapter's plan, so names, places and objects stay consistent. It keeps writing when you open another tab;
  **⏹ Stop** stops after the current chapter and **Write missing chapters** goes on later. Don't generate images
  meanwhile: the writer and the image model share the GPU.
- Everything is a text box you can edit (saved as you type): the plan, each chapter's title, **what happens** in it
  (the writer follows your changes when it writes or rewrites that chapter) and the chapter text. **↻ Rewrite**
  writes a chapter again; **＋ Add chapter** adds one to the plan and 🗑 removes an empty one. **↻ Rewrite plan** makes
  a new plan and chapter list, only while no chapter is written yet.
- **Copy all** and **⬇ Download** give you the novel (the chapters, without the plan) as one Markdown (`.md`) text
  file. Novels are saved on the ComfyUI PC (`user/default/lora-lab-novels`); General lists only its own, safe-for-work
  novels.

### Manga

The **Manga** tab makes a black-and-white manga. The AI writes it, every panel is drawn with the **model, LoRAs and
settings chosen on the right**, and Kōbō letters it with speech bubbles. Illustrious / NoobAI or Anima work best.

1. Press **＋ New manga** and fill in:
   - **What it's about**, a **genre** and how many **pages** (1–40). In the **Adult 18+** workspace the list also has
     18+ genres (Hentai, Erotic romance…); any genre with "18+", "hentai" or "erotic" in it makes an explicit manga that
     starts with a set-up and teasing and gets more explicit page by page. In the General workspace 18+ genres are blocked.
   - **Read from:** right to left like Japanese manga (panel 1 is top right), or left to right.
   - **Your characters in it** (optional): they keep their look, usual outfit and LoRAs from the Characters tab. The
     AI invents everyone else and gives them look tags, so they look the same in every panel.
2. Press **Write and draw**. Kōbō does three steps on its own:
   - plans the story (about a minute);
   - writes each page as 3–6 panels (about half a minute a page);
   - writes a picture prompt for every panel (about 10 seconds each).

   Then it queues all the panels. Each panel is drawn at the size closest to its shape, in black and white with
   screentones, and appears on its page as it finishes.

Each page shows a preview on the left and its panels on the right. Everything can be edited:

- **Page:** the line saying what happens on it, the **panel layout**, **＋ Panel** (up to 6), **Rewrite page** (new
  panels from that line), **Draw page**, **⬇ PNG** and 🗑.
- **Panel:**
  - the **shot** (close-up, wide shot, from above…), **What happens**, and the **Picture prompt** (**New prompt**
    writes it again from What happens);
  - the **narration box** and the **dialogue**, one line each. Pick who says it and how: **Says** (speech bubble),
    **Thinks** (cloud), **Shouts** (spiky bubble, capitals) or **Whispers** (dashed);
  - **Draw / ↻ Draw again** for another version, **‹ ›** to switch between versions, and **This version**.
- **Bubbles:** they place themselves in reading order. **Drag** one on the page preview to move it, and
  **double-click** it to put it back.
- **Story plan and characters** (at the top) holds everyone's look tags. Change them to change how someone is drawn
  in every panel.

**▶ Continue** picks up whatever is missing (pages, prompts, pictures), and **⏹ Stop** stops the writer and the
panels still waiting. **⬇ PDF** saves the whole manga as one PDF; **⬇ CBZ** is the format comic reader apps open (it's a
zip of PNG pages). Manga are saved on the ComfyUI PC (`user/default/lora-lab-manga`) and their panels in
`output/LoRA-Lab/manga/<title>`. The General workspace lists only its own manga, which are written and drawn safe for
work.

### Chat

The **Chat** tab (left side, every workspace) lets you talk to a character. Text only; the AI prompt writer (Ollama, on
this PC) plays them.

- **＋ New character:** give them a **Name** and fill in **How they act and what they like**: their personality, how
  they talk, what they love and hate, their job and past, how they feel about you. Optional: a **First message** they
  say when a chat starts, what **They call you**, and **Picture and look from** one of your characters (Characters
  tab): the chat then uses that character's picture, look and Memory. Press **Start chatting**.
- Type and press **Enter** (Shift+Enter for a new line). The reply appears as it is written (10–40 s on the 9B
  model); **⏹ Stop** ends it early and keeps what was written. **↻ Retry** writes the last reply again, **Let them
  talk** makes them write the next message, and **✕** on a message deletes it and everything after it.
- **They learn from your chats.** **What they remember** is a list of notes the AI writes from your chats: your name,
  what you like, what happened, what you asked them to do or stop doing. It is updated when you leave a chat, start a
  new chat or open another tab, every 20 messages, or with **Learn now** (up to a minute or two). Every new chat
  starts from it, so they remember you. You can edit the notes yourself; **Forget** clears them (the chats stay).
- **＋ New chat** starts a fresh conversation with the same character; old chats stay in the **Chats** list (rename the open
  one in the box above the messages). The sheet is saved as you type and counts from the next message on.
- **Picture story** (above the messages) turns the chat into a short illustrated story. Pick an image model on
  the left (and LoRAs, if you like), type how many **Pictures** you want (1–30) and an optional **Art style**, then press
  **Make picture story**: the writer reads the chat and plans the scenes (a story caption, who is in the picture and
  a picture idea each, plus **How everyone looks** so they look the same in every picture), writes an image prompt
  per scene, and the pictures are drawn as one batch (progress in Image Generation). Link the character to one of
  yours (**Picture and look from**) and every picture uses their look tags, LoRAs and face. Edit any caption, idea,
  **People** tags or prompt; **↻ Draw again** makes another version (the small thumbnails switch between them),
  **New prompt** rewrites one prompt, **Plan again** re-reads the chat (after it went on, or for another number
  of scenes). **⬇ Download** saves the story as one web page with the pictures inside, to open in any browser. The
  pictures are saved in `output/LoRA-Lab/chats/<name>/` (Images tab). The text AI is taken off the GPU while the
  pictures are drawn, so they aren't slowed down. With a tag model (Illustrious, Pony, Anima, SD 1.5) and **TIPOv2**
  installed in Ollama (`tipov2`), each prompt is made in two steps: the writer picks the scene's key tags (place,
  action, light, framing), then TIPOv2, a small model trained on Danbooru, adds the rest around them; its hair and
  clothes guesses are dropped when look tags are used. Without TIPOv2 the writer alone writes the prompt.
- Very long chats: only the newest messages fit into the AI's context, so the older part of a chat is remembered
  through the notes. On top of that, each reply looks through the older messages and your other chats with them for
  the moments that share the most words with your last message, and the character gets those back to remember. Chats are saved on the ComfyUI PC (`user/default/lora-lab-chat`); General lists only its own,
  safe-for-work characters.

---

## 13. Settings

In the right panel's **Settings** tab:

- **Size** — presets, or Custom. 832 × 1216 (portrait) is a good default; larger sizes need more memory. Full HD (1080 × 1920) and 2K (1440 × 2560) are in the list, tall and wide. They take much longer, and most models are trained near 1 megapixel, so they can repeat faces or bodies; for a clean large image, generate at 832 × 1216 and use **⤢ Upscale 4×**.
- **Images per LoRA** — how many images each column gets.
- **Seed** — the same seed with the same settings gives the same image. **🎲** picks a new one;
  **New random seed every time** does that automatically.
- **Sampling** (always shown, with a slider and a number box each):
  - **Sampling steps** — more steps can add detail but take longer. Defaults: SDXL 28, SD 1.5 28, Anima 30, Klein 4, Z-Image 10.
    Many models have their own recommended steps, CFG, sampler and scheduler (see *Recommended settings per model*);
    what you change here is kept for the selected model only.
  - **CFG Scale** — how strictly the prompt is followed. Defaults: SDXL 6, SD 1.5 7, Anima 4, Klein 1.5, Z-Image 1.5.
  - **Sampler / Scheduler**.
- **Show model files** — reveals the VAE, text encoder and clip skip (SDXL) in the Model tab.

---

## 14. Using Kōbō from your phone or another PC

Kōbō is a web page served by ComfyUI. If ComfyUI is started with `--listen`,
another device on the **same network** can open
`http://<your PC's address>:8188/kobo`.

- Press **Devices** at the bottom left: it shows this PC's address and a **QR code**. Scan it with the phone's camera.
- On a phone, use **Add to Home Screen** for an app-like icon.
- It's built for slower devices: grids show small thumbnails (a few KB instead of 1–2 MB per picture; the viewer
  and Download still give the full image), and the page and tag list are sent compressed. On narrow screens the tab
  icons scroll sideways.
- Page won't load on the phone? In **Windows Security → Firewall & network protection → Allow an app through firewall**,
  tick **Private** for Python (ComfyUI), and check that your Wi-Fi is set to a **Private** network in Windows.
- **ComfyUI has no password.** Only do this on a network you trust, and never open ComfyUI to the internet.
  To use it away from home, use a private network tool such as Tailscale.
- Each browser keeps its own layout and workspace; the tag library, characters and images are shared.

---

## 15. Speed and memory tips

- First runs are slower while models load; later runs reuse them.
- Out of memory? Use a smaller size, fewer images per LoRA, GGUF or fp8 model files, or start ComfyUI with `--lowvram`.
- **Free VRAM** before switching to a very different model type, or before using the AI prompt writer.
- Close other GPU-heavy programs (games, video editors) while generating.

---

## 16. Troubleshooting

| Problem | Fix |
|---|---|
| The dot stays red / "Disconnected" | ComfyUI isn't running, or you opened the wrong port. |
| "… isn't loaded — restart ComfyUI once" | You updated Kōbō; press **↻ Restart** (or restart ComfyUI) so the new version loads. |
| "No … model found" | Put the model files in the right `models/` folder (see the README) and press **↻**. |
| A LoRA is missing | It may be for another model type, sorted into the other workspace, or blocked. Press **↻** after adding files. |
| Tagging says it's downloading | The image tagger downloads once (about 1.3 GB). Try again in a few minutes. |
| Prompt writer errors | Install Ollama, pull a chat model, and keep Ollama running. |
| Black or broken images | Try another seed or model file. For SDXL, try a different VAE under advanced settings (for example `sdxl_vae`). |
| Errors in red on an image | Hover to read the full message; the ComfyUI console has details. |

---

## 17. Good to know

- **Who owns the images?** Check each model's license — some forbid commercial use (for example Klein 9B, Anima and NovelAI Anime V2).
  In many countries, images made entirely by AI may not be protected by copyright.
- **Your data** stays on your computer: tag library, characters and LoRA settings in `ComfyUI/user/default/`, images in
  `ComfyUI/output/LoRA-Lab/`.
- **Safety rules** (always on): child-related terms are always in the negative prompt and are removed from tags,
  characters and prompts; LoRAs trained on child-related content are blocked; adult content stays in the Adult workspace.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl+Enter | Generate |
| Ctrl+V | Paste an image as Image 1 (or into the Characters, Train LoRA or Image to 3D tab you're on) |
| Enter (in the idea box) | Run the AI prompt writer |
| ← / → / Esc | Previous / next / close in the image viewer |
