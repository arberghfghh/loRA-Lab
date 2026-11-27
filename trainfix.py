# Anima LoRA training: ComfyUI's Anima (Cosmos) attention calls comfy_kitchen's fused RMSNorm + RoPE op, which has no
# backward, so TrainLoraNode fails with "no autograd formula was registered". While gradients are on (only during
# training; sampling runs without them) the same op is done by comfy_kitchen's own plain-PyTorch version instead.
# Same idea as ComfyUI's MiniMax VAE, which picks its op by torch.is_grad_enabled().
import logging

import torch


def install():
    try:
        import comfy_kitchen as ck
        from comfy_kitchen.backends.eager import rope as eager
    except Exception as e:   # older ComfyUI without comfy_kitchen: nothing to fix
        logging.info(f"[Kobo] Anima training fix not needed ({e})")
        return
    fused = getattr(ck, "rms_rope_split_half", None)
    if fused is None or getattr(fused, "_lora_lab", False) or not hasattr(eager, "rms_rope_split_half"):
        return

    def rms_rope_split_half(q, k, freqs_cis, q_scale, k_scale=None, epsilon=1e-6, rot_dim=0):
        if torch.is_grad_enabled() and (q.requires_grad or k.requires_grad):
            return eager.rms_rope_split_half(q, k, freqs_cis, q_scale, k_scale, epsilon, rot_dim)
        return fused(q, k, freqs_cis, q_scale, k_scale, epsilon, rot_dim)

    rms_rope_split_half._lora_lab = True
    ck.rms_rope_split_half = rms_rope_split_half
