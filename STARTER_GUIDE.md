# Kōbō starter guide

From nothing to your first LoRA comparison in about 15 minutes. The [full guide](web/USER_GUIDE.md) covers every tab.

## 1. What you need

- **ComfyUI**, a recent version (portable, desktop or a git install).
- An **NVIDIA GPU**. 6 GB of graphics memory is enough; SDXL takes about 20–60 s a picture there.
- **One drawing model**. Kōbō doesn't come with any.
- **LoRAs** if you want to compare them (optional).

## 2. Install Kōbō

1. Go to ComfyUI's `custom_nodes` folder.
2. Put this repo there as its own folder: `git clone <this repo's URL> lora-lab`, or **Code → Download ZIP** and unzip
   it there. The files (`__init__.py`, `web/`, …) must sit directly in that folder, not one folder deeper.
3. Restart ComfyUI. The console shows Kōbō loading with the rest of the custom nodes.

## 3. Add a model and some LoRAs

The easiest start is one **SDXL checkpoint** (Illustrious, Pony, NoobAI or a photo-real SDXL model). It is a single
`.safetensors` file:

| What | Folder in ComfyUI |
|---|---|
| SDXL and SD 1.5 checkpoints | `models/checkpoints` |
| LoRAs | `models/loras` |
| Anima, FLUX.2 Klein, Z-Image | split models: follow the ComfyUI instructions on the model's page (diffusion model, text encoder and VAE each go in their own folder) |

Kōbō sorts models by type on its own: it reads each file to tell SDXL from SD 1.5, and detects Pony checkpoints.
Check each model's license before you sell pictures made with it.

## 4. Open Kōbō

Open **http://127.0.0.1:8188/kobo** in your browser. Use your own ComfyUI port if it isn't 8188 (Comfy Desktop often
uses 8000). The dot at the top left turns **green** when Kōbō is connected to ComfyUI.

## 5. Your first picture

1. On the right, in the **Model** tab, click **Illustrious / Pony** and choose your checkpoint.
2. Leave the LoRAs unticked for now.
3. Type a prompt. Tag models like comma-separated tags:
   `1girl, solo, long silver hair, golden eyes, black kimono, wooden bridge, cherry blossoms, night`
4. Press **Generate** (or **Ctrl+Enter**). The live preview shows the progress; click the result to see it full size.

## 6. Compare LoRAs

1. Tick two or three LoRAs under **LoRA**.
2. Untick **Use the ticked LoRAs together**. Each LoRA now gets its own column, all with the same seed.
3. Press **Generate**, then switch to **Contact sheet** at the top: columns by LoRA, rows by seed.
4. Tick **Include a No LoRA image** to add a plain column to compare against.

Leave **Use the ticked LoRAs together** on to stack LoRAs in one picture instead, for example a character LoRA
plus a style LoRA.

## 7. Optional: the AI writer and helpers

Install [Ollama](https://ollama.com) to use **Write with AI** (prompts from an idea), Stories, Novel, Game Story and
Chat. Then open **Models** at the bottom left: it downloads the writer and the helper models (upscaler,
background remover, pose sketch, face reference, tagger, Image to 3D). Each one shows its size, the graphics memory
it needs and its license. Downloads run in the background, one at a time.

## 8. Good to know

- **Workspaces:** **General**, **Adult 18+** and **Story** keep separate settings, characters and pictures. General
  never lists or runs LoRAs marked adult.
- **Your pictures** are saved in ComfyUI's `output/LoRA-Lab` folder and listed in the **Images** tab (⭐ favourites,
  folders per character and story).
- **History** (top of Image Generation) lists every picture you've made, with its prompt, model and LoRAs.
- **Settings** in the right panel has the size, the number of pictures per LoRA, the seed, steps, CFG, sampler and
  scheduler. Each model keeps its own changes.

## Something's wrong?

| Problem | Fix |
|---|---|
| `/kobo` gives a 404 | Kōbō didn't load. Check that `__init__.py` sits directly in `custom_nodes/<folder>`, then look for an error about it in the ComfyUI console. |
| The dot stays red | ComfyUI isn't running, or you opened a different port than ComfyUI's. |
| *"No … model found"* | That model type has no files in ComfyUI's model folders yet (section 3). Restart ComfyUI after adding models. |
| A LoRA doesn't show up | It's for another model type (an SD 1.5 LoRA isn't listed under SDXL), or it's marked adult and you're in General. |
| A tab says it needs Ollama or a model | Install Ollama, or download that helper in **Models**. |
| Out of graphics memory | Use a smaller size or fewer pictures per LoRA, and close other GPU programs. |
