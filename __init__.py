# Kōbō: a standalone page for generating the same prompt across several LoRAs.
# Its only nodes are the Image to 3D helpers (mesh3d.py) and Fix face (facefix.py); ComfyUI serves ./web at /extensions/lora-lab/
# Open: http://127.0.0.1:8188/kobo (the old /asa-lab and /lora-lab addresses still work)
import asyncio
import logging
import os
import re
import time
from urllib.parse import quote

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"

# Image to 3D: mesh clean-up + painting the mesh from the source picture (used by the page's 3D graph).
try:
    from .mesh3d import NODE_CLASS_MAPPINGS as _MESH_NODES, NODE_DISPLAY_NAME_MAPPINGS as _MESH_NAMES
    NODE_CLASS_MAPPINGS.update(_MESH_NODES)
    NODE_DISPLAY_NAME_MAPPINGS.update(_MESH_NAMES)
except Exception as e:
    logging.warning(f"[Kobo] 3D mesh nodes unavailable: {e}")

from .facefix import NODE_CLASS_MAPPINGS as _FACE_NODES, NODE_DISPLAY_NAME_MAPPINGS as _FACE_NAMES
NODE_CLASS_MAPPINGS.update(_FACE_NODES)
NODE_DISPLAY_NAME_MAPPINGS.update(_FACE_NAMES)

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

try:
    import aiohttp
    from aiohttp import web
    from server import PromptServer

    import importlib

    class _Missing:
        """Stand-in for a Kōbō module that failed to import: its routes still register and answer with the reason."""
        def __init__(self, name, err):
            self._why = f"Kōbō's {name} module failed to load ({type(err).__name__}: {err}); see the ComfyUI log"

        def __getattr__(self, attr):
            raise RuntimeError(self._why)

    def _load(name):
        try:
            return importlib.import_module("." + name, __package__)
        except Exception as e:
            logging.exception("[Kobo] module %s failed to load; only its features are affected", name)
            return _Missing(name, e)

    tagger = _load("tagger"); trainfix = _load("trainfix"); workflow = _load("workflow")

    try:
        trainfix.install()
    except Exception:
        logging.exception("[Kobo] training speed-up patch not installed")

    # Stable address: /kobo (and the old /asa-lab, /lora-lab) works whatever folder name the node was installed under.
    _page = "/extensions/" + os.path.basename(os.path.dirname(os.path.abspath(__file__))) + "/index.html"

    @PromptServer.instance.routes.get("/kobo")
    @PromptServer.instance.routes.get("/asa-lab")
    @PromptServer.instance.routes.get("/lora-lab")
    async def lora_lab_page(request):
        raise web.HTTPFound(_page)

    # Other devices (phones, tablets, other PCs on the Wi-Fi): small thumbnails, gzip, and the address to open.
    devices = _load("devices")

    _web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
    _web_prefix = _page.rsplit("/", 1)[0] + "/"
    _gz_types = {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".csv": "text/csv",
                 ".json": "application/json", ".md": "text/markdown"}

    @web.middleware
    async def lora_lab_compress(request, handler):
        path = request.path
        gz_ok = "gzip" in request.headers.get("Accept-Encoding", "")
        ext = os.path.splitext(path)[1].lower()
        if gz_ok and request.method == "GET" and path.startswith(_web_prefix) and ext in _gz_types:
            file = os.path.abspath(os.path.join(_web_dir, path[len(_web_prefix):]))
            if os.path.dirname(file) == _web_dir and os.path.isfile(file):
                data, etag = await asyncio.get_running_loop().run_in_executor(None, devices.gzipped, file)
                headers = {"ETag": f'"{etag}"', "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
                if request.headers.get("If-None-Match") == headers["ETag"]:
                    return web.Response(status=304, headers=headers)
                return web.Response(body=data, headers={**headers, "Content-Encoding": "gzip",
                                                        "Content-Type": _gz_types[ext] + "; charset=utf-8"})
        resp = await handler(request)
        if (gz_ok and path.startswith("/lora-lab/") and type(resp) is web.Response and resp.content_type == "application/json"
                and resp.body is not None and len(resp.body) > 2048):
            resp.enable_compression()
        return resp

    PromptServer.instance.app.middlewares.append(lora_lab_compress)

    @PromptServer.instance.routes.get("/lora-lab/thumb")
    async def lora_lab_thumb(request):
        q = request.query
        path = devices.image_path(q.get("filename", ""), q.get("subfolder", ""), q.get("type", "output"))
        if not path:
            return web.Response(status=404)
        try:
            width = max(64, min(1024, int(q.get("w", 512))))
            data, etag = await asyncio.get_running_loop().run_in_executor(None, devices.thumbnail, path, width)
        except Exception:
            logging.exception("[Kobo] thumbnail failed for %s", path)
            raise web.HTTPFound(f"/view?{request.query_string}")   # unreadable as a picture: fall back to the original
        headers = {"ETag": f'"{etag}"', "Cache-Control": "public, max-age=3600"}
        if request.headers.get("If-None-Match") == headers["ETag"]:
            return web.Response(status=304, headers=headers)
        return web.Response(body=data, content_type="image/webp", headers=headers)

    @PromptServer.instance.routes.get("/lora-lab/devices")
    async def lora_lab_devices(request):
        from comfy.cli_args import args
        # On a cloud GPU (Kōbō Cloud) the PC's tunnel is what other devices open; the kit writes its addresses here.
        share = os.environ.get("ASA_SHARE_FILE")
        if share and os.path.isfile(share):
            try:
                import json
                with open(share, encoding="utf-8") as f:
                    info = json.load(f)
                return web.json_response({"lan": bool(info.get("urls")), "port": info.get("port"), "urls": info.get("urls", []),
                                          "note": info.get("note", "")})
            except (OSError, ValueError):
                pass
        # ComfyUI only answers other devices when started with --listen (0.0.0.0 or this PC's address).
        lan = any(h.strip() not in ("", "127.0.0.1", "localhost", "::1") for h in str(args.listen or "").split(","))
        port = args.port
        return web.json_response({"lan": lan, "port": port, "urls": [f"http://{ip}:{port}/kobo" for ip in devices.lan_addresses()]})

    @PromptServer.instance.routes.get("/lora-lab/devices/qr")
    async def lora_lab_devices_qr(request):
        text = request.query.get("text", "")
        if not re.fullmatch(r"http://[\w.\-\[\]:]+/(kobo|asa-lab)", text):   # only Kōbō's own address
            return web.Response(status=400)
        try:
            import io
            import segno
        except ImportError:
            return web.Response(status=404)
        buf = io.BytesIO()
        segno.make(text, error="m").save(buf, kind="svg", scale=6, border=2, dark="#000", light="#fff")
        return web.Response(body=buf.getvalue(), content_type="image/svg+xml")

    # Share Files: upload to / download from the ASA-Share folder on this PC from any device on the network.
    @PromptServer.instance.routes.get("/lora-lab/share")
    async def lora_lab_share(request):
        files = await asyncio.get_running_loop().run_in_executor(None, devices.share_list)
        return web.json_response({"folder": devices.SHARE, "files": files})

    @PromptServer.instance.routes.get("/lora-lab/share/file")
    async def lora_lab_share_file(request):
        path = devices.share_path(request.query.get("name"))
        if not path:
            return web.Response(status=404)
        return web.FileResponse(path, headers={"Content-Disposition": "attachment; filename*=UTF-8''" + quote(os.path.basename(path))})

    @PromptServer.instance.routes.post("/lora-lab/share/upload")
    async def lora_lab_share_upload(request):
        # Streamed to disk, so files bigger than ComfyUI's upload limit (--max-upload-size) work too.
        reader = await request.multipart()
        saved = []
        while (part := await reader.next()) is not None:
            if not part.filename:
                continue
            path, f = devices.share_create(part.filename)
            try:
                with f:
                    while chunk := await part.read_chunk(1 << 20):
                        f.write(chunk)
            except BaseException:   # cancelled or broken connection: don't leave half a file
                os.remove(path)
                raise
            saved.append(os.path.basename(path))
        return web.json_response({"saved": saved})

    @PromptServer.instance.routes.post("/lora-lab/share/delete")
    async def lora_lab_share_delete(request):
        if request.content_type != "application/json":   # no plain form posts from other sites
            return web.json_response({"error": "Bad request"}, status=400)
        path = devices.share_path((await request.json()).get("name"))
        if not path:
            return web.json_response({"error": "File not found"}, status=404)
        os.remove(path)
        return web.json_response({"ok": True})

    # ↻ Restart: the Kōbō app (ASALab.exe) starts ComfyUI again when it exits with this code.
    RESTART_EXIT_CODE = 75

    @PromptServer.instance.routes.post("/lora-lab/restart")
    async def lora_lab_restart(request):
        if request.content_type != "application/json":   # no plain form posts from other sites
            return web.json_response({"error": "Bad request"}, status=400)
        if os.environ.get("LORALAB_LAUNCHER") != "1":
            return web.json_response({"error": "not_launcher"}, status=409)
        asyncio.get_running_loop().call_later(0.5, os._exit, RESTART_EXIT_CODE)
        return web.json_response({"ok": True})

    # The standalone app (its own launcher + installer) sets ASA_LAB_EDITION; the page then asks for 18+ once
    # and opens 📦 Models when there's nothing to draw with yet.
    @PromptServer.instance.routes.get("/lora-lab/edition")
    async def lora_lab_edition(request):
        return web.json_response({"standalone": os.environ.get("ASA_LAB_EDITION") == "standalone",
                                  "version": os.environ.get("ASA_LAB_VERSION", "")})

    # 📦 Models: download the models in modelcatalog.json (one at a time, in the background).
    modelstore = _load("modelstore")

    @PromptServer.instance.routes.get("/lora-lab/models")
    async def lora_lab_models(request):
        return web.json_response(await asyncio.get_running_loop().run_in_executor(None, modelstore.status))

    @PromptServer.instance.routes.post("/lora-lab/models/get")
    async def lora_lab_models_get(request):
        if request.content_type != "application/json":
            return web.json_response({"error": "Bad request"}, status=400)
        body = await request.json()
        try:
            modelstore.start([str(i) for i in body.get("ids") or []])
        except RuntimeError as e:
            return web.json_response({"error": str(e)}, status=409)
        return web.json_response({"ok": True})

    @PromptServer.instance.routes.post("/lora-lab/models/cancel")
    async def lora_lab_models_cancel(request):
        if request.content_type != "application/json":
            return web.json_response({"error": "Bad request"}, status=400)
        modelstore.cancel()
        return web.json_response({"ok": True})

    @PromptServer.instance.routes.post("/lora-lab/tag")
    async def lora_lab_tag(request):
        form = await request.post()
        upload = form.get("image")
        if upload is None or not hasattr(upload, "file"):
            return web.json_response({"error": "No image uploaded"}, status=400)
        data = upload.file.read()
        # Which models to combine (wd, pixai, haruka, e621, camie, joycaption); empty = the default (PixAI + Haruka).
        models = [m for m in str(form.get("models") or "").split(",") if m] or None
        pending = tagger.ensure_ready(models)   # only waits for the WD download when WD will actually run
        if pending:
            return web.json_response({"error": pending}, status=503)
        if models and "joycaption" in models:
            _free_comfy_vram()   # JoyCaption runs in Ollama on the same GPU
        loop = asyncio.get_running_loop()
        # text=1: also read any writing in the picture (CPU OCR, runs alongside the taggers)
        reading = loop.run_in_executor(None, tagger.read_text, data) if form.get("text") == "1" else None
        try:
            result = await loop.run_in_executor(None, lambda: tagger.tag_image(data, models))
            if form.get("rule34") == "1":   # Adult workspace: rule34.xxx's tag names, like its prompt writer
                result = await loop.run_in_executor(None, tagger.to_rule34, result)
            result["groups"] = await loop.run_in_executor(None, tagger.tag_groups, [t for t, _ in result["general"]])
        except Exception as e:
            if reading:
                reading.add_done_callback(lambda f: f.exception())   # collect it, so asyncio doesn't warn
            if isinstance(e, FileNotFoundError):
                return web.json_response({"error": str(e)}, status=503)
            logging.exception("[Kobo] tagging failed")
            return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=500)
        if reading:
            try:
                result["text"] = await reading
            except Exception as e:   # tags are still useful without the text
                logging.warning("[Kobo] reading text failed: %s", e)
        return web.json_response(result)

    # 🔍 Image info: an uploaded file, or one of ComfyUI's own images by name (results, the Images tab).
    imageinfo = _load("imageinfo")

    @PromptServer.instance.routes.post("/lora-lab/imageinfo")
    async def lora_lab_imageinfo(request):
        form = await request.post()
        upload = form.get("image")
        if upload is not None and hasattr(upload, "file"):
            data = upload.file.read()
        else:
            path = devices.image_path(form.get("filename", ""), form.get("subfolder", ""), form.get("type", "output"))
            if not path:
                return web.json_response({"error": "Image not found"}, status=404)
            with open(path, "rb") as f:
                data = f.read()
        try:
            result = await asyncio.get_running_loop().run_in_executor(None, imageinfo.analyze, data)
        except OSError as e:
            return web.json_response({"error": f"Not a picture this can read ({e})"}, status=400)
        return web.json_response(result)

    @PromptServer.instance.routes.get("/lora-lab/tagger/status")
    async def lora_lab_tagger_status(request):
        return web.json_response(await asyncio.get_running_loop().run_in_executor(None, tagger.available_models))

    # Character likeness (CCIP): how close each picture's character is to a reference picture's.
    try:
        from . import ccip
    except ImportError as e:   # onnxruntime missing
        ccip = None
        logging.warning("[Kobo] character likeness is off: %s", e)

    @PromptServer.instance.routes.get("/lora-lab/likeness/status")
    async def lora_lab_likeness_status(request):
        return web.json_response({"ready": bool(ccip and ccip.ready())})

    @PromptServer.instance.routes.post("/lora-lab/likeness")
    async def lora_lab_likeness(request):
        if not (ccip and ccip.ready()):
            return web.json_response({"error": "The character likeness model isn't installed: get it in 📦 Models (Helpers)."}, status=503)
        body = await request.json()
        where = lambda im: devices.image_path(str((im or {}).get("filename", "")), str((im or {}).get("subfolder", "")),
                                              str((im or {}).get("type", "output")))
        ref, images = where(body.get("ref")), list(body.get("images") or [])[:500]
        if not ref:
            return web.json_response({"error": "Reference picture not found"}, status=404)
        paths = [where(im) for im in images]
        found = [p for p in paths if p]
        try:
            diffs = await asyncio.get_running_loop().run_in_executor(None, ccip.differences, ref, found) if found else []
        except Exception as e:
            logging.exception("[Kobo] likeness failed")
            return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=500)
        it = iter(diffs)
        return web.json_response({"threshold": ccip.threshold(), "differences": [next(it) if p else None for p in paths]})

    llm = _load("llm")

    def _free_comfy_vram():
        queue = PromptServer.instance.prompt_queue
        if queue.get_tasks_remaining() == 0:
            queue.set_flag("unload_models", True)
            queue.set_flag("free_memory", True)

    # The other direction: a text model left on the 6 GB GPU (chat, ✨ Write, JARVIS...) makes every picture much slower,
    # so each queued job first takes Ollama models off the GPU. ASA_KEEP_OLLAMA=1 turns this off.
    def _unload_ollama_before_drawing(json_data):
        if os.environ.get("ASA_KEEP_OLLAMA") != "1":
            llm.unload_gpu_models_soon()
        return json_data

    PromptServer.instance.add_on_prompt_handler(_unload_ollama_before_drawing)

    @PromptServer.instance.routes.get("/lora-lab/llm/models")
    async def lora_lab_llm_models(request):
        try:
            return web.json_response(await llm.list_models())
        except aiohttp.ClientError:
            return web.json_response({"models": [], "default": None, "error": "Ollama isn't running"})

    @PromptServer.instance.routes.post("/lora-lab/llm")
    async def lora_lab_llm(request):
        body = await request.json()
        idea = (body.get("idea") or "").strip()
        if not idea:
            return web.json_response({"error": "Type an idea first"}, status=400)
        try:
            text = await llm.write_prompt(idea, body.get("target", ""), body.get("model") or llm.DEFAULT_MODEL, _free_comfy_vram,
                                          sfw=bool(body.get("sfw")), character=body.get("character"), new_look=bool(body.get("new_look")),
                                          nude=bool(body.get("nude")), notes=body.get("notes") or "", rule34=bool(body.get("rule34")))
        except Exception as e:
            logging.exception("[Kobo] prompt writer failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"text": text})

    # Workflow review step: the written prompt checked against the idea -> {prompt, notes}.
    @PromptServer.instance.routes.post("/lora-lab/llm/review")
    async def lora_lab_llm_review(request):
        body = await request.json()
        try:
            r = await llm.review_prompt(body.get("idea", ""), body.get("prompt", ""), body.get("target", ""),
                                        body.get("model") or llm.DEFAULT_MODEL, _free_comfy_vram, sfw=bool(body.get("sfw")),
                                        character=body.get("character"), notes=body.get("notes") or "")
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            logging.exception("[Kobo] prompt review failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response(r)

    # Workflow tab: the one folder the user gave it (workflow.py). Only this PC can choose the folder, so a phone or
    # tablet on the Wi-Fi can't point Kōbō at other folders; reading and saving stay inside the chosen folder.
    @PromptServer.instance.routes.get("/lora-lab/workflow/folder")
    async def lora_lab_workflow_folder(request):
        try:
            return web.json_response(await asyncio.to_thread(workflow.contents, workflow.get_folder()))
        except OSError as e:
            return web.json_response({"error": f"Can't read the folder: {e}"}, status=500)

    @PromptServer.instance.routes.post("/lora-lab/workflow/folder")
    async def lora_lab_workflow_set_folder(request):
        if request.remote not in ("127.0.0.1", "::1"):
            return web.json_response({"error": "Choose the folder on the PC that runs Kōbō"}, status=403)
        body = await request.json()
        try:
            folder = await asyncio.to_thread(workflow.set_folder, body.get("folder"))
            return web.json_response(await asyncio.to_thread(workflow.contents, folder))
        except (ValueError, OSError) as e:
            return web.json_response({"error": str(e)}, status=400)

    @PromptServer.instance.routes.get("/lora-lab/workflow/image")
    async def lora_lab_workflow_image(request):
        path = await asyncio.to_thread(workflow.image_path, workflow.get_folder(), request.query.get("name", ""))
        return web.FileResponse(path) if path else web.json_response({"error": "Unknown image"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/workflow/save")
    async def lora_lab_workflow_save(request):
        body = await request.json()
        try:
            name = await asyncio.to_thread(workflow.save_approved, workflow.get_folder(), body.get("image") or {},
                                           folder_paths.get_output_directory(), body.get("set") or "")
        except (ValueError, OSError) as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({"saved": name})

    # Assistant: a chat line -> a plan the page carries out (write the prompt, set count/shape/character, generate).
    @PromptServer.instance.routes.post("/lora-lab/assistant")
    async def lora_lab_assistant(request):
        body = await request.json()
        try:
            plan = await llm.assistant_plan(body.get("message", ""), body.get("history") or [], body.get("characters") or [],
                                            body.get("model") or llm.DEFAULT_MODEL, sfw=bool(body.get("sfw")))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            logging.exception("[Kobo] assistant failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response(plan)

    # A story scene -> tags for tag models (llm.write_scene_tags); drop_looks when the page adds everyone's look tags itself.
    @PromptServer.instance.routes.post("/lora-lab/llm/scene")
    async def lora_lab_llm_scene(request):
        body = await request.json()
        idea = (body.get("idea") or "").strip()
        if not idea:
            return web.json_response({"error": "The scene has no description"}, status=400)
        try:
            text = await llm.write_scene_tags(idea, body.get("people", ""), body.get("target", ""), body.get("model") or llm.DEFAULT_MODEL,
                                              _free_comfy_vram, sfw=bool(body.get("sfw")), drop_looks=bool(body.get("drop_looks")))
        except Exception as e:
            logging.exception("[Kobo] scene tag writer failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"text": text})

    # Klein / Z-Image prompt for a reference picture: JoyCaption looks at it; without JoyCaption the writer rewrites the tags.
    @PromptServer.instance.routes.post("/lora-lab/describe")
    async def lora_lab_describe(request):
        form = await request.post()
        upload, tags, sfw = form.get("image"), str(form.get("tags") or ""), form.get("sfw") == "1"
        try:
            n = int(form.get("sentences") or 5)
            if upload is not None and hasattr(upload, "file") and tagger.joycaption_ready():
                data = upload.file.read()
                _free_comfy_vram()
                await asyncio.sleep(3)
                text = await asyncio.get_running_loop().run_in_executor(None, lambda: tagger.describe_image(data, tags, sfw, n, str(form.get("focus") or "")))
                return web.json_response({"text": text, "by": "joycaption"})
            text = await llm.tags_to_sentences(tags, n, str(form.get("model") or llm.DEFAULT_MODEL), _free_comfy_vram, sfw=sfw)
            return web.json_response({"text": text, "by": "writer"})
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            logging.exception("[Kobo] describe failed")
            return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=500)

    @PromptServer.instance.routes.post("/lora-lab/llm/sentences")
    async def lora_lab_llm_sentences(request):
        body = await request.json()
        try:
            text = await llm.tags_to_sentences(body.get("tags", ""), body.get("sentences", 4), body.get("model") or llm.DEFAULT_MODEL,
                                               _free_comfy_vram, sfw=bool(body.get("sfw")))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            logging.exception("[Kobo] tags to sentences failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"text": text})

    @PromptServer.instance.routes.post("/lora-lab/llm/sequence")
    async def lora_lab_llm_sequence(request):
        body = await request.json()
        story = (body.get("story") or "").strip()
        if not story:
            return web.json_response({"error": "Describe what happens first"}, status=400)
        try:
            beats = await llm.write_sequence(story, body.get("frames", 4), body.get("target", ""), body.get("model") or llm.DEFAULT_MODEL,
                                             _free_comfy_vram, sfw=bool(body.get("sfw")), character=body.get("character"))
        except Exception as e:
            logging.exception("[Kobo] sequence planner failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"beats": beats})

    # Workflow set: the shot list for a themed set (llm.plan_set); the page draws it with the sequence machinery.
    @PromptServer.instance.routes.post("/lora-lab/llm/set")
    async def lora_lab_llm_set(request):
        body = await request.json()
        if not (body.get("prompt") or "").strip():
            return web.json_response({"error": "Write the prompt first"}, status=400)
        try:
            r = await llm.plan_set(body.get("idea", ""), body["prompt"], body.get("shots", 12), body.get("target", ""),
                                   body.get("model") or llm.DEFAULT_MODEL, _free_comfy_vram, sfw=bool(body.get("sfw")),
                                   character=body.get("character"), notes=body.get("notes") or "", outfit=body.get("outfit") or "")
        except (ValueError, TypeError) as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            logging.exception("[Kobo] set planner failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response(r)

    # Workflow chat: an instruction ("remove X, add Y") -> the edited prompt and shot list (llm.edit_workflow).
    @PromptServer.instance.routes.post("/lora-lab/llm/edit")
    async def lora_lab_llm_edit(request):
        body = await request.json()
        try:
            r = await llm.edit_workflow(body.get("instruction", ""), body.get("prompt", ""), body.get("shots") or [], body.get("target", ""),
                                        body.get("model") or llm.DEFAULT_MODEL, _free_comfy_vram, sfw=bool(body.get("sfw")),
                                        character=body.get("character"), notes=body.get("notes") or "")
        except (ValueError, TypeError) as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            logging.exception("[Kobo] workflow chat failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response(r)

    taglib = _load("taglib")

    @PromptServer.instance.routes.get("/lora-lab/tags")
    async def lora_lab_tags_get(request):
        return web.json_response(taglib.load())

    @PromptServer.instance.routes.post("/lora-lab/tags")
    async def lora_lab_tags_save(request):
        try:
            data = await request.json()
            return web.json_response(taglib.save(data))
        except Exception as e:
            logging.exception("[Kobo] saving tag library failed")
            return web.json_response({"error": str(e)}, status=500)

    boorutags = _load("boorutags")

    @PromptServer.instance.routes.get("/lora-lab/booru-tags")
    async def lora_lab_booru_tags(request):
        q = request.query.get("q", "")[:80]
        return web.json_response(await asyncio.get_running_loop().run_in_executor(None, boorutags.search, q))

    @PromptServer.instance.routes.post("/lora-lab/tags/sort")
    async def lora_lab_tags_sort(request):
        body = await request.json()
        # The General workspace never sorts into adult categories, whatever the page asks for.
        cats = [c for c in taglib.load()["categories"] if not (body.get("sfw") and c["adult"])]
        try:
            out = await llm.sort_tags([str(t) for t in body.get("tags") or []][:60], cats, body.get("model") or llm.DEFAULT_MODEL,
                                      _free_comfy_vram if body.get("free") else None)
        except Exception as e:
            logging.exception("[Kobo] tag sorting failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"sorted": out})

    charlib = _load("charlib")

    @PromptServer.instance.routes.get("/lora-lab/characters")
    async def lora_lab_chars_get(request):
        return web.json_response(charlib.load())

    @PromptServer.instance.routes.post("/lora-lab/characters")
    async def lora_lab_chars_save(request):
        try:
            return web.json_response(charlib.upsert(await request.json()))
        except Exception as e:
            logging.exception("[Kobo] saving character failed")
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/lora-lab/characters/delete")
    async def lora_lab_chars_delete(request):
        body = await request.json()
        return web.json_response({"deleted": charlib.delete(str(body.get("id", "")))})

    @PromptServer.instance.routes.post("/lora-lab/characters/image")
    async def lora_lab_chars_image(request):
        body = await request.json()
        entry = charlib.add_image(str(body.get("id", "")), body)
        if entry is None:
            return web.json_response({"error": "Unknown character or image"}, status=404)
        return web.json_response(entry)

    @PromptServer.instance.routes.post("/lora-lab/characters/remember")
    async def lora_lab_chars_remember(request):
        try:
            body = await request.json()
            out = charlib.remember(str(body.get("id", "")), body.get("mode"), body.get("settings"), body.get("prompt"))
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)
        if out is None:
            return web.json_response({"error": "Unknown character"}, status=404)
        return web.json_response(out)

    gallery = _load("gallery"); storylib = _load("storylib")

    @PromptServer.instance.routes.get("/lora-lab/images")
    async def lora_lab_images(request):
        return web.json_response(await asyncio.to_thread(gallery.list_images))

    @PromptServer.instance.routes.post("/lora-lab/images/mark")
    async def lora_lab_images_mark(request):
        body = await request.json()
        m = gallery.mark(body.get("image"), body.get("mode"), body.get("fav"))
        return web.json_response(m) if m is not None else web.json_response({"error": "Unknown image"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/images/delete")
    async def lora_lab_images_delete(request):
        body = await request.json()
        images = body.get("images")
        return web.json_response({"deleted": await asyncio.to_thread(gallery.delete, images if isinstance(images, list) else [])})

    @PromptServer.instance.routes.get("/lora-lab/images/sets")
    async def lora_lab_image_sets(request):
        return web.json_response(gallery.list_sets())

    @PromptServer.instance.routes.post("/lora-lab/images/sets/save")
    async def lora_lab_image_sets_save(request):
        body = await request.json()
        st = gallery.save_set(body.get("id"), body.get("name"), body.get("mode"))
        return web.json_response(st) if st is not None else web.json_response({"error": "Unknown set"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/images/sets/delete")
    async def lora_lab_image_sets_delete(request):
        body = await request.json()
        gallery.delete_set(body.get("id"))
        return web.json_response({"ok": True})

    @PromptServer.instance.routes.post("/lora-lab/images/sets/export")
    async def lora_lab_image_sets_export(request):
        body = await request.json()
        r = await asyncio.to_thread(gallery.export_set, body.get("id"))
        if r is None:
            return web.json_response({"error": "Unknown set"}, status=404)
        if r["count"] and request.remote in ("127.0.0.1", "::1"):
            os.startfile(r["folder"])   # on this PC: show the folder, ready to upload
        return web.json_response(r)

    @PromptServer.instance.routes.post("/lora-lab/images/sets/prompts")
    async def lora_lab_image_sets_prompts(request):
        body = await request.json()
        r = await asyncio.to_thread(gallery.export_prompts, body.get("id"))
        if r is None:
            return web.json_response({"error": "Unknown set"}, status=404)
        if r["count"] and request.remote in ("127.0.0.1", "::1"):
            os.startfile(r["file"])   # on this PC: open the text, ready to copy into the post
        return web.json_response(r)

    @PromptServer.instance.routes.post("/lora-lab/images/sets/images")
    async def lora_lab_image_sets_images(request):
        body = await request.json()
        images = body.get("images")
        st = gallery.set_images(body.get("id"), images if isinstance(images, list) else [], body.get("add", True) is not False)
        return web.json_response(st) if st is not None else web.json_response({"error": "Unknown set"}, status=404)

    @PromptServer.instance.routes.get("/lora-lab/stories")
    async def lora_lab_stories(request):
        q = request.rel_url.query
        return web.json_response(storylib.list_stories(q.get("char", ""), q.get("workspace", "")))

    @PromptServer.instance.routes.get("/lora-lab/story")
    async def lora_lab_story_get(request):
        story = storylib.get(request.rel_url.query.get("id", ""))
        return web.json_response(story) if story else web.json_response({"error": "Unknown story"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/story")
    async def lora_lab_story_save(request):
        try:
            return web.json_response(storylib.upsert(await request.json()))
        except Exception as e:
            logging.exception("[Kobo] saving story failed")
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/lora-lab/story/delete")
    async def lora_lab_story_delete(request):
        body = await request.json()
        return web.json_response({"deleted": storylib.delete(str(body.get("id", "")))})

    @PromptServer.instance.routes.post("/lora-lab/story/image")
    async def lora_lab_story_image(request):
        body = await request.json()
        scene = storylib.add_image(str(body.get("id", "")), str(body.get("scene", "")), body.get("image"), body.get("seed"))
        return web.json_response(scene) if scene else web.json_response({"error": "Unknown story or scene"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/story/pick")
    async def lora_lab_story_pick(request):
        body = await request.json()
        try:
            scene = storylib.set_pick(str(body.get("id", "")), str(body.get("scene", "")), body.get("pick", 0))
        except (TypeError, ValueError):
            scene = None
        return web.json_response(scene) if scene else web.json_response({"error": "Unknown story, scene or image"}, status=404)

    # The General workspace only ever plans safe stories, whatever the page asks for.
    def _story_level(body):
        return body.get("level", "safe") if body.get("workspace") in ("adult", "story") else "safe"

    @PromptServer.instance.routes.post("/lora-lab/story/outline")
    async def lora_lab_story_outline(request):
        body = await request.json()
        try:
            out = await llm.write_story_outline(str(body.get("premise") or ""), body.get("chapters", 10), _story_level(body),
                                                body.get("target", ""), body.get("model") or llm.DEFAULT_MODEL, _free_comfy_vram,
                                                character=body.get("character"))
        except Exception as e:
            logging.exception("[Kobo] story outline failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response(out)

    # 🎞 From video: frames the page took from a video -> a premise (llm.video_premise); a ValueError is a refusal.
    @PromptServer.instance.routes.post("/lora-lab/story/video")
    async def lora_lab_story_video(request):
        body = await request.json()
        try:
            out = await llm.video_premise(body.get("frames") or [], _story_level(body), body.get("model") or llm.DEFAULT_MODEL,
                                          _free_comfy_vram, character=body.get("character"))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            logging.exception("[Kobo] story from video failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response(out)

    # 🎞 Video describer (Create tab): frames from the page -> {summary, moments} (llm.video_describe); a ValueError is a refusal.
    @PromptServer.instance.routes.post("/lora-lab/video/describe")
    async def lora_lab_video_describe(request):
        body = await request.json()
        try:
            out = await llm.video_describe(body.get("frames") or [], body.get("model") or llm.DEFAULT_MODEL, _free_comfy_vram,
                                           sfw=bool(body.get("sfw")))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            logging.exception("[Kobo] video describe failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response(out)

    @PromptServer.instance.routes.post("/lora-lab/story/chapter")
    async def lora_lab_story_chapter(request):
        body = await request.json()
        try:
            scenes = await llm.write_story_chapter(body.get("story") or {}, int(body.get("index", 0)), body.get("scenes", 10),
                                                   _story_level(body), body.get("target", ""), body.get("model") or llm.DEFAULT_MODEL,
                                                   _free_comfy_vram, character=body.get("character"), prev=body.get("prev") or "",
                                                   first=int(body.get("first", 0)))
        except Exception as e:
            logging.exception("[Kobo] story chapter failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"scenes": scenes})

    gamelib = _load("gamelib")

    @PromptServer.instance.routes.get("/lora-lab/games")
    async def lora_lab_games(request):
        return web.json_response(gamelib.list_games(request.rel_url.query.get("workspace", "")))

    @PromptServer.instance.routes.get("/lora-lab/game")
    async def lora_lab_game_get(request):
        game = gamelib.get(request.rel_url.query.get("id", ""))
        return web.json_response(game) if game else web.json_response({"error": "Unknown game"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/game")
    async def lora_lab_game_save(request):
        try:
            return web.json_response(gamelib.upsert(await request.json()))
        except Exception as e:
            logging.exception("[Kobo] saving game failed")
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/lora-lab/game/delete")
    async def lora_lab_game_delete(request):
        body = await request.json()
        return web.json_response({"deleted": gamelib.delete(str(body.get("id", "")))})

    # Only a game made in the Adult or Story workspace is written without the safe-for-work rule.
    @PromptServer.instance.routes.post("/lora-lab/game/write")
    async def lora_lab_game_write(request):
        body = await request.json()
        game = body.get("game") or {}
        try:
            out = await llm.write_game_part(game, body.get("part", ""), body.get("model") or llm.DEFAULT_MODEL, _free_comfy_vram,
                                            sfw=game.get("workspace") != "adult")
        except Exception as e:
            logging.exception("[Kobo] game story writer failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response(out)

    # Game art: the story read back into its pictures (title, cast, places, scenes); the page writes the prompts and
    # draws them like a story, and each finished image is added here.
    @PromptServer.instance.routes.post("/lora-lab/game/art/plan")
    async def lora_lab_game_art_plan(request):
        body = await request.json()
        game = gamelib.plan_art(str(body.get("id", "")))
        return web.json_response(game) if game else web.json_response({"error": "Unknown game"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/game/art/image")
    async def lora_lab_game_art_image(request):
        body = await request.json()
        item = gamelib.add_art_image(str(body.get("id", "")), str(body.get("key", "")), body.get("image"), body.get("seed", 0))
        return web.json_response(item) if item else web.json_response({"error": "Unknown game or picture"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/game/art/drop")
    async def lora_lab_game_art_drop(request):
        body = await request.json()
        try:
            index = int(body.get("index", -1))
        except (TypeError, ValueError):
            index = -1
        item = gamelib.drop_art_image(str(body.get("id", "")), str(body.get("key", "")), index)
        return web.json_response(item) if item else web.json_response({"error": "Unknown game or picture"}, status=404)

    # RPG Maker MV / MZ: find the editor and its projects, link one to a game and build the game into it.
    import json

    import folder_paths

    rpgmaker = _load("rpgmaker")
    rpg_settings_path = os.path.join(folder_paths.get_user_directory(), "default", "lora-lab-rpg.json")

    def rpg_settings():
        try:
            with open(rpg_settings_path, encoding="utf-8") as f:
                st = json.load(f)
        except (OSError, ValueError):
            st = {}
        return {"folders": [str(x) for x in st.get("folders") or [] if x][:20], "exe": str(st.get("exe") or "")}

    def rpg_status():
        st = rpg_settings()
        linked = {}
        for g in gamelib.all_games():
            p = (g.get("rpg") or {}).get("project")
            if p:
                linked.setdefault(os.path.normcase(p), []).append({"id": g["id"], "title": g["title"]})
        projects = rpgmaker.find_projects(rpgmaker.search_folders(st["folders"]))
        for p in projects:
            p["linked"] = linked.get(os.path.normcase(p["path"]), [])
        return {"installs": rpgmaker.find_installs(st["exe"]), "projects": projects, "running": rpgmaker.editor_running(),
                "searched": rpgmaker.search_folders(st["folders"]), **st}

    def game_image_path(item):
        im = item["images"][item["pick"]] if item.get("images") else None
        if not im:
            return None
        out = os.path.abspath(folder_paths.get_output_directory())
        path = os.path.abspath(os.path.join(out, im.get("subfolder") or "", im["filename"]))
        return path if path.startswith(out + os.sep) and os.path.isfile(path) else None

    @PromptServer.instance.routes.get("/lora-lab/rpg/status")
    async def lora_lab_rpg_status(request):
        return web.json_response(await asyncio.to_thread(rpg_status))

    @PromptServer.instance.routes.post("/lora-lab/rpg/settings")
    async def lora_lab_rpg_settings(request):
        body = await request.json()
        st = rpg_settings()
        if "folders" in body:
            st["folders"] = [os.path.normpath(str(x).strip().strip('"')) for x in body.get("folders") or [] if str(x).strip()][:20]
            missing = [x for x in st["folders"] if not os.path.isdir(x)]
            if missing:
                return web.json_response({"error": "Folder not found: " + missing[0]}, status=400)
        if "exe" in body:
            st["exe"] = str(body.get("exe") or "").strip().strip('"')
            if st["exe"] and not os.path.isfile(st["exe"]):
                return web.json_response({"error": "File not found: " + st["exe"]}, status=400)
        with open(rpg_settings_path, "w", encoding="utf-8") as f:
            json.dump(st, f, indent=1)
        return web.json_response(await asyncio.to_thread(rpg_status))

    @PromptServer.instance.routes.post("/lora-lab/rpg/link")
    async def lora_lab_rpg_link(request):
        body = await request.json()
        project = str(body.get("project") or "").strip().strip('"')
        if project and not rpgmaker.project_engine(project):
            return web.json_response({"error": "That folder isn't an RPG Maker MV or MZ project"}, status=400)
        game = gamelib.get(str(body.get("id", "")))
        if not game:
            return web.json_response({"error": "Unknown game"}, status=404)
        rpg = {"project": os.path.normpath(project), "engine": rpgmaker.project_engine(project)} if project else {}
        if rpg and os.path.normcase(rpg["project"]) == os.path.normcase((game.get("rpg") or {}).get("project", "")):
            rpg = dict(game["rpg"], **rpg)   # same project: keep when it was last built
        return web.json_response(gamelib.set_rpg(game["id"], rpg))

    @PromptServer.instance.routes.post("/lora-lab/rpg/build")
    async def lora_lab_rpg_build(request):
        body = await request.json()
        game = gamelib.get(str(body.get("id", "")))
        if not game:
            return web.json_response({"error": "Unknown game"}, status=404)
        project = (game.get("rpg") or {}).get("project")
        if not project:
            return web.json_response({"error": "Link an RPG Maker project to this game first"}, status=400)
        try:
            out = await asyncio.to_thread(rpgmaker.build, game, project, game_image_path)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            logging.exception("[Kobo] RPG Maker build failed")
            return web.json_response({"error": str(e)}, status=500)
        game = gamelib.set_rpg(game["id"], dict(game["rpg"], built=int(time.time() * 1000), maps=out["mapIds"], engine=out["engine"]))
        return web.json_response({"result": out, "game": game})

    @PromptServer.instance.routes.post("/lora-lab/rpg/open")
    async def lora_lab_rpg_open(request):
        body = await request.json()
        project = str(body.get("project") or "")
        try:
            await asyncio.to_thread(rpgmaker.open_project, project, rpgmaker.find_installs(rpg_settings()["exe"]))
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({"ok": True})

    novellib = _load("novellib")

    @PromptServer.instance.routes.get("/lora-lab/novels")
    async def lora_lab_novels(request):
        return web.json_response(novellib.list_novels(request.rel_url.query.get("workspace", "")))

    @PromptServer.instance.routes.get("/lora-lab/novel")
    async def lora_lab_novel_get(request):
        novel = novellib.get(request.rel_url.query.get("id", ""))
        return web.json_response(novel) if novel else web.json_response({"error": "Unknown novel"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/novel")
    async def lora_lab_novel_save(request):
        try:
            return web.json_response(novellib.upsert(await request.json()))
        except Exception as e:
            logging.exception("[Kobo] saving novel failed")
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/lora-lab/novel/delete")
    async def lora_lab_novel_delete(request):
        body = await request.json()
        return web.json_response({"deleted": novellib.delete(str(body.get("id", "")))})

    # Only a novel made in the Adult or Story workspace is written without the safe-for-work rule.
    @PromptServer.instance.routes.post("/lora-lab/novel/outline")
    async def lora_lab_novel_outline(request):
        body = await request.json()
        novel = body.get("novel") or {}
        try:
            out = await llm.write_novel_outline(novel, body.get("model") or llm.DEFAULT_MODEL, _free_comfy_vram, sfw=novel.get("workspace") != "adult")
        except Exception as e:
            logging.exception("[Kobo] novel outline failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response(out)

    mangalib = _load("mangalib")

    @PromptServer.instance.routes.get("/lora-lab/mangas")
    async def lora_lab_mangas(request):
        return web.json_response(mangalib.list_mangas(request.rel_url.query.get("workspace", "")))

    @PromptServer.instance.routes.get("/lora-lab/manga")
    async def lora_lab_manga_get(request):
        manga = mangalib.get(request.rel_url.query.get("id", ""))
        return web.json_response(manga) if manga else web.json_response({"error": "Unknown manga"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/manga")
    async def lora_lab_manga_save(request):
        try:
            return web.json_response(mangalib.upsert(await request.json()))
        except Exception as e:
            logging.exception("[Kobo] saving manga failed")
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/lora-lab/manga/delete")
    async def lora_lab_manga_delete(request):
        body = await request.json()
        return web.json_response({"deleted": mangalib.delete(str(body.get("id", "")))})

    # Only a manga made in the Adult or Story workspace is written without the safe-for-work rule.
    @PromptServer.instance.routes.post("/lora-lab/manga/outline")
    async def lora_lab_manga_outline(request):
        body = await request.json()
        manga = body.get("manga") or {}
        try:
            out = await llm.write_manga_outline(manga, body.get("model") or llm.DEFAULT_MODEL, _free_comfy_vram, sfw=manga.get("workspace") != "adult")
        except Exception as e:
            logging.exception("[Kobo] manga plan failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response(out)

    @PromptServer.instance.routes.post("/lora-lab/manga/page")
    async def lora_lab_manga_page(request):
        body = await request.json()
        manga = body.get("manga") or {}
        try:
            out = await llm.write_manga_page(manga, int(body.get("index", -1)), body.get("model") or llm.DEFAULT_MODEL, _free_comfy_vram,
                                             sfw=manga.get("workspace") != "adult")
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            logging.exception("[Kobo] manga page failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response(out)

    @PromptServer.instance.routes.post("/lora-lab/manga/image")
    async def lora_lab_manga_image(request):
        body = await request.json()
        panel = mangalib.add_image(str(body.get("id", "")), str(body.get("key", "")), body.get("image"), body.get("seed", 0))
        return web.json_response(panel) if panel else web.json_response({"error": "Unknown manga or panel"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/manga/drop")
    async def lora_lab_manga_drop(request):
        body = await request.json()
        try:
            index = int(body.get("index", -1))
        except (TypeError, ValueError):
            index = -1
        panel = mangalib.drop_image(str(body.get("id", "")), str(body.get("key", "")), index)
        return web.json_response(panel) if panel else web.json_response({"error": "Unknown manga or panel"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/novel/chapter")
    async def lora_lab_novel_chapter(request):
        body = await request.json()
        novel = body.get("novel") or {}
        try:
            out = await llm.write_novel_chapter(novel, int(body.get("index", -1)), body.get("model") or llm.DEFAULT_MODEL, _free_comfy_vram,
                                                sfw=novel.get("workspace") != "adult")
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            logging.exception("[Kobo] novel chapter failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response(out)

    chatlib = _load("chatlib")

    _chat_busy, _learn_busy = set(), set()   # (character, chat) being replied to; characters whose memory is being written

    def _chat_own(c):
        return next((x for x in charlib.load()["characters"] if x["id"] == c.get("charId")), None) if c.get("charId") else None

    @PromptServer.instance.routes.get("/lora-lab/chat/characters")
    async def lora_lab_chat_characters(request):
        return web.json_response(chatlib.list_characters(request.rel_url.query.get("workspace", "")))

    @PromptServer.instance.routes.get("/lora-lab/chat/character")
    async def lora_lab_chat_character(request):
        c = chatlib.get(request.rel_url.query.get("id", ""))
        return web.json_response(dict(c, pending=chatlib.pending(c))) if c else web.json_response({"error": "Unknown character"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/chat/character")
    async def lora_lab_chat_character_save(request):
        try:
            c = chatlib.save(await request.json())
        except Exception as e:
            logging.exception("[Kobo] saving chat character failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response(dict(c, pending=chatlib.pending(c)))

    @PromptServer.instance.routes.post("/lora-lab/chat/character/delete")
    async def lora_lab_chat_character_delete(request):
        body = await request.json()
        return web.json_response({"deleted": chatlib.delete(str(body.get("id", "")))})

    @PromptServer.instance.routes.post("/lora-lab/chat/new")
    async def lora_lab_chat_new(request):
        chat = chatlib.new_chat(str((await request.json()).get("id", "")))
        return web.json_response(chat) if chat else web.json_response({"error": "Unknown character"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/chat/edit")
    async def lora_lab_chat_edit(request):
        body = await request.json()
        ok = chatlib.edit_chat(str(body.get("id", "")), str(body.get("chat", "")), body.get("title"), bool(body.get("delete")))
        return web.json_response({"ok": True}) if ok else web.json_response({"error": "Unknown chat"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/chat/cut")
    async def lora_lab_chat_cut(request):
        body = await request.json()
        if (str(body.get("id", "")), str(body.get("chat", ""))) in _chat_busy:
            return web.json_response({"error": "Still replying; wait for the reply or press ⏹ Stop"}, status=409)
        c, chat = chatlib.cut(str(body.get("id", "")), str(body.get("chat", "")), int(body.get("keep", 0)))
        return web.json_response({"messages": chat["messages"]}) if chat else web.json_response({"error": "Unknown chat"}, status=404)

    # The reply is streamed as lines of JSON: {"t": text} pieces, then {"done", "message", "pending"} (or {"error"}).
    # Stop (the page drops the request) or closing the page keeps what was written so far.
    @PromptServer.instance.routes.post("/lora-lab/chat/send")
    async def lora_lab_chat_send(request):
        body = await request.json()
        cid, chat_id, text = str(body.get("id", "")), str(body.get("chat", "")), str(body.get("text") or "").strip()
        key = (cid, chat_id)
        if key in _chat_busy:
            return web.json_response({"error": "Still replying to the last message"}, status=409)
        _chat_busy.add(key)   # claim it before any await, so a double click can't start two replies
        if text:
            c, chat = chatlib.add_message(cid, chat_id, "user", text)
        else:   # no text: the character talks (first message, retry, or "go on")
            c = chatlib.get(cid)
            chat = c and chatlib._chat(c, chat_id)
        if not chat:
            _chat_busy.discard(key)
            return web.json_response({"error": "Unknown chat"}, status=404)
        resp = web.StreamResponse(headers={"Content-Type": "application/x-ndjson", "Cache-Control": "no-cache"})
        try:
            await resp.prepare(request)
        except BaseException:
            _chat_busy.discard(key)
            raise
        reply, error, gone, saved = "", "", False, None
        try:
            async for piece in llm.chat_reply(c, _chat_own(c), chat["messages"], body.get("model") or llm.DEFAULT_MODEL, _free_comfy_vram,
                                              sfw=c["workspace"] != "adult"):
                reply += piece
                try:
                    await resp.write((json.dumps({"t": piece}) + "\n").encode())
                except ConnectionError:
                    gone = True
                    break
        except Exception as e:
            logging.exception("[Kobo] chat reply failed")
            error = str(e)
        finally:
            _chat_busy.discard(key)
            if reply.strip():
                c, saved = chatlib.add_message(cid, chat_id, "char", reply)
        if reply.strip() and c is None:   # the chat or character was deleted while it replied
            error, saved = error or "This chat was deleted while replying", None
        if not gone:
            out = {"error": error} if (error and not saved) or c is None else {"done": True, "message": saved and saved["messages"][-1],
                                                                "count": saved and len(saved["messages"]), "pending": chatlib.pending(c)}
            try:
                await resp.write((json.dumps(out) + "\n").encode())
                await resp.write_eof()
            except ConnectionError:
                pass
        return resp

    # Fold every message not learned from yet (in all of the character's chats) into what they remember.
    @PromptServer.instance.routes.post("/lora-lab/chat/learn")
    async def lora_lab_chat_learn(request):
        body = await request.json()
        c = chatlib.get(str(body.get("id", "")))
        if not c:
            return web.json_response({"error": "Unknown character"}, status=404)
        if c["id"] in _learn_busy:
            return web.json_response({"error": "Already learning from the chats"}, status=409)
        todo = chatlib.unlearned(c)
        if not todo:
            return web.json_response({"learned": c["learned"], "pending": 0})
        cid = c["id"]
        _learn_busy.add(cid)
        try:
            messages = [m for _, _, ms in todo for m in ms]
            learned = await llm.learn_from_chat(c, _chat_own(c), messages, body.get("model") or llm.DEFAULT_MODEL, _free_comfy_vram,
                                                sfw=c["workspace"] != "adult")
            c = chatlib.set_learned(cid, learned, {chat_id: start + len(ms) for chat_id, start, ms in todo})
        except Exception as e:
            logging.exception("[Kobo] chat learning failed")
            return web.json_response({"error": str(e)}, status=500)
        finally:
            _learn_busy.discard(cid)
        if not c:
            return web.json_response({"error": "Unknown character"}, status=404)
        return web.json_response({"learned": c["learned"], "pending": chatlib.pending(c)})

    # Picture story: the writer retells a chat as scenes (a caption and a picture idea each); the page writes the
    # prompts and draws them like a story, and each finished image is added here.
    @PromptServer.instance.routes.post("/lora-lab/chat/story/plan")
    async def lora_lab_chat_story_plan(request):
        body = await request.json()
        c = chatlib.get(str(body.get("id", "")))
        chat = c and chatlib._chat(c, str(body.get("chat", "")))
        if not chat:
            return web.json_response({"error": "Unknown chat"}, status=404)
        if len(chat["messages"]) < 2:
            return web.json_response({"error": "Chat a little first: there is nothing to tell yet"}, status=400)
        try:
            scenes = max(1, min(30, int(body.get("scenes") or 6)))
            plan = await llm.plan_chat_story(c, _chat_own(c), chat["messages"], scenes, body.get("model") or llm.DEFAULT_MODEL,
                                             _free_comfy_vram, sfw=c["workspace"] != "adult")
        except Exception as e:
            logging.exception("[Kobo] chat story plan failed")
            return web.json_response({"error": str(e)}, status=500)
        story = chatlib.set_story(c["id"], chat["id"], plan["looks"], plan["scenes"], body.get("style"))
        return web.json_response(story) if story else web.json_response({"error": "Unknown chat"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/llm/unload")
    async def lora_lab_llm_unload(request):
        try:
            return web.json_response({"unloaded": await llm.unload_models()})
        except (aiohttp.ClientError, asyncio.TimeoutError):
            return web.json_response({"unloaded": []})

    @PromptServer.instance.routes.post("/lora-lab/chat/story/save")
    async def lora_lab_chat_story_save(request):
        body = await request.json()
        story = chatlib.save_story(str(body.get("id", "")), str(body.get("chat", "")), body)
        return web.json_response(story) if story else web.json_response({"error": "Unknown chat"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/chat/story/image")
    async def lora_lab_chat_story_image(request):
        body = await request.json()
        scene = chatlib.add_story_image(str(body.get("id", "")), str(body.get("chat", "")), str(body.get("key", "")), body.get("image"), body.get("seed", 0))
        return web.json_response(scene) if scene else web.json_response({"error": "Unknown chat or scene"}, status=404)

    @PromptServer.instance.routes.post("/lora-lab/chat/story/drop")
    async def lora_lab_chat_story_drop(request):
        body = await request.json()
        try:
            index = int(body.get("index", -1))
        except (TypeError, ValueError):
            index = -1
        scene = chatlib.drop_story_image(str(body.get("id", "")), str(body.get("chat", "")), str(body.get("key", "")), index)
        return web.json_response(scene) if scene else web.json_response({"error": "Unknown chat or scene"}, status=404)

    ckptinfo = _load("ckptinfo")

    @PromptServer.instance.routes.get("/lora-lab/checkpoint-families")
    async def lora_lab_ckpt_families(request):
        families = await asyncio.get_running_loop().run_in_executor(None, ckptinfo.families)
        return web.json_response({"families": families})

    loraflags = _load("loraflags")

    @PromptServer.instance.routes.get("/lora-lab/lora-flags")
    async def lora_lab_flags_get(request):
        return web.json_response(loraflags.load())

    @PromptServer.instance.routes.post("/lora-lab/lora-flags")
    async def lora_lab_flags_set(request):
        try:
            body = await request.json()
            if "word" in body:
                return web.json_response(loraflags.set_word(body.get("name"), body.get("word")))
            return web.json_response(loraflags.set_flag(body.get("name"), body.get("flag")))
        except Exception as e:
            return web.json_response({"error": str(e)}, status=400)

    loramerge = _load("loramerge")

    # Merge: the ticked LoRAs at their strengths -> one new LoRA file in models/loras (loramerge.py).
    @PromptServer.instance.routes.post("/lora-lab/loras/merge")
    async def lora_lab_loras_merge(request):
        try:
            body = await request.json()
            name = await asyncio.get_running_loop().run_in_executor(None, loramerge.merge, body.get("loras"), body.get("name"))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:
            logging.exception("[Kobo] LoRA merge failed")
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"name": name})

    tagfinder = _load("tagfinder")

    # The General workspace sends sfw=1: safe ratings only and no adult-only sites, whatever else the page asks for.
    def _tf_rating(q):
        return "general" if q.get("sfw") == "1" or q.get("rating") not in tagfinder.RATINGS else q["rating"]

    def _tf_sites(q):
        return {n: s for n, s in tagfinder.available_sites().items() if not (q.get("sfw") == "1" and s.adult)}

    @PromptServer.instance.routes.get("/lora-lab/tagfinder/sites")
    async def lora_lab_tf_sites(request):
        usable = await asyncio.get_running_loop().run_in_executor(None, _tf_sites, request.query)
        return web.json_response([{"name": n, "label": tagfinder.SITE_INFO[n]["label"], "default": tagfinder.SITE_INFO[n]["default"]}
                                  for n in usable])

    @PromptServer.instance.routes.get("/lora-lab/tagfinder/similar")
    async def lora_lab_tf_similar(request):
        q = request.query
        tag = q.get("tag", "").strip()
        if not tag:
            return web.json_response({"error": "Type a tag first"}, status=400)
        usable = _tf_sites(q)
        names = [s for s in q.get("sites", "").split(",") if s in usable] or tagfinder.default_sites(usable)
        try:
            info, results = await asyncio.get_running_loop().run_in_executor(None, lambda: tagfinder.find_similar_tags(
                tag, sites=names, limit=max(1, min(int(q.get("limit", 40)), 200)), rating=_tf_rating(q),
                categories=q.get("category", "general").split(",")))
        except (tagfinder.SiteError, ValueError) as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({**info, "similar_tags": results})

    @PromptServer.instance.routes.get("/lora-lab/tagfinder/posts")
    async def lora_lab_tf_posts(request):
        q = request.query
        site = _tf_sites(q).get(q.get("site", ""))
        if not site:
            return web.json_response({"error": "That site isn't available here"}, status=400)
        try:
            posts = await asyncio.get_running_loop().run_in_executor(None, lambda: site.posts(
                tagfinder.normalize(q.get("tag", "")), _tf_rating(q), page=max(1, int(q.get("page", 1)))))
        except (tagfinder.SiteError, OSError, ValueError) as e:
            return web.json_response({"error": f"{site.name}: {e}"}, status=502)
        return web.json_response(posts)

    @PromptServer.instance.routes.get("/lora-lab/tagfinder/image")
    async def lora_lab_tf_image(request):
        # Booru images load through this proxy (as in the TagFinder app); fetch_image only allows the booru hosts.
        try:
            data, content_type = await asyncio.get_running_loop().run_in_executor(None, tagfinder.fetch_image, request.query.get("url", ""))
        except tagfinder.SiteError as e:
            return web.json_response({"error": str(e)}, status=403)
        except OSError as e:
            return web.json_response({"error": str(e)}, status=502)
        return web.Response(body=data, content_type=content_type.split(";")[0], headers={"Cache-Control": "max-age=86400"})

    training = _load("training")

    def _train_route(fn):
        """Shared error handling: DatasetError is the user's to fix (400), anything else is logged (500)."""
        async def handler(request):
            try:
                return web.json_response(await fn(request))
            except training.DatasetError as e:
                return web.json_response({"error": str(e)}, status=400)
            except Exception as e:
                logging.exception("[Kobo] training route failed")
                return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=500)
        return handler

    def _run(fn, *args):
        return asyncio.get_running_loop().run_in_executor(None, fn, *args)

    @PromptServer.instance.routes.get("/lora-lab/train/datasets")
    @_train_route
    async def lora_lab_train_list(request):
        return training.list_datasets(request.query.get("workspace", "general"))

    @PromptServer.instance.routes.get("/lora-lab/train/dataset")
    @_train_route
    async def lora_lab_train_get(request):
        return training.get(request.query.get("name"))

    @PromptServer.instance.routes.post("/lora-lab/train/dataset")
    @_train_route
    async def lora_lab_train_create(request):
        body = await request.json()
        return training.create(body.get("name"), body.get("workspace"), str(body.get("trigger", ""))[:60])

    @PromptServer.instance.routes.post("/lora-lab/train/trigger")
    @_train_route
    async def lora_lab_train_trigger(request):
        body = await request.json()
        return {"trigger": training.set_trigger(body.get("name"), body.get("trigger", ""))}

    @PromptServer.instance.routes.post("/lora-lab/train/image")
    @_train_route
    async def lora_lab_train_upload(request):
        form = await request.post()
        upload = form.get("image")
        if upload is None or not hasattr(upload, "file"):
            raise training.DatasetError("No image uploaded")
        return {"file": await _run(training.add_image, form.get("name"), upload.filename, upload.file.read())}

    @PromptServer.instance.routes.post("/lora-lab/train/image/delete")
    @_train_route
    async def lora_lab_train_delete(request):
        body = await request.json()
        training.delete_image(body.get("name"), body.get("file"))
        return {"ok": True}

    @PromptServer.instance.routes.post("/lora-lab/train/caption")
    @_train_route
    async def lora_lab_train_caption(request):
        body = await request.json()
        return {"caption": training.save_caption(body.get("name"), body.get("file"), body.get("caption", ""))}

    @PromptServer.instance.routes.post("/lora-lab/train/autotag")
    @_train_route
    async def lora_lab_train_autotag(request):
        body = await request.json()
        pending = tagger.ensure_ready()   # training tags with the default taggers
        if pending:
            raise training.DatasetError(pending)
        return await _run(training.caption, body.get("name"), body.get("file"), min(0.9, max(0.2, float(body.get("threshold", 0.35)))))

    # Settings measured on this 6 GB GPU (see the Train LoRA workflows): gradient checkpointing depth 2, buckets,
    # SD1.5 at ~512x768 worth of pixels without offloading, SDXL at ~768x768 with offloading.
    TRAIN_SIZE = {"sd15": (512, 768), "sdxl": (768, 768), "anima": (768, 768)}

    @PromptServer.instance.routes.post("/lora-lab/train/prepare")
    @_train_route
    async def lora_lab_train_prepare(request):
        body = await request.json()
        name, family = body.get("dataset"), body.get("family")
        if family not in TRAIN_SIZE:
            raise training.DatasetError("Pick SD 1.5, Illustrious / Pony (SDXL) or Anima")
        if family == "anima" and not (body.get("text_encoder") and body.get("vae")):
            raise training.DatasetError("Anima needs its text encoder and VAE: pick them in the Model tab with Anima selected")
        lora = re.sub(r"[^A-Za-z0-9_-]+", "_", str(body.get("lora_name") or name)).strip("_")[:40] or "lora"
        steps, rank = max(100, min(int(body.get("steps", 1500)), 10000)), max(4, min(int(body.get("rank", 16)), 64))
        lr = max(1e-6, min(float(body.get("learning_rate", 1e-4)), 1e-2))
        if tagger.ensure_ready():
            raise training.DatasetError("The image tagger is still downloading; it checks every training image first. Try again in a few minutes.")
        count = await _run(training.validate_for_training, name)
        w, h = TRAIN_SIZE[family]
        file_prefix = f"{family}_{lora}"
        graph = {
            "1": {"class_type": "LoadImageTextDataSetFromFolder", "inputs": {"folder": f"lora-training/{name}"}},
            "2": {"class_type": "ImageResizeKJv2", "inputs": {"image": ["1", 0], "width": w, "height": h, "upscale_method": "lanczos",
                  "keep_proportion": "total_pixels", "pad_color": "0, 0, 0", "crop_position": "center", "divisible_by": 64, "device": "cpu"}},
            "3": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": body.get("checkpoint")}},
            "4": {"class_type": "MakeTrainingDataset", "inputs": {"images": ["2", 0], "vae": ["3", 2], "clip": ["3", 1], "texts": ["1", 1]}},
            "5": {"class_type": "ResolutionBucket", "inputs": {"latents": ["4", 0], "conditioning": ["4", 1]}},
            "6": {"class_type": "TrainLoraNode", "inputs": {"model": ["3", 0], "latents": ["5", 0], "positive": ["5", 1],
                  "batch_size": 1, "grad_accumulation_steps": 1, "steps": steps, "learning_rate": lr, "rank": rank,
                  "optimizer": "AdamW", "loss_function": "MSE", "seed": 0, "training_dtype": "bf16", "lora_dtype": "bf16",
                  "quantized_backward": False, "algorithm": "LoRA", "gradient_checkpointing": True, "checkpoint_depth": 2,
                  "offloading": family in ("sdxl", "anima"), "existing_lora": "[None]", "bucket_mode": True, "bypass_mode": False}},
            "7": {"class_type": "SaveLoRA", "inputs": {"lora": ["6", 0], "prefix": f"trained-loras/{file_prefix}", "steps": ["6", 2]}},
            "8": {"class_type": "LossGraphNode", "inputs": {"loss": ["6", 1], "filename_prefix": "loss_graph"}},
        }
        if family == "anima":   # no all-in-one checkpoint: diffusion model, Qwen3 text encoder and Qwen-Image VAE load separately
            graph["3"] = {"class_type": "UNETLoader", "inputs": {"unet_name": body.get("checkpoint"), "weight_dtype": "default"}}
            graph["9"] = {"class_type": "CLIPLoader", "inputs": {"clip_name": body.get("text_encoder"), "type": "stable_diffusion", "device": "default"}}
            graph["10"] = {"class_type": "VAELoader", "inputs": {"vae_name": body.get("vae")}}
            graph["4"]["inputs"].update(clip=["9", 0], vae=["10", 0])
        job = {"dataset": name, "family": family, "checkpoint": body.get("checkpoint"), "name": lora, "file_prefix": file_prefix,
               "steps": steps, "rank": rank, "images": count, "trigger": training.get(name)["trigger"]}
        return {"graph": graph, "job": job}

    @PromptServer.instance.routes.post("/lora-lab/train/from-character")
    @_train_route
    async def lora_lab_train_from_character(request):
        """Learn this character: their gallery images (minus the unticked ones) become dataset "char <name>"."""
        body = await request.json()
        c = next((x for x in charlib.load()["characters"] if x["id"] == str(body.get("id", ""))), None)
        if not c or c.get("workspace", "adult") != body.get("workspace"):
            raise training.DatasetError("Unknown character in this workspace")
        # Non-ASCII names slug to "", so fall back to the id; otherwise every such character would share one dataset.
        name = ("char " + (re.sub(r"[^A-Za-z0-9 _-]+", "", c["name"]).strip() or c["id"]))[:40].strip()
        trigger = re.sub(r"[^a-z0-9]+", "_", c["name"].lower()).strip("_") or "character"
        added = await _run(training.sync_from_gallery, name, c["workspace"], trigger, body.get("images") or [])
        return {**training.get(name), "added": added}

    @PromptServer.instance.routes.post("/lora-lab/train/jobs")
    @_train_route
    async def lora_lab_train_add_job(request):
        body = await request.json()
        job = body.get("job") or {}
        if not body.get("pid") or job.get("family") not in TRAIN_SIZE:
            raise training.DatasetError("Bad job")
        extra = {"character_id": str(body["character_id"]), "switch_engine": bool(body.get("switch_engine"))} if body.get("character_id") else {}
        training.add_job({**job, **extra, "pid": str(body["pid"]), "workspace": body.get("workspace"), "status": "running", "started": time.time()})
        return {"ok": True}

    @PromptServer.instance.routes.get("/lora-lab/train/jobs")
    @_train_route
    async def lora_lab_train_jobs(request):
        queue = PromptServer.instance.prompt_queue
        jobs = await _run(training.refresh_jobs, lambda pid: queue.get_history(prompt_id=pid).get(pid))
        return [j for j in jobs if j.get("workspace") == request.query.get("workspace", "general")]
except Exception:
    logging.exception("[Kobo] setting up the page's routes stopped early; routes after this point are missing")
