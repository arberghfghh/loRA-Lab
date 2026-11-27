# Fix face (the image viewer's button): cuts the largest face SDPose found out of the picture, then pastes the
# redrawn crop back with soft edges. The redraw itself is an ordinary KSampler pass in the page's graph.
import torch

import comfy.utils


class ASALabFaceCrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "bboxes": ("BOUNDING_BOX", {"forceInput": True}),
            "context": ("FLOAT", {"default": 2.0, "min": 1.0, "max": 6.0, "step": 0.1, "tooltip": "Crop side as a multiple of the face box: room for hair and neck."}),
            "size": ("INT", {"default": 1024, "min": 256, "max": 2048, "step": 8}),
        }}

    RETURN_TYPES = ("IMAGE", "ASA_FACE_REGION")
    RETURN_NAMES = ("face", "region")
    FUNCTION = "run"
    CATEGORY = "Kōbō/face"

    def run(self, image, bboxes, context, size):
        boxes = bboxes[0] if bboxes and isinstance(bboxes[0], list) else bboxes
        if not boxes:
            raise ValueError("No face found in this picture.")
        box = max(boxes, key=lambda b: b["width"] * b["height"])
        height, width = image.shape[1:3]
        side = min(int(max(box["width"], box["height"]) * context), width, height)
        x = min(max(box["x"] + box["width"] // 2 - side // 2, 0), width - side)
        y = min(max(box["y"] + box["height"] // 2 - side // 2, 0), height - side)
        crop = image[:1, y:y + side, x:x + side].movedim(-1, 1)
        face = comfy.utils.common_upscale(crop, size, size, "bicubic", "disabled").movedim(1, -1).clamp(0, 1)
        return (face, {"x": x, "y": y, "side": side})


class ASALabFacePaste:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "face": ("IMAGE",),
            "region": ("ASA_FACE_REGION",),
            "feather": ("FLOAT", {"default": 0.15, "min": 0.01, "max": 0.5, "step": 0.01, "tooltip": "Width of the soft edge, as a share of the crop."}),
        }}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = "Kōbō/face"

    def run(self, image, face, region, feather):
        x, y, side = region["x"], region["y"], region["side"]
        small = comfy.utils.common_upscale(face[:1].movedim(-1, 1), side, side, "area", "disabled").movedim(1, -1).to(image)
        edge = torch.linspace(0, 1, side).to(image)
        ramp = (torch.minimum(edge, 1 - edge) / feather).clamp(0, 1)
        ramp = ramp * ramp * (3 - 2 * ramp)
        mask = (ramp[None, :] * ramp[:, None])[None, :, :, None]
        out = image.clone()
        out[:, y:y + side, x:x + side] = out[:, y:y + side, x:x + side] * (1 - mask) + small * mask
        return (out,)


NODE_CLASS_MAPPINGS = {"ASALabFaceCrop": ASALabFaceCrop, "ASALabFacePaste": ASALabFacePaste}
NODE_DISPLAY_NAME_MAPPINGS = {"ASALabFaceCrop": "Kōbō: Cut out the face", "ASALabFacePaste": "Kōbō: Paste the face back"}
