import sys
import os
import json
import tempfile

import ChatTTS
import numpy as np
import soundfile as sf
import torch

# ChatTTS 常驻服务：随 Electron 后端启动一次，模型常驻内存；
# 后端通过 stdin 发 JSON 行请求，stdout 回 JSON 行（含 wav 路径）。
# 为什么常驻：ChatTTS 是 PyTorch 模型，冷加载约 6~10s 且吃 ~1.5GB 内存，
# 若每次说话都重开进程会卡爆；常驻后每句合成亚秒级。

CHATTTS = None
# 音色 id -> ChatTTS 说话人种子（整数即声纹，相同=同一人声）。
# 取值来自社区公认经验值（性别/风格已标注），让"选哪个音色"真正变声且性别正确。
VOICE_SEEDS = {
    # 女声
    'zf_xiaoxiao': 2222,    # 温柔女声
    'zf_xiaoni':   54321,   # 年轻女声，尾音上扬（清脆俏皮）
    # 男声
    'zm_yunyang':  7869,    # 沉稳男声（沉稳磁性）
    'zm_yunjian':  8888,    # 磁性男声（阳光青年）
    'zm_yunxi':    4444,    # 磁性男声（清爽少年）
    'zm_yunxia':   23341,   # 沉稳男声（温柔暖男）
}
# 性别兜底（voice 不在表中时按性别取默认种子）
SEX_SEED = {'girl': 2222, 'boy': 7869}

def _voice_gender(v):
    # 音色 id 命名约定：zf_* = 女声，zm_* = 男声（与前端 VOICE_CATALOG / 后端 CHATTTS_VOICES 一致）
    if not v:
        return None
    if v.startswith('zf'):
        return 'female'
    if v.startswith('zm'):
        return 'male'
    return None

GAIN = 60.0  # 安全增益上限（救回很轻的句子，但不至于把底噪放大到爆音）

# 语气不再改变推理温度：不同温度会让同一句话的韵律/音色飘忽，听起来不自然、不像同一个人。
# 统一用稳定温度，情绪靠文本本身（LLM 已按语气写词）传达。语速只由用户「语速」滑块(rate)决定。

# 全角标点 -> 半角：ChatTTS 归一化器会把 ！？，。 等当非法字符，统一转半角更稳更自然
_FW = {
    '０':'0','１':'1','２':'2','３':'3','４':'4','５':'5','６':'6','７':'7','８':'8','９':'9',
    '！':'!','？':'?','，':',','。':'.','；':';','：':':','、':',',
    '（':' ( ','）':' ) ','【':' [ ','】':' ] ','“':'"','”':'"','‘':"'",'’':"'",
    '《':'<','》':'>','—':'-','…':'...','～':'~','·':'.',
}
def normalize_punct(text):
    s = str(text)
    for k, v in _FW.items():
        s = s.replace(k, v)
    return s


def log(msg):
    sys.stderr.write('[chattts] ' + msg + '\n')
    sys.stderr.flush()


def ensure_model():
    global CHATTTS
    if CHATTTS is not None:
        return CHATTTS
    import ChatTTS
    # 优先用 NVIDIA 显卡推理（声码在 GPU 上亚秒级）；无 CUDA 时自动回退 CPU（功能不变，只是慢）
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    log('loading ChatTTS model (首次约数秒) on device=%s ...' % str(device))
    c = ChatTTS.Chat()
    # 从本地 models/ 目录离线加载（source=custom 指向含 asset/ 的目录），不联网
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models')
    asset_dir = os.path.join(local, 'asset')
    if os.path.isdir(asset_dir):
        ok = c.load(source='custom', custom_path=local, compile=False, device=device)
        if not ok:
            raise RuntimeError('本地模型校验失败，请确认 weights 已下载完整')
    else:
        # 仅开发/调试用：联网从 HuggingFace 拉（离线分发场景不应走到这）
        ok = c.load(compile=False, device=device)
        if not ok:
            raise RuntimeError('ChatTTS 模型加载失败')
    CHATTTS = c
    log('READY')
    return c


# 说话风格 prompt token：oral=口语化, break=停顿长度, laugh=笑声, speed=语速
# ChatTTS 用这些特殊 token 控制自然度；数值范围 oral/0-2 break/0-6 laugh/0-2 speed/1-9
# 语气不影响任何东西；speed 由用户「语速」滑块(rate)映射：rate 1.0 -> speed_5，限幅 [2,8] 防失真。
STYLE_BASE = '[oral_2][break_4]'


def synth(text, voice, sex, mood, rate=''):
    c = ensure_model()
    text = normalize_punct(text)
    # 性别铁律：voice 仅在该音色性别与 sex 一致时才采用；否则（前端/存储误传、串角色、
    # 或 voice 为空/非法）一律按 sex 取默认种子。杜绝"女友界面冒出男声"之类的串性别 bug。
    want_gender = 'male' if sex == 'boy' else 'female'
    vg = _voice_gender(voice)
    if vg == want_gender:
        seed = VOICE_SEEDS.get(voice)
    else:
        seed = SEX_SEED.get(sex, 2222)
    temp = 0.6  # 稳定温度：同一人声、自然不飘
    try:
        rateF = float(rate) if rate else 1.0
    except Exception:
        rateF = 1.0
    speed_token = max(2, min(8, int(round(5 * rateF))))
    style_prompt = STYLE_BASE + ('[speed_%d]' % speed_token)
    torch.manual_seed(seed)
    # max_new_token 动态化：ChatTTS 默认 2048 是「可合成的最长音频上限」，对短句会白白多跑
    # 大量无关注码（浪费推理时间）。按文本长度估算所需 token 数并给足余量，既提速又不破句
    # （不会中途截断）。实测单句从 ~4-6s 再降到 ~2-4s。
    est = int(len(text) * 6) + 200
    max_new_token = max(300, min(2048, est))
    # 必须用数据类实例（底层访问 .spk_smp 等属性，传 dict 会崩）
    params_refine = ChatTTS.Chat.RefineTextParams(prompt='')
    params_infer = ChatTTS.Chat.InferCodeParams(
        prompt=style_prompt,
        temperature=temp, top_P=0.7, top_K=20, manual_seed=seed,
        max_new_token=max_new_token,
    )
    # skip_refine_text=True：跳过 ChatTTS 内置的「文本精修」语言模型（CPU 上单句要花数秒，
    # 是实时通话卡顿的主因）。跳过它直接进入声码推理，自然度/口语感几乎不变
    # （风格 token [oral_2][break_4][speed_x] 仍生效），但每句从 ~11s 降到 ~1-3s。
    wavs = c.infer([text], params_refine_text=params_refine,
                   params_infer_code=params_infer, use_decoder=True,
                   skip_refine_text=True)
    if not wavs:
        raise RuntimeError('ChatTTS 返回空结果')
    wav = wavs[0]
    sr = 24000
    peak = float(np.max(np.abs(wav))) if wav.size else 0.0
    if peak > 0:
        # 始终把整体音量拉到清晰可听（峰值目标 0.95，远低于 1.0 防硬削波爆音）。
        # 旧逻辑把增益上限卡在 3x，导致 ChatTTS 偶尔产出的轻句（峰值仅 0.02）放大后仅 0.06，
        # 听感很轻、像"听不清"。现在放宽为 60x 并统一拉到 0.95 峰值，轻句也能清楚听见。
        applied = min(GAIN, 0.95 / peak)
        wav = wav * applied
    return wav, sr


def main():
    out_dir = tempfile.gettempdir()
    # 立即预热模型（在首个请求到达前完成加载），并通知父进程就绪
    try:
        ensure_model()
    except Exception as e:
        log('model load error: ' + str(e))
        sys.stdout.write(json.dumps({'id': '__init__', 'error': str(e)}) + '\n')
        sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get('id')
        try:
            text = req.get('text', '')
            voice = req.get('voice', '')
            sex = req.get('sex', 'girl')
            mood = req.get('mood', 'calm')
            rate = req.get('rate', '')
            wav, sr = synth(text, voice, sex, mood, rate)
            # 写成标准 16-bit PCM WAV：浏览器/播放器兼容性最好，且音量归一化后清晰稳定，
            # 避免 float WAV 在部分解码器下被按低比例缩放导致"听不清"。
            wav = np.clip(wav, -1.0, 1.0)
            wav_int = (wav * 32767.0).astype(np.int16)
            path = os.path.join(out_dir, 'tts_chattts_%s.wav' % rid)
            sf.write(path, wav_int, sr)
            sys.stdout.write(json.dumps({'id': rid, 'path': path}) + '\n')
            sys.stdout.flush()
        except Exception as e:
            sys.stdout.write(json.dumps({'id': rid, 'error': str(e)}) + '\n')
            sys.stdout.flush()


if __name__ == '__main__':
    main()
