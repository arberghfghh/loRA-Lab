# Kōbō

Kōbō is an app that runs on top of your own **ComfyUI**. You write one prompt, pick some LoRAs, and Kōbō makes one
image per LoRA with the same seed, so you can compare them side by side. It also helps you write prompts, keep
characters consistent, start from photos, and clean up images afterwards.

Everything runs on your own computer. Nothing is uploaded anywhere. No drawing models or LoRAs are included: it uses
the ones in your ComfyUI.

**New here? Start with the [Starter guide](STARTER_GUIDE.md).** The full guide is [web/USER_GUIDE.md](web/USER_GUIDE.md),
also under **Guide** inside the app.

## Install

Put this repo in its own folder in ComfyUI's `custom_nodes`, either with git:

```
cd ComfyUI/custom_nodes
git clone <this repo's URL> lora-lab
```

or with **Code → Download ZIP**: unzip it into `custom_nodes` (the files must sit directly in that folder).

Restart ComfyUI, then open `http://127.0.0.1:8188/kobo` (use your ComfyUI port if it isn't 8188; Comfy Desktop often
uses 8000).

Optional extras that some tabs use:

- [Ollama](https://ollama.com) for the AI writer (prompt help, stories, chat). The **Models** window pulls the writer
  model into it for you.
- [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF), [ComfyUI_IPAdapter_plus](https://github.com/cubiq/ComfyUI_IPAdapter_plus),
  [ComfyUI_UltimateSDUpscale](https://github.com/ssitu/ComfyUI_UltimateSDUpscale),
  [comfyui-prompt-control](https://github.com/asagi4/comfyui-prompt-control),
  [ComfyUI-Detail-Daemon](https://github.com/Jonseed/ComfyUI-Detail-Daemon)
- `pip install bm25s` in ComfyUI's Python

## License

GPL-3.0, see [LICENSE](LICENSE).

- The theme (`web/theme.css`) follows the design tokens of Mochi by bosen12 (GPL-3.0,
  https://github.com/bosen12/danbooru_tag_mochi).
- `ccip.py` is ported from [imgutils](https://github.com/deepghs/imgutils) (deepghs, MIT).
- IBM Plex Sans / Mono in `web/fonts`: SIL OFL-1.1.
- `web/danbooru_tags.csv`: tag names from Danbooru, in the a1111-sd-webui-tagcomplete format.
- The **Models** window downloads helper models (AI writer, upscaler, tagger, …) from their makers and shows each one's
  license next to it.
