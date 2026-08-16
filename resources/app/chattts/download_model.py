#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""下载 ChatTTS 官方权重到 ./models/asset/... 并校验 sha256。
使用 hf-mirror.com（HuggingFace 镜像，支持 Range 断点续传）。
下载到 .part 临时文件，校验通过后 os.replace 到最终名（同盘改名，避开 safe-delete 拦截）。
"""
import os
import sys
import hashlib
import subprocess

BASE = os.path.dirname(os.path.abspath(__file__))
OUT_ROOT = os.path.join(BASE, "models")
BASE_URL = "https://hf-mirror.com/2Noise/ChatTTS/resolve/main/asset/"

# (相对 asset/ 的路径, 期望 sha256)
FILES = [
    ("Vocos.safetensors",  "07e5561491cce41f7f90cfdb94b2ff263ff5742c3d89339db99b17ad82cc3f44"),
    ("DVAE.safetensors",   "1d0b044a8368c0513100a2eca98456b289e6be6a18b7a63be1bcaa315ea874d9"),
    ("Embed.safetensors",  "2ff0be7134934155741b643b74e32fb6bf3eec41257984459b2ed60cdb4c48b0"),
    ("Decoder.safetensors","77aa55e0a977949c4733df3c6f876fa85860d3298cba63295a7bc6901729d4e0"),
    ("gpt/config.json",    "0aaa1ecd96c49ad4f473459eb1982fa7ad79fa5de08cde2781bf6ad1f9a0c236"),
    ("gpt/model.safetensors","cd0806fd971f52f6a22c923ec64982b305e817bcc41ca83417fcf9141b984a0f"),
    ("tokenizer/special_tokens_map.json","bd0ac9d9bb1657996b5c5fbcaa7d80f8de530d01a283da97f89deae5b1b8d011"),
    ("tokenizer/tokenizer_config.json","43e9d658b554fa5ee8d8e1d763349323bfef1ed7a89c0794220ab8861387d421"),
    ("tokenizer/tokenizer.json","843838a64e121e23e774cc75874c6fe862198d9f7dd43747914633a8fd89c20e"),
]

def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def download(rel, sha):
    url = BASE_URL + rel
    final = os.path.join(OUT_ROOT, "asset", rel)
    part = final + ".part"
    os.makedirs(os.path.dirname(final), exist_ok=True)

    # 已存在且校验通过则跳过
    if os.path.exists(final) and sha256_of(final) == sha:
        print(f"[OK]   {rel} 已就绪")
        return True

    for attempt in range(1, 4):
        # 重新下载前，把可能存在的坏 .part 改名（不删除，避开 safe-delete）
        if os.path.exists(part):
            try:
                os.replace(part, part + ".bad")
            except OSError:
                pass
        print(f"[DOWN] {rel}  (尝试 {attempt}/3) ...", flush=True)
        rc = subprocess.run([
            "curl", "-L", "--fail", "--retry", "10", "--retry-delay", "3",
            "-C", "-", "--connect-timeout", "30", "--max-time", "0",
            "-o", part, url
        ]).returncode
        if rc != 0:
            print(f"[ERR]  curl 失败 rc={rc}，重试", flush=True)
            continue
        if sha256_of(part) == sha:
            os.replace(part, final)  # 同盘改名，安全
            print(f"[OK]   {rel}  校验通过", flush=True)
            return True
        else:
            print(f"[ERR]  {rel}  sha256 不匹配，重试", flush=True)
    print(f"[FAIL] {rel} 多次重试仍失败", flush=True)
    return False

def main():
    ok = True
    for rel, sha in FILES:
        if not download(rel, sha):
            ok = False
    if ok:
        print("\n[ALL DONE] 全部权重下载并校验通过")
    else:
        print("\n[INCOMPLETE] 有文件失败，请检查网络后重跑本脚本")
        sys.exit(1)

if __name__ == "__main__":
    main()
